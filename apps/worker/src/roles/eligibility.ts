import { randomUUID } from 'node:crypto';
import {
  addMs,
  sha256Hex,
  type AssetStatus,
  type AssetEligibility,
  type Clock,
  type EligibilityPolicy,
  type EmergencyExitRouteSnapshot,
  type FeedHealth,
  type FreshnessContract,
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
import { BudgetExhaustedError, evaluateFreshness, type BirdeyeClient } from '@sol-agent-trader/market';
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
  listAssetsForEvaluation(opts: { limit: number; reevaluateAfter: ReturnType<Clock['now']>; blockedReevaluateAfter: ReturnType<Clock['now']> }): Promise<{ id: Uuid; mintAddress: string; status: AssetStatus }[]>;
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
    /** BLOCKED assets come back on this slower cadence; only RETIRED is final. */
    blockedReevaluateAfterMs: number;
  };
  /** Feed health for the classes this role consumes (TOKEN_SECURITY, TOKEN_OVERVIEW), published from its own calls (§21.1). */
  health?: {
    contracts: readonly FreshnessContract[];
    state: EligibilityHealthState;
    upsert: (health: FeedHealth) => Promise<void>;
  };
}

export interface EligibilityHealthState {
  lastSuccess: Partial<Record<string, ReturnType<Clock['now']>>>;
  lastError: Partial<Record<string, string>>;
  lastLatencyMs: Partial<Record<string, number>>;
}
export function initialEligibilityHealthState(): EligibilityHealthState {
  return { lastSuccess: {}, lastError: {}, lastLatencyMs: {} };
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
  const due = await deps.repo.listAssetsForEvaluation({ limit: deps.config.batchSize, reevaluateAfter: addMs(now, -deps.config.reevaluateAfterMs), blockedReevaluateAfter: addMs(now, -deps.config.blockedReevaluateAfterMs) });
  report.considered = due.length;
  const fail = (assetId: Uuid, step: EligibilityStep, err: unknown) => report.errors.push({ assetId, step, error: err instanceof Error ? err.message : String(err) });
  const feedOk = (cls: string, latencyMs: number) => {
    if (!deps.health) return;
    deps.health.state.lastSuccess[cls] = deps.clock.now();
    deps.health.state.lastLatencyMs[cls] = latencyMs;
    delete deps.health.state.lastError[cls];
  };
  const feedFail = (cls: string, err: unknown) => {
    if (deps.health) deps.health.state.lastError[cls] = (err instanceof Error ? err.message : String(err)).slice(0, 512);
  };

  for (const asset of due) {
    const mint = asset.mintAddress as MintAddress;
    let chain: MintChainState;
    try {
      chain = await readMintChainState(deps.rpc, mint, deps.clock);
    } catch (err) {
      if (err instanceof MintNotFoundError) {
        // A mint account absent from chain is chain truth, not a transient error: record the hard reject and move the
        // asset to BLOCKED (re-read on the slow cadence) instead of retrying it every cycle ahead of real assets, which
        // starved the feed classes after a restart (review 2026-09-08).
        let chainSlot = 0;
        try {
          chainSlot = await deps.rpc.getSlot();
        } catch {
          // slot unknown; the read time still dates the observation
        }
        try {
          await deps.repo.recordEligibility(
            {
              id: randomUUID() as Uuid, assetId: asset.id, evaluatedAt: deps.clock.now(), policyVersion: deps.policy.version, eligible: false, hardReject: true, rejectionReasons: ['MINT_NOT_INITIALIZED'], grade: 0,
              liquidityUsd: null, volume24hUsd: null, holderCount: null, concentration: null, mintAuthority: 'UNKNOWN', freezeAuthority: 'UNKNOWN', token2022: null, securityFlags: [], transferRestrictions: [],
              jupiterRouteAvailable: false, settlementRouteConfirmed: false, priceImpactProbes: [], insiderMetrics: null, emergencyExitRouteSnapshotId: null,
              freshness: { securityProviderAt: null, chainReadAt: deps.clock.now(), chainSlot: chainSlot as Slot },
            },
            'BLOCKED',
          );
          report.evaluated++;
          report.outcomes.BLOCKED++;
          deps.logger.warn('eligibility_mint_missing', { assetId: asset.id, mint, outcome: 'BLOCKED' });
        } catch (persistErr) {
          fail(asset.id, 'PERSIST', persistErr);
        }
        continue;
      }
      fail(asset.id, 'CHAIN', err);
      continue;
    }

    let security: TokenSecurityReport | null = null;
    try {
      const res = await deps.birdeye.security(mint);
      security = res.security;
      feedOk('TOKEN_SECURITY', res.meta.latencyMs);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      feedFail('TOKEN_SECURITY', err);
      fail(asset.id, 'SECURITY', err);
    }
    let overview: TokenOverview | null = null;
    try {
      const res = await deps.birdeye.overview(mint);
      overview = res.overview;
      feedOk('TOKEN_OVERVIEW', res.meta.latencyMs);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      feedFail('TOKEN_OVERVIEW', err);
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

  if (deps.health) {
    for (const c of deps.health.contracts) {
      const health = evaluateFreshness(c, { lastSuccessAt: deps.health.state.lastSuccess[c.dataClass] ?? null, now: deps.clock.now(), latencyMs: deps.health.state.lastLatencyMs[c.dataClass] ?? null, lastError: deps.health.state.lastError[c.dataClass] ?? null });
      // Nothing was due this cycle: the row reflects the scheduler, not the provider, so it carries no effect.
      if (report.considered === 0) {
        health.effectOnEntries = 'NONE';
        health.effectOnExits = 'NONE';
        health.lastError = health.lastError ?? 'NO_DEMAND: no asset was due for evaluation this cycle';
      }
      await deps.health.upsert(health);
    }
  }
  deps.logger.info('eligibility_cycle', { considered: report.considered, evaluated: report.evaluated, ...report.outcomes, snapshots: report.snapshots, errors: report.errors.length, budgetExhausted: report.budgetExhausted, cu: deps.birdeye.ledger.snapshot().used });
  for (const e of report.errors) deps.logger.warn('eligibility_step_failed', { assetId: e.assetId, step: e.step, error: e.error });
  return report;
}
