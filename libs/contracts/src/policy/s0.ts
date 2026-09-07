import { z } from 'zod';
import { MarketRegime, MarketSession } from '../enums.js';
import { Bps, Milliseconds, VersionId } from '../primitives.js';

/**
 * S0 deterministic momentum baseline (blueprint §12.1; D30 second-look for T0_FAST; §31
 * "baseline strategy required"). Two first-class variants share one trigger: S0_RAW is the
 * ungated shadow/paper counterfactual and never holds live authority; S0_SAFE applies this
 * independent deterministic counter-signal/safety gate before any paper/live action.
 */

export const S0_STRATEGY_VERSION_IDS = {
  RAW: 'S0_RAW@1.0.0' as VersionId,
  SAFE: 'S0_SAFE@1.0.0' as VersionId,
} as const;

export const S0Variant = z.enum(['RAW', 'SAFE']);
export type S0Variant = z.infer<typeof S0Variant>;

/**
 * The gate reads only the candidate's stored feature snapshot and clock: no live provider call,
 * so a recorded decision can be reconstructed from stored inputs (M5a exit gate). Its features
 * are deliberately counter-signals to the trigger's (extension, exhaustion, exit viability,
 * regime, session, self-influence), so the second look is independent rather than a re-run.
 */
export const S0SafetyGatePolicy = z.strictObject({
  version: VersionId,
  /** Candidate older than this at decision time is stale (also the strategy's maxCandidateAgeMs). */
  maxCandidateAgeMs: Milliseconds,
  maxFeatureAgeMs: Milliseconds,
  /** Chasing: 1h return above this is a parabolic extension the momentum trigger ignores. */
  maxReturn1h: z.number().positive(),
  /** Exhaustion: RSI above this, tighter than the trigger's. */
  maxRsi14: z.number().positive().max(100),
  /** Pump/wash signature: relative volume above this is anomalous, not confirmation. */
  maxRelativeVolume60: z.number().positive(),
  /** Exit viability: small-size impact must stay under this and a sell route must be confirmed. */
  maxExitImpactBps: Bps,
  minLiquidityUsd: z.number().nonnegative(),
  blockedRegimes: z.array(MarketRegime),
  blockedSessions: z.array(MarketSession),
  /** Names of features the gate needs; a null value fails closed (FEATURE_MISSING). */
  requiredFeatures: z.array(z.string().min(1)),
});
export type S0SafetyGatePolicy = z.infer<typeof S0SafetyGatePolicy>;

export const DEFAULT_S0_SAFETY_GATE_POLICY: S0SafetyGatePolicy = {
  version: 's0-gate-v1' as VersionId,
  maxCandidateAgeMs: 10 * 60_000,
  maxFeatureAgeMs: 5 * 60_000,
  maxReturn1h: 0.25,
  maxRsi14: 80,
  maxRelativeVolume60: 25,
  maxExitImpactBps: 75 as Bps,
  minLiquidityUsd: 300_000,
  blockedRegimes: ['BROAD_SELLOFF', 'VOLATILITY_SHOCK'],
  blockedSessions: ['WEEKEND'],
  requiredFeatures: ['ret_1h', 'rsi_14', 'rel_volume_60', 'impact_bps_small', 'sell_route_confirmed', 'liquidity_usd'],
};

export const S0_GATE_REASONS = [
  'CANDIDATE_STALE',
  'FEATURES_STALE',
  'FEATURE_MISSING',
  'SELF_INFLUENCE_SUPPRESSED',
  'SELL_ROUTE_UNCONFIRMED',
  'EXIT_IMPACT_HIGH',
  'LIQUIDITY_THIN',
  'OVEREXTENDED_1H',
  'OVERBOUGHT',
  'VOLUME_ANOMALY',
  'REGIME_BLOCKED',
  'SESSION_BLOCKED',
] as const;
export type S0GateReason = (typeof S0_GATE_REASONS)[number];

/** Reason recorded on an S0_RAW cycle: its review is the same gate output, informational only. */
export const S0_RAW_UNGATED_REASON = 'S0_RAW_UNGATED';
