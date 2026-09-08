import { SourceQualityClass, SourceTimeConfidence } from '../enums.js';
import { z } from 'zod';
import { WSOL_MINT } from './eligibility.js';
import { Fraction, Bps, Milliseconds, UsdValue, VersionId } from '../primitives.js';

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

/**
 * Catalyst-response trigger (§9.4, §10.3, D64): a fresh, trustworthy-timed, novel catalyst for an
 * eligible asset with market confirmation. Social-only evidence never qualifies (§9.5).
 */
export const CatalystTriggerPolicy = z.strictObject({
  version: VersionId,
  /** Source quality floor for the catalyst (§10.4 classes). */
  minSourceQuality: SourceQualityClass,
  minSourceTimeConfidence: SourceTimeConfidence,
  /** Catalyst age from trustworthy source time above which it is not fresh (D64). */
  maxCatalystAgeMs: Milliseconds,
  /** Dedupe novelty at or above this: a syndicated copy is not a new catalyst. */
  minNoveltyScore: Fraction,
  /** Market confirmation. */
  minReturn15m: z.number().min(0),
  minRelativeVolume60: z.number().min(0),
  minLiquidityUsd: UsdValue,
  minScannerScore: z.number().min(0).max(100),
  dedupeWindowMs: Milliseconds,
  cooldownMs: Milliseconds,
  candidateTtlMs: Milliseconds,
});
export type CatalystTriggerPolicy = z.infer<typeof CatalystTriggerPolicy>;

export const DEFAULT_CATALYST_TRIGGER_POLICY: CatalystTriggerPolicy = {
  version: 'catalyst-v1' as VersionId,
  minSourceQuality: 'IDENTIFIED_CREATOR',
  minSourceTimeConfidence: 'HIGH',
  maxCatalystAgeMs: 6 * 3_600_000,
  minNoveltyScore: 0.5,
  minReturn15m: 0.01,
  minRelativeVolume60: 1.3,
  minLiquidityUsd: 250_000,
  minScannerScore: 50,
  dedupeWindowMs: 60 * 60_000,
  cooldownMs: 60 * 60_000,
  candidateTtlMs: 30 * 60_000,
};

/**
 * Smart-money accumulation trigger (§9.3, §18.3, D26): several independently high-quality wallets
 * buying over 4h, not dominated by one, with market structure confirming. Owned wallets never count.
 */
export const SmartMoneyTriggerPolicy = z.strictObject({
  version: VersionId,
  minDistinctBuyers4h: z.number().int().positive(),
  minNetFlowUsd4h: UsdValue,
  /** Share of 4h buy flow from the largest single buyer at or below this. */
  maxTopBuyerShare: Fraction,
  /** Buyers must exceed sellers by this ratio. */
  minBuyerSellerRatio: z.number().positive(),
  minEma9Over21: z.number(),
  minLiquidityUsd: UsdValue,
  minScannerScore: z.number().min(0).max(100),
  dedupeWindowMs: Milliseconds,
  cooldownMs: Milliseconds,
  candidateTtlMs: Milliseconds,
});
export type SmartMoneyTriggerPolicy = z.infer<typeof SmartMoneyTriggerPolicy>;

export const DEFAULT_SMART_MONEY_TRIGGER_POLICY: SmartMoneyTriggerPolicy = {
  version: 'smart-money-v1' as VersionId,
  minDistinctBuyers4h: 3,
  minNetFlowUsd4h: 5_000,
  maxTopBuyerShare: 0.6,
  minBuyerSellerRatio: 1.5,
  minEma9Over21: 0,
  minLiquidityUsd: 250_000,
  minScannerScore: 50,
  dedupeWindowMs: 60 * 60_000,
  cooldownMs: 2 * 3_600_000,
  candidateTtlMs: 30 * 60_000,
};

/** Hybrid ensemble (§12.1 S4): aligned evidence across at least two independent families inside a window. */
export const HybridTriggerPolicy = z.strictObject({
  version: VersionId,
  minFamilies: z.number().int().min(2),
  alignmentWindowMs: Milliseconds,
  minFamilyScore: z.number().min(0).max(100),
  minScannerScore: z.number().min(0).max(100),
  dedupeWindowMs: Milliseconds,
  cooldownMs: Milliseconds,
  candidateTtlMs: Milliseconds,
});
export type HybridTriggerPolicy = z.infer<typeof HybridTriggerPolicy>;

export const DEFAULT_HYBRID_TRIGGER_POLICY: HybridTriggerPolicy = {
  version: 'hybrid-v1' as VersionId,
  minFamilies: 2,
  alignmentWindowMs: 30 * 60_000,
  minFamilyScore: 50,
  minScannerScore: 55,
  dedupeWindowMs: 30 * 60_000,
  cooldownMs: 60 * 60_000,
  candidateTtlMs: 20 * 60_000,
};
