import { z } from 'zod';
import { StopModel, TakeProfitPolicy } from '../enums.js';
import { Amount, Bps, Fraction, Milliseconds, VersionId } from '../primitives.js';

/**
 * Deterministic risk policy (blueprint §13.1–13.6; §31 "risk sizing deterministic", "risk cohorts
 * are deterministic/versioned, not LLM-controlled"; ADR-0009 P1). Versioned and stored; the agent
 * never chooses `riskPerTradeFraction` or its sleeve (§13.3). Amounts are base units of the
 * settlement mint so the evaluation never touches floating point for money.
 */
export const RiskPolicy = z.strictObject({
  version: VersionId,
  // §13.1 portfolio-level
  maxTotalExposureFraction: Fraction,
  minSettlementReserveBaseUnits: Amount,
  minGasReserveLamports: Amount,
  maxOpenPositions: z.number().int().positive(),
  maxExposurePerTokenFraction: Fraction,
  maxCohortExposureFraction: Fraction,
  maxClusterExposureFraction: Fraction,
  /** ADR-0007: when true an unknown cohort/cluster is the most restrictive cap (refuse); paper research may disable. */
  requireCohortCapacity: z.boolean(),
  maxDailyDrawdownFraction: Fraction,
  maxRollingDrawdownFraction: Fraction,
  maxConsecutiveLosses: z.number().int().positive(),
  cooldownAfterBreakerMs: Milliseconds,
  /** ADR-0007/0009 P1: exposure-increasing authorizations allowed in flight at once. */
  maxInFlightExposureIncreasing: z.number().int().positive(),
  // §13.3 sizing
  riskPerTradeFraction: Fraction,
  maxPositionValueBaseUnits: Amount,
  /** Position may not exceed this fraction of the token's quoted liquidity. */
  liquidityCapFraction: Fraction,
  // §13.2 trade-level
  maxImpactBps: Bps,
  maxSlippageBps: Bps,
  chaseToleranceBps: Bps,
  maxQuoteAgeMs: Milliseconds,
  minRewardToRiskRatio: z.number().positive(),
  maxClockDriftMs: Milliseconds,
  maxExecutionAnomalies: z.number().int().nonnegative(),
  // §13.4 stops / §13.5 exits
  stop: z.strictObject({
    model: StopModel,
    atrMultiple: z.number().positive(),
    /** Percentage cap: a stop is never wider than this fraction below entry, whatever the model says. */
    maxStopFraction: Fraction,
  }),
  takeProfit: z.strictObject({
    policy: TakeProfitPolicy,
    targetRMultiple: z.number().positive(),
    /** Trailing starts once this R multiple is reached. */
    trailAfterRMultiple: z.number().positive(),
    trailFraction: Fraction,
    maxHoldMs: Milliseconds,
  }),
});
export type RiskPolicy = z.infer<typeof RiskPolicy>;

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: 'risk-v1' as VersionId,
  maxTotalExposureFraction: 0.5,
  minSettlementReserveBaseUnits: '50000000' as Amount, // 50 USDC
  minGasReserveLamports: '50000000' as Amount, // 0.05 SOL
  maxOpenPositions: 3,
  maxExposurePerTokenFraction: 0.2,
  maxCohortExposureFraction: 0.3,
  maxClusterExposureFraction: 0.3,
  requireCohortCapacity: false,
  maxDailyDrawdownFraction: 0.03,
  maxRollingDrawdownFraction: 0.08,
  maxConsecutiveLosses: 3,
  cooldownAfterBreakerMs: 4 * 3_600_000,
  maxInFlightExposureIncreasing: 1,
  riskPerTradeFraction: 0.005,
  maxPositionValueBaseUnits: '200000000' as Amount, // 200 USDC
  liquidityCapFraction: 0.005,
  maxImpactBps: 100 as Bps,
  maxSlippageBps: 100 as Bps,
  chaseToleranceBps: 75 as Bps,
  maxQuoteAgeMs: 15_000,
  minRewardToRiskRatio: 1.5,
  maxClockDriftMs: 5_000,
  maxExecutionAnomalies: 2,
  stop: { model: 'ATR', atrMultiple: 2, maxStopFraction: 0.08 },
  takeProfit: { policy: 'TRAILING_AFTER_THRESHOLD', targetRMultiple: 3, trailAfterRMultiple: 1, trailFraction: 0.04, maxHoldMs: 6 * 3_600_000 },
};

/** Reason codes an entry evaluation can carry (stored as core.reason_code). */
export const RISK_REASONS = [
  'NOT_ELIGIBLE',
  'PROPOSAL_EXPIRED',
  'DATA_STALE',
  'QUOTE_MISSING',
  'QUOTE_STALE',
  'CHASE_EXCEEDED',
  'IMPACT_ABOVE_MAX',
  'SLIPPAGE_ABOVE_MAX',
  'TOKEN2022_INCOMPATIBLE',
  'REWARD_RISK_BELOW_MIN',
  'STOP_UNDEFINED',
  'SIZE_ZERO',
  'INSUFFICIENT_BALANCE',
  'DUPLICATE_INTENT',
  'EXPOSURE_IN_FLIGHT',
  'MAX_POSITIONS',
  'TOTAL_EXPOSURE_CAP',
  'TOKEN_EXPOSURE_CAP',
  'COHORT_CAP',
  'CLUSTER_CAP',
  'COHORT_UNKNOWN',
  'SLEEVE_INACTIVE',
  'SETTLEMENT_RESERVE',
  'GAS_RESERVE',
  'DRAWDOWN_LIMIT',
  'CIRCUIT_BREAKER',
  'CUSTODY_MISMATCH',
  'FEEDS_STALE',
  'DB_UNAVAILABLE',
  'EXECUTION_ANOMALIES',
  'PROVIDER_AUTH_FAILURE',
  'CLOCK_DRIFT',
  'OPERATOR_KILL',
  'SESSION_NOT_ACTIVE',
  'SYSTEM_DEGRADED',
] as const;
export type RiskReason = (typeof RISK_REASONS)[number];
