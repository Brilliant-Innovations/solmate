import { addAmounts, amountToBigInt, bigIntToAmount, compareAmounts, instantToMs, mulDiv, subAmounts, type Amount, type Bps, type Instant, type MintAddress, type RiskEvaluation, type RiskPolicy, type RiskReason, type Uuid } from '@sol-agent-trader/contracts';
import type { EntryGateVerdict } from '../policy/eligibility-gate.js';
import { computePositionSize, type SizingResult } from '../sizing/size.js';
import { stopLevel } from '../exits/policy.js';

/**
 * Deterministic entry evaluation (blueprint §13.1 portfolio rules, §13.2 trade-level rules,
 * §13.6 kill conditions; §31 "risk sizing deterministic"; INV-02, INV-03; ADR-0009 P1). A pure
 * function from stored state and a proposal to an immutable RiskEvaluation record. Every refusal
 * carries reason codes; a refusal never silently sizes to something smaller. Kill conditions
 * refuse new entries outright and are evaluated first, before any sizing.
 */

export interface PortfolioState {
  settlementMint: MintAddress;
  settlementDecimals: number;
  equityBaseUnits: Amount;
  /** Aggregate non-settlement exposure already held (§13.1). */
  exposureBaseUnits: Amount;
  /** Exposure authorized/submitted/provisional/reorg-pending but not yet reconciled (P1: counted as spent). */
  pendingExposureBaseUnits: Amount;
  inFlightExposureIncreasing: number;
  openPositions: number;
  assetExposureBaseUnits: Amount;
  settlementAvailableBaseUnits: Amount;
  gasReserveLamports: Amount;
  sleeve: { id: Uuid; active: boolean; capRemainingBaseUnits: Amount; riskRemainingBaseUnits: Amount } | null;
  cohort: { id: string; usedFraction: number } | null;
  cluster: { id: string; usedFraction: number } | null;
  drawdown: { dailyFraction: number; rollingFraction: number; consecutiveLosses: number; circuitBreakerTripped: boolean; breakerTrippedAt: Instant | null };
  health: {
    feedsBlockEntries: boolean;
    staleDataClasses: { dataClass: string; ageMs: number | null; limitMs: number }[];
    reconciliationClean: boolean;
    dbAvailable: boolean;
    executionAnomalies: number;
    providerAuthFailure: boolean;
    clockDriftMs: number;
    operatorKill: boolean;
    /** The runtime session permits new entries (D60: running, not paused, authority above OBSERVE). */
    sessionAllowsEntries: boolean;
  };
}

export interface EntryProposal {
  id: Uuid;
  proposalId: Uuid;
  actionCycleId: Uuid;
  assetId: Uuid;
  eligibility: EntryGateVerdict;
  eligibilityEvaluationId: Uuid | null;
  proposalExpiresAt: Instant;
  /** Price at proposal time (settlement per token) and the executable quote now. */
  proposalPriceUsd: number;
  quote: { ageMs: number; impactBps: Bps | null; slippageBps: Bps; priceUsd: number } | null;
  token2022Compatible: boolean;
  duplicateIntent: boolean;
  liquidityUsd: number | null;
  atrPct: number | null;
  structureLowPriceUsd: number | null;
  /** Expected reward as a fraction of entry (target distance); null = the policy's R multiple decides. */
  expectedRewardFraction: number | null;
}

export interface EntryEvaluation {
  record: RiskEvaluation;
  sizing: SizingResult | null;
  stopDistanceFraction: number | null;
}

const usdToBase = (usd: number, decimals: number): Amount => (usd > 0 && Number.isFinite(usd) ? (BigInt(Math.floor(usd * 10 ** Math.min(decimals, 9))) * 10n ** BigInt(Math.max(0, decimals - 9))).toString() as Amount : ('0' as Amount));
const capRemaining = (equity: Amount, used: number, cap: number): Amount => {
  const remaining = Math.max(0, cap - used);
  return mulDiv(equity, BigInt(Math.round(remaining * 1_000_000)), 1_000_000n, 'FLOOR');
};

