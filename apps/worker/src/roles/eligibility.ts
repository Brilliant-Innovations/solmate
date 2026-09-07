import { randomUUID } from 'node:crypto';
import {
  addMs,
  sha256Hex,
  type AssetStatus,
  type AssetEligibility,
  type Clock,
  type EligibilityPolicy,
  type EmergencyExitRouteSnapshot,
  type JupiterQuoteClient,
  type MintAddress,
  type MintChainState,
  type PriceImpactProbe,
  type Slot,
  type SolanaCluster,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { buildEmergencySnapshot, discoverEmergencyRoute, runRouteProbes } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { BudgetExhaustedError, type BirdeyeClient } from '@sol-agent-trader/market';
import { evaluateEligibility } from '@sol-agent-trader/risk';
import { MintNotFoundError, readMintChainState, type SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';

/**
 * Worker role `eligibility` (blueprint §7, §14.6, D45; execution plan M4). For every asset due for
 * evaluation: read hard protocol state from chain (authoritative), fetch the analytics security
 * report and market overview (corroboration, market structure), probe entry impact and the exit
 * route at the policy's standard sizes through the one shared Jupiter client, discover and
 * chain-verify a provider-independent emergency route, run the deterministic engine and persist
 * the record with the derived status in one transaction.
 */

export interface EligibilityRepo {
  listAssetsForEvaluation(opts: { limit: number; reevaluateAfter: ReturnType<Clock['now']> }): Promise<{ id: Uuid; mintAddress: string; status: AssetStatus }[]>;
  recordEligibility(record: AssetEligibility, status: AssetStatus): Promise<void>;
  insertEmergencyRouteSnapshot(snapshot: EmergencyExitRouteSnapshot): Promise<void>;
}

export interface EligibilityDeps {
  rpc: SolanaRpcClient;
  birdeye: BirdeyeClient;
  /** The shared quote client (ADR-0003); null disables probes and every asset stays EVALUATING. */
  jupiter: JupiterQuoteClient | null;
  repo: EligibilityRepo;
  clock: Clock;
  logger: Logger;
  policy: EligibilityPolicy;
  cluster: SolanaCluster;
  config: {
    batchSize: number;
    /** Re-evaluate anything older than this (§7.4 periodic refresh). */
    reevaluateAfterMs: number;
  };
}

export type EligibilityStep = 'CHAIN' | 'SECURITY' | 'OVERVIEW' | 'PROBES' | 'EMERGENCY_ROUTE' | 'PERSIST';

export interface EligibilityCycleReport {
  considered: number;
  evaluated: number;
  outcomes: Record<'ELIGIBLE' | 'BLOCKED' | 'EVALUATING', number>;
  snapshots: number;
  errors: { assetId: Uuid; step: EligibilityStep; error: string }[];
  budgetExhausted: boolean;
}

export async function runEligibilityCycle(deps: EligibilityDeps): Promise<EligibilityCycleReport> {
  const now = deps.clock.now();
  const report: EligibilityCycleReport = { considered: 0, evaluated: 0, outcomes: { ELIGIBLE: 0, BLOCKED: 0, EVALUATING: 0 }, snapshots: 0, errors: [], budgetExhausted: false };
  const due = await deps.repo.listAssetsForEvaluation({ limit: deps.config.batchSize, reevaluateAfter: addMs(now, -deps.config.reevaluateAfterMs) });
  report.considered = due.length;
  const fail = (assetId: Uuid, step: EligibilityStep, err: unknown) => report.errors.push({ assetId, step, error: err instanceof Error ? err.message : String(err) });

  for (const asset of due) {
    const mint = asset.mintAddress as MintAddress;
    let chain: MintChainState;
    try {
      chain = await readMintChainState(deps.rpc, mint, deps.clock);
    } catch (err) {
      fail(asset.id, 'CHAIN', err instanceof MintNotFoundError ? 'mint account not found' : err);
      continue;
    }

    let security: TokenSecurityReport | null = null;
    try {
      security = (await deps.birdeye.security(mint)).security;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      fail(asset.id, 'SECURITY', err);
    }
    let overview: TokenOverview | null = null;
    try {
      overview = (await deps.birdeye.overview(mint)).overview;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      fail(asset.id, 'OVERVIEW', err);
    }

    // Probes need a price to size token amounts; without one the route stays unproven (fail closed).
    let probes: PriceImpactProbe[] = [];
    let settlementRouteConfirmed: boolean | null = null;
    let snapshotId: Uuid | null = null;
    if (deps.jupiter && overview?.priceUsd) {
      const target = { mintAddress: mint, decimals: chain.decimals, priceUsd: overview.priceUsd };
      try {
        const outcome = await runRouteProbes(deps.jupiter, target, deps.policy, deps.cluster, deps.clock.now());
        probes = outcome.probes;
        settlementRouteConfirmed = outcome.errors.length === 0 ? outcome.settlementRouteConfirmed : null;
        for (const e of outcome.errors) fail(asset.id, 'PROBES', e);
      } catch (err) {
        fail(asset.id, 'PROBES', err);
      }
      if (settlementRouteConfirmed) {
        try {
          const route = await discoverEmergencyRoute(deps.jupiter, target, deps.policy, deps.cluster, deps.clock.now());
          if (route) {
            // D45: the pool must exist on chain and be owned by the program the label claims.
            const pool = await deps.rpc.getAccountInfo(route.poolAddress);
            if (pool.value && pool.value.owner === route.programId) {
              const snapshot = buildEmergencySnapshot({
                id: randomUUID() as Uuid,
                assetId: asset.id,
                mintAddress: mint,
                route,
                poolStateRef: `${pool.value.owner}:${await sha256Hex(pool.value.data[0])}`,
                verifiedAtSlot: pool.context.slot as Slot,
                token2022Compatible: chain.tokenProgram === 'TOKEN' || (chain.transferHookProgram === null && !chain.nonTransferable && !chain.defaultAccountFrozen),
                now: deps.clock.now(),
              });
              await deps.repo.insertEmergencyRouteSnapshot(snapshot);
              snapshotId = snapshot.id;
              report.snapshots++;
            } else {
              fail(asset.id, 'EMERGENCY_ROUTE', `pool ${route.poolAddress} owner ${pool.value?.owner ?? 'missing'} is not ${route.programId}`);
            }
          }
        } catch (err) {
          fail(asset.id, 'EMERGENCY_ROUTE', err);
        }
      }
    }

    const result = evaluateEligibility({
      id: randomUUID() as Uuid,
      assetId: asset.id,
      chain,
      security,
      overview,
      probes,
      settlementRouteConfirmed,
      emergencyExitRouteSnapshotId: snapshotId,
      now: deps.clock.now(),
      policy: deps.policy,
    });
    try {
      await deps.repo.recordEligibility(result.record, result.outcome);
      report.evaluated++;
      report.outcomes[result.outcome]++;
    } catch (err) {
      fail(asset.id, 'PERSIST', err);
    }
  }

  deps.logger.info('eligibility_cycle', { considered: report.considered, evaluated: report.evaluated, ...report.outcomes, snapshots: report.snapshots, errors: report.errors.length, budgetExhausted: report.budgetExhausted, cu: deps.birdeye.ledger.snapshot().used });
  for (const e of report.errors) deps.logger.warn('eligibility_step_failed', { assetId: e.assetId, step: e.step, error: e.error });
  return report;
}
