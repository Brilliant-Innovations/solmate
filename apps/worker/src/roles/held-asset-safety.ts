import { randomUUID } from 'node:crypto';
import {
  type Bps,
  type Clock,
  type EmergencyExitRouteSnapshot,
  type HeldAssetSafety,
  type Instant,
  type JupiterQuoteClient,
  type MintAddress,
  type MintChainState,
  type PositionSafetyState,
  type PriceImpactProbe,
  type SafetyBaseline,
  type SafetyPolicy,
  type SafetyTrigger,
  type SolanaCluster,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { NoRouteError, PROBE_TAKER } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { BudgetExhaustedError, type BirdeyeClient } from '@sol-agent-trader/market';
import { baselineFromChainState, evaluateHeldAssetSafety } from '@sol-agent-trader/risk';
import { MintNotFoundError, readMintChainState, type SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';

/**
 * Worker role `held-asset-safety` (blueprint §7.5, D34, §14.6). For every open position: re-read
 * chain truth, refresh market and security corroboration, quote selling the whole position through
 * the primary route, re-verify the persisted emergency pool on chain, and record the deterministic
 * safety state. A CRITICAL_EXIT state is what the mandatory-exit classifier consumes; nothing here
 * waits for a model, and a token that has become ineligible for new entries is still evaluated for
 * how it can be sold.
 */

export interface SafetyRepo {
  listOpenPositions(limit: number): Promise<{ id: Uuid; assetId: Uuid; mint: MintAddress; quantity: HeldAssetSafety['positionQuantity']; safetyState: PositionSafetyState }[]>;
  previousSafetyBaseline(positionId: Uuid): Promise<{ baseline: SafetyBaseline; state: PositionSafetyState; evaluatedAt: Instant } | null>;
  latestEligibilityBaseline(assetId: Uuid): Promise<{ liquidityUsd: number | null; freezeAuthorityPresent: boolean; transferHook: boolean; permanentDelegate: boolean; transferFeeBps: Bps | null; top10: number | null } | null>;
  latestEmergencySnapshot(assetId: Uuid): Promise<EmergencyExitRouteSnapshot | null>;
  recordPositionSafety(evaluation: HeldAssetSafety): Promise<void>;
}

export interface SafetyDeps {
  rpc: SolanaRpcClient;
  birdeye: BirdeyeClient;
  jupiter: JupiterQuoteClient | null;
  repo: SafetyRepo;
  clock: Clock;
  logger: Logger;
  policy: SafetyPolicy;
  cluster: SolanaCluster;
  settlementMint: MintAddress;
  config: { batchSize: number };
}

export interface SafetyCycleReport {
  positions: number;
  evaluated: number;
  states: Record<PositionSafetyState, number>;
  errors: { positionId: Uuid; step: 'CHAIN' | 'SECURITY' | 'OVERVIEW' | 'SELL_PROBE' | 'EMERGENCY_POOL' | 'PERSIST'; error: string }[];
  budgetExhausted: boolean;
}

export async function runHeldAssetSafetyCycle(deps: SafetyDeps, triggers: SafetyTrigger[] = ['PERIODIC']): Promise<SafetyCycleReport> {
  const report: SafetyCycleReport = { positions: 0, evaluated: 0, states: { NORMAL: 0, DEGRADED: 0, EXIT_RECOMMENDED: 0, CRITICAL_EXIT: 0 }, errors: [], budgetExhausted: false };
  const positions = await deps.repo.listOpenPositions(deps.config.batchSize);
  report.positions = positions.length;
  const fail = (positionId: Uuid, step: SafetyCycleReport['errors'][number]['step'], err: unknown) => report.errors.push({ positionId, step, error: err instanceof Error ? err.message : String(err) });

  for (const position of positions) {
    let chain: MintChainState;
    try {
      chain = await readMintChainState(deps.rpc, position.mint, deps.clock);
    } catch (err) {
      fail(position.id, 'CHAIN', err instanceof MintNotFoundError ? 'mint account not found' : err);
      continue;
    }

    let security: TokenSecurityReport | null = null;
    let overview: TokenOverview | null = null;
    try {
      security = (await deps.birdeye.security(position.mint, 'CRITICAL')).security;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) report.budgetExhausted = true;
      else fail(position.id, 'SECURITY', err);
    }
    try {
      overview = (await deps.birdeye.overview(position.mint, 'CRITICAL')).overview;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) report.budgetExhausted = true;
      else fail(position.id, 'OVERVIEW', err);
    }

    // Primary exit: quote the whole position through the shared Jupiter client.
    let primarySellProbe: PriceImpactProbe | null = null;
    if (deps.jupiter) {
      const now = deps.clock.now();
      const sizeUsd = overview?.priceUsd ? (Number(position.quantity) / 10 ** chain.decimals) * overview.priceUsd : 0;
      try {
        const { quote } = await deps.jupiter.quote({ inputMint: position.mint, outputMint: deps.settlementMint, inputAmount: position.quantity, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster: deps.cluster, requestedAt: now });
        primarySellProbe = { sizeUsd, inputAmount: position.quantity, impactBps: quote.priceImpactBps, routeFound: true, probedAt: now };
      } catch (err) {
        if (err instanceof NoRouteError) primarySellProbe = { sizeUsd, inputAmount: position.quantity, impactBps: null, routeFound: false, probedAt: now };
        else fail(position.id, 'SELL_PROBE', err);
      }
    }

    // Emergency exit: the persisted pool must still exist and still be owned by its program.
    const emergencySnapshot = await deps.repo.latestEmergencySnapshot(position.assetId);
    let emergencyPoolVerified: boolean | null = null;
    if (emergencySnapshot) {
      const hop = emergencySnapshot.hops[0];
      try {
        const pool = hop ? await deps.rpc.getAccountInfo(hop.poolAddress) : null;
        emergencyPoolVerified = pool?.value !== null && pool?.value !== undefined && hop !== undefined && pool.value.owner === hop.programId;
      } catch (err) {
        emergencyPoolVerified = null;
        fail(position.id, 'EMERGENCY_POOL', err);
      }
    }

    // Baseline: the previous evaluation, else what eligibility saw at entry, else this read (first sighting).
    const previous = await deps.repo.previousSafetyBaseline(position.id);
    let baseline: SafetyBaseline;
    if (previous) baseline = previous.baseline;
    else {
      const entry = await deps.repo.latestEligibilityBaseline(position.assetId);
      baseline = entry
        ? { source: 'ENTRY_ELIGIBILITY', ...entry, emergencyPoolAddress: emergencySnapshot?.hops[0]?.poolAddress ?? null }
        : baselineFromChainState(chain, overview?.liquidityUsd ?? null, emergencySnapshot?.hops[0]?.poolAddress ?? null, 'ENTRY_ELIGIBILITY');
    }

    const evaluation = evaluateHeldAssetSafety({
      id: randomUUID() as Uuid,
      positionId: position.id,
      assetId: position.assetId,
      positionQuantity: position.quantity,
      previousState: previous?.state ?? position.safetyState,
      baseline,
      chain,
      primarySellProbe,
      emergencySnapshot,
      emergencyPoolVerified,
      overview,
      security,
      triggers,
      now: deps.clock.now(),
      policy: deps.policy,
    });
    try {
      await deps.repo.recordPositionSafety(evaluation);
      report.evaluated++;
      report.states[evaluation.state]++;
      if (evaluation.state !== (previous?.state ?? position.safetyState)) {
        deps.logger.warn('position_safety_changed', { positionId: position.id, assetId: position.assetId, from: previous?.state ?? position.safetyState, to: evaluation.state, reasons: evaluation.reasons, canReduceNow: evaluation.exitCompatibility.canReduceNow });
      }
    } catch (err) {
      fail(position.id, 'PERSIST', err);
    }
  }

  deps.logger.info('held_asset_safety_cycle', { positions: report.positions, evaluated: report.evaluated, ...report.states, errors: report.errors.length, budgetExhausted: report.budgetExhausted });
  for (const e of report.errors) deps.logger.warn('held_asset_safety_step_failed', { positionId: e.positionId, step: e.step, error: e.error });
  return report;
}