export function evaluateEntry(policy: RiskPolicy, state: PortfolioState, proposal: EntryProposal, now: Instant): EntryEvaluation {
  const reasons = new Set<RiskReason>();

  // --- §13.6 kill conditions: new entries pause outright ----------------------------------------
  if (state.health.operatorKill) reasons.add('OPERATOR_KILL');
  if (!state.health.sessionAllowsEntries) reasons.add('SESSION_NOT_ACTIVE');
  if (!state.health.reconciliationClean) reasons.add('CUSTODY_MISMATCH');
  if (state.health.feedsBlockEntries) reasons.add('FEEDS_STALE');
  if (!state.health.dbAvailable) reasons.add('DB_UNAVAILABLE');
  if (state.health.executionAnomalies > policy.maxExecutionAnomalies) reasons.add('EXECUTION_ANOMALIES');
  if (state.health.providerAuthFailure) reasons.add('PROVIDER_AUTH_FAILURE');
  if (Math.abs(state.health.clockDriftMs) > policy.maxClockDriftMs) reasons.add('CLOCK_DRIFT');
  if (state.drawdown.dailyFraction >= policy.maxDailyDrawdownFraction || state.drawdown.rollingFraction >= policy.maxRollingDrawdownFraction) reasons.add('DRAWDOWN_LIMIT');
  const breakerActive = state.drawdown.circuitBreakerTripped || state.drawdown.consecutiveLosses >= policy.maxConsecutiveLosses;
  const inCooldown = state.drawdown.breakerTrippedAt !== null && instantToMs(now) - instantToMs(state.drawdown.breakerTrippedAt) < policy.cooldownAfterBreakerMs;
  if (breakerActive || inCooldown) reasons.add('CIRCUIT_BREAKER');

  // --- §13.1 portfolio rules --------------------------------------------------------------------
  if (state.inFlightExposureIncreasing >= policy.maxInFlightExposureIncreasing) reasons.add('EXPOSURE_IN_FLIGHT');
  if (state.openPositions >= policy.maxOpenPositions) reasons.add('MAX_POSITIONS');
  if (state.sleeve && !state.sleeve.active) reasons.add('SLEEVE_INACTIVE');
  if (compareAmounts(state.gasReserveLamports, policy.minGasReserveLamports) < 0) reasons.add('GAS_RESERVE');
  const committed = addAmounts(state.exposureBaseUnits, state.pendingExposureBaseUnits);
  const totalCap = mulDiv(state.equityBaseUnits, BigInt(Math.round(policy.maxTotalExposureFraction * 1_000_000)), 1_000_000n, 'FLOOR');
  const totalRemaining = compareAmounts(totalCap, committed) > 0 ? subAmounts(totalCap, committed) : ('0' as Amount);
  const tokenCap = mulDiv(state.equityBaseUnits, BigInt(Math.round(policy.maxExposurePerTokenFraction * 1_000_000)), 1_000_000n, 'FLOOR');
  const tokenRemaining = compareAmounts(tokenCap, state.assetExposureBaseUnits) > 0 ? subAmounts(tokenCap, state.assetExposureBaseUnits) : ('0' as Amount);
  const reserveHeadroom = compareAmounts(state.settlementAvailableBaseUnits, policy.minSettlementReserveBaseUnits) > 0 ? subAmounts(state.settlementAvailableBaseUnits, policy.minSettlementReserveBaseUnits) : ('0' as Amount);
  const availableCapital = compareAmounts(reserveHeadroom, state.pendingExposureBaseUnits) > 0 ? subAmounts(reserveHeadroom, state.pendingExposureBaseUnits) : ('0' as Amount);
  if (amountToBigInt(availableCapital) === 0n) reasons.add('SETTLEMENT_RESERVE');

  // --- §13.2 trade-level rules ------------------------------------------------------------------
  if (!proposal.eligibility.allowed) reasons.add('NOT_ELIGIBLE');
  if (instantToMs(now) >= instantToMs(proposal.proposalExpiresAt)) reasons.add('PROPOSAL_EXPIRED');
  const staleChecks = state.health.staleDataClasses.map((s) => ({ dataClass: s.dataClass, fresh: s.ageMs !== null && s.ageMs <= s.limitMs, ageMs: s.ageMs, limitMs: s.limitMs }));
  if (staleChecks.some((c) => !c.fresh)) reasons.add('DATA_STALE');
  if (!proposal.quote) reasons.add('QUOTE_MISSING');
  else {
    if (proposal.quote.ageMs > policy.maxQuoteAgeMs) reasons.add('QUOTE_STALE');
    if (proposal.quote.impactBps === null || proposal.quote.impactBps > policy.maxImpactBps) reasons.add('IMPACT_ABOVE_MAX');
    if (proposal.quote.slippageBps > policy.maxSlippageBps) reasons.add('SLIPPAGE_ABOVE_MAX');
    if (proposal.proposalPriceUsd > 0) {
      const moveBps = ((proposal.quote.priceUsd - proposal.proposalPriceUsd) / proposal.proposalPriceUsd) * 10_000;
      if (moveBps > policy.chaseToleranceBps) reasons.add('CHASE_EXCEEDED');
    }
  }
  if (!proposal.token2022Compatible) reasons.add('TOKEN2022_INCOMPATIBLE');
  if (proposal.duplicateIntent) reasons.add('DUPLICATE_INTENT');

  // --- stop (§13.4) and reward-to-risk (§13.2) --------------------------------------------------
  const entryPrice = proposal.quote?.priceUsd ?? proposal.proposalPriceUsd;
  const stop = stopLevel(policy.stop, { entryPrice, atrPct: proposal.atrPct, structureLowPrice: proposal.structureLowPriceUsd });
  const stopDistanceFraction = stop === null ? null : stop.distanceFraction;
  if (stopDistanceFraction === null || !(stopDistanceFraction > 0)) reasons.add('STOP_UNDEFINED');
  else {
    const reward = proposal.expectedRewardFraction ?? policy.takeProfit.targetRMultiple * stopDistanceFraction;
    if (reward / stopDistanceFraction < policy.minRewardToRiskRatio) reasons.add('REWARD_RISK_BELOW_MIN');
  }

  // --- §13.3 sizing over every cap ---------------------------------------------------------------
  let sizing: SizingResult | null = null;
  if (stopDistanceFraction !== null && stopDistanceFraction > 0) {
    sizing = computePositionSize({
      policy,
      equityBaseUnits: state.equityBaseUnits,
      stopDistanceFraction,
      sleeve: state.sleeve ? { capRemainingBaseUnits: state.sleeve.capRemainingBaseUnits, riskRemainingBaseUnits: state.sleeve.riskRemainingBaseUnits } : null,
      cohortRemainingBaseUnits: state.cohort ? capRemaining(state.equityBaseUnits, state.cohort.usedFraction, policy.maxCohortExposureFraction) : null,
      clusterRemainingBaseUnits: state.cluster ? capRemaining(state.equityBaseUnits, state.cluster.usedFraction, policy.maxClusterExposureFraction) : null,
      liquidityBaseUnits: proposal.liquidityUsd === null ? null : usdToBase(proposal.liquidityUsd, state.settlementDecimals),
      availableCapitalBaseUnits: bigIntToAmount(minBig(amountToBigInt(availableCapital), amountToBigInt(totalRemaining), amountToBigInt(tokenRemaining))),
    });
    if (sizing.unknownCapacity) reasons.add('COHORT_UNKNOWN');
    if (amountToBigInt(sizing.sizeBaseUnits) === 0n) {
      reasons.add('SIZE_ZERO');
      if (amountToBigInt(totalRemaining) === 0n) reasons.add('TOTAL_EXPOSURE_CAP');
      if (amountToBigInt(tokenRemaining) === 0n) reasons.add('TOKEN_EXPOSURE_CAP');
      if (sizing.binding === 'COHORT_REMAINING' && !sizing.unknownCapacity) reasons.add('COHORT_CAP');
      if (sizing.binding === 'CLUSTER_REMAINING' && !sizing.unknownCapacity) reasons.add('CLUSTER_CAP');
      if (sizing.binding === 'AVAILABLE_CAPITAL') reasons.add('INSUFFICIENT_BALANCE');
    }
  }

  const allowed = reasons.size === 0;
  const size = allowed && sizing ? sizing.sizeBaseUnits : null;
  const maxLoss = size && stopDistanceFraction ? mulDiv(size, BigInt(Math.round(stopDistanceFraction * 1_000_000)), 1_000_000n, 'CEIL') : null;
  const record: RiskEvaluation = {
    id: proposal.id,
    proposalId: proposal.proposalId,
    actionCycleId: proposal.actionCycleId,
    policyVersion: policy.version,
    allowed,
    reasonCodes: [...reasons],
    settlementMint: state.settlementMint,
    equityBaseUnits: state.equityBaseUnits,
    equityUsd: null,
    exposureBaseUnits: committed,
    cohortExposure: state.cohort ? { [state.cohort.id]: state.cohort.usedFraction } : {},
    clusterExposure: state.cluster ? { [state.cluster.id]: state.cluster.usedFraction } : {},
    sleeveExposure: state.sleeve ? Math.max(0, Math.min(1, 1 - Number(amountToBigInt(state.sleeve.capRemainingBaseUnits)) / Math.max(1, Number(amountToBigInt(state.equityBaseUnits))))) : null,
    assetEligibilityEvaluationId: proposal.eligibilityEvaluationId,
    computedMaxLossBaseUnits: maxLoss,
    computedPositionAmount: size,
    maxSlippageBps: policy.maxSlippageBps,
    maxPriceImpactBps: policy.maxImpactBps,
    stopPolicy: stop ? { model: policy.stop.model, level: stop.level, distanceFraction: stop.distanceFraction } : null,
    targetPolicy: { policy: policy.takeProfit.policy, parameters: { targetRMultiple: policy.takeProfit.targetRMultiple, trailAfterRMultiple: policy.takeProfit.trailAfterRMultiple, trailFraction: policy.takeProfit.trailFraction, maxHoldMs: policy.takeProfit.maxHoldMs } },
    dailyDrawdownFraction: state.drawdown.dailyFraction,
    circuitBreakerTripped: breakerActive,
    staleDataChecks: staleChecks,
    createdAt: now,
  };
  return { record, sizing, stopDistanceFraction };
}

function minBig(...xs: bigint[]): bigint {
  return xs.reduce((m, x) => (x < m ? x : m));
}
