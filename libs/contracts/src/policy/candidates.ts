import { z } from 'zod';
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
