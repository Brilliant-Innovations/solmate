import { z } from 'zod';
import { WSOL_MINT } from './eligibility.js';
import { Bps, Milliseconds, UsdValue, VersionId } from '../primitives.js';

/**
 * Momentum-continuation trigger and candidate lifecycle policy (blueprint §9.1, §9.7, §6.9).
 * Versioned and deterministic: every threshold is a stored number, the score is a fixed formula
 * over feature-vector values, and a cold feature (null) can never fire. Dedupe aggregates related
 * triggers inside a window; a cooldown follows every rejection or expiry so the scanner never
 * "invokes five analyses for the same ongoing move".
 */
export const MomentumTriggerPolicy = z.strictObject({
  version: VersionId,
  /** Abnormal short-horizon return: 15-minute return at or above this fraction. */
  minReturn15m: z.number().min(0),
  /** Relative volume expansion: last-minute volume over the 60-minute median at or above this. */
  minRelativeVolume60: z.number().min(0),
  /** Trend confirmation: fast EMA over slow EMA at or above this fraction (0 = at least flat). */
  minEma9Over21: z.number(),
  /** Not yet excessively extended: 15-minute return must not exceed this many ATR(14) units. */
  maxExtensionAtrMultiple: z.number().positive(),
  /** RSI above this is treated as exhausted rather than continuing. */
  maxRsi14: z.number().min(0).max(100),
  /** Liquidity adequate: latest eligibility liquidity at or above this. */
  minLiquidityUsd: UsdValue,
  /** Executable: smallest-probe impact at or below this. */
  maxImpactBpsSmall: Bps,
  /** Relative strength versus SOL: 1h return minus SOL 1h return at or above this when available. */
  minSolRelativeReturn1h: z.number(),
  /** Candidates below this score are not raised. */
  minScannerScore: z.number().min(0).max(100),
  /** Related triggers inside this window share one candidate (§9.7). */
  dedupeWindowMs: Milliseconds,
  /** After a rejection or expiry on an asset, no new candidate of this family for this long. */
  cooldownMs: Milliseconds,
  /** A candidate that is not qualified within this time expires (§6.9). */
  candidateTtlMs: Milliseconds,
});
export type MomentumTriggerPolicy = z.infer<typeof MomentumTriggerPolicy>;

/**
 * Reference series (§9.1 relative strength, §12.1 SOL-relative features): mints whose candles and features are kept
 * warm as market context whatever their eligibility. Being a reference never makes a mint tradable; eligibility does.
 */
export const REFERENCE_SERIES_MINTS: readonly string[] = [WSOL_MINT];

export const DEFAULT_MOMENTUM_TRIGGER_POLICY: MomentumTriggerPolicy = {
  version: 'momentum-v1' as VersionId,
  minReturn15m: 0.02,
  minRelativeVolume60: 2,
  minEma9Over21: 0,
  maxExtensionAtrMultiple: 4,
  maxRsi14: 85,
  minLiquidityUsd: 250_000,
  maxImpactBpsSmall: 100 as Bps,
  minSolRelativeReturn1h: 0,
  minScannerScore: 50,
  dedupeWindowMs: 15 * 60_000,
  cooldownMs: 30 * 60_000,
  candidateTtlMs: 10 * 60_000,
};

/** The lifecycle fields every deterministic trigger family shares (§9.7 dedupe/cooldown, §6.9 TTL). */
export type CandidateLifecyclePolicy = Pick<MomentumTriggerPolicy, 'dedupeWindowMs' | 'cooldownMs' | 'candidateTtlMs' | 'minScannerScore'>;

/**
 * Early-acceleration trigger (§9.2): rising slope and flow before an obvious breakout. Versioned
 * and deterministic like the momentum policy; the pre-breakout conditions keep it from firing on
 * the same setups the continuation family already takes.
 */
export const EarlyAccelerationTriggerPolicy = z.strictObject({
  version: VersionId,
  /** 5-minute return acceleration (latest 5m return minus the one five minutes earlier) at or above this. */
  minReturnAccel5m: z.number().min(0),
  /** Volume over the last 15 bars against the prior 15, as a growth fraction, at or above this. */
  minVolumeAccel15: z.number().min(0),
  /** Trade-count growth over the same windows; optional evidence when the provider gives no counts. */
  minTradeCountAccel15: z.number().min(0),
  /** Fast EMA over slow EMA at or above this (slightly negative = still turning). */
  minEma9Over21: z.number(),
  /** Share of up-closes centred on zero at or above this. */
  minTrendPersistence20: z.number().min(-1).max(1),
  /** breakout_20 at or below this (0 = no breakout yet; the continuation family owns 1). */
  maxBreakout20: z.number().int().min(-1).max(1),
  /** Bollinger location at or below this: not already at the upper band. */
  maxBbLocation20: z.number().min(0).max(1.5),
  maxExtensionAtrMultiple: z.number().positive(),
  maxRsi14: z.number().min(0).max(100),
  minLiquidityUsd: UsdValue,
  maxImpactBpsSmall: Bps,
  minSolRelativeReturn1h: z.number(),
  minScannerScore: z.number().min(0).max(100),
  dedupeWindowMs: Milliseconds,
  cooldownMs: Milliseconds,
  candidateTtlMs: Milliseconds,
});
export type EarlyAccelerationTriggerPolicy = z.infer<typeof EarlyAccelerationTriggerPolicy>;

export const DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY: EarlyAccelerationTriggerPolicy = {
  version: 'early-accel-v1' as VersionId,
  minReturnAccel5m: 0.01,
  minVolumeAccel15: 0.5,
  minTradeCountAccel15: 0.3,
  minEma9Over21: -0.005,
  minTrendPersistence20: 0.2,
  maxBreakout20: 0,
  maxBbLocation20: 0.9,
  maxExtensionAtrMultiple: 2,
  maxRsi14: 75,
  minLiquidityUsd: 250_000,
  maxImpactBpsSmall: 100 as Bps,
  minSolRelativeReturn1h: 0,
  minScannerScore: 50,
  dedupeWindowMs: 15 * 60_000,
  cooldownMs: 30 * 60_000,
  candidateTtlMs: 10 * 60_000,
};
