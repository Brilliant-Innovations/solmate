import { z } from 'zod';
import { Bps, Fraction, Milliseconds, MintAddress, UsdValue, VersionId } from '../primitives.js';

/**
 * Deterministic eligibility policy (blueprint §7.2–7.4). "Exact numeric thresholds are
 * configuration, not hardcoded blueprint constants": this schema is the configuration, versioned,
 * and every AssetEligibility record names the version that produced it. The engine that applies
 * it lives in libs/risk (deterministic, no LLM, no provider text).
 */

/** Reason codes an eligibility evaluation may emit (core.reason_code domain: ^[A-Z][A-Z0-9_]{2,63}$). */
export const EligibilityReason = z.enum([
  // hard rejects from chain truth
  'MINT_NOT_INITIALIZED',
  'UNKNOWN_TOKEN_PROGRAM',
  'SUPPLY_ZERO',
  'MINT_AUTHORITY_PRESENT',
  'FREEZE_AUTHORITY_PRESENT',
  'NON_TRANSFERABLE',
  'DEFAULT_ACCOUNT_FROZEN',
  'PERMANENT_DELEGATE',
  'TRANSFER_HOOK',
  'TRANSFER_FEE_ABOVE_MAX',
  'MINT_PAUSED',
  'DENYLISTED',
  // hard rejects from corroboration and market structure
  'CHAIN_ANALYTICS_MISMATCH',
  'SECURITY_DATA_STALE',
  'SECURITY_FAKE_TOKEN',
  'LIQUIDITY_BELOW_FLOOR',
  'TOP10_CONCENTRATION_ABOVE_MAX',
  'NO_EXIT_ROUTE',
  'PRICE_IMPACT_ABOVE_MAX',
  // hard rejects because required data is missing (fail closed; asset stays EVALUATING)
  'SECURITY_DATA_UNAVAILABLE',
  'MARKET_DATA_UNAVAILABLE',
  'ROUTE_PROBE_UNAVAILABLE',
  // soft findings (grade only)
  'VOLUME_BELOW_FLOOR',
  'HOLDERS_BELOW_FLOOR',
  'TOKEN_AGE_BELOW_MIN',
  'TOKEN_AGE_UNKNOWN',
  'MUTABLE_METADATA',
  'MINT_CLOSE_AUTHORITY',
  'CREATOR_CONCENTRATION_HIGH',
  'TOP10_CONCENTRATION_HIGH',
  'NOT_ON_JUP_STRICT_LIST',
]);
export type EligibilityReason = z.infer<typeof EligibilityReason>;

/** Reasons that mean "we do not know yet", never "unsafe": the asset keeps EVALUATING. */
export const UNAVAILABLE_REASONS: readonly EligibilityReason[] = ['SECURITY_DATA_UNAVAILABLE', 'MARKET_DATA_UNAVAILABLE', 'ROUTE_PROBE_UNAVAILABLE'];

export const EligibilityPolicy = z.strictObject({
  version: VersionId,
  rejectMintAuthority: z.boolean(),
  rejectFreezeAuthority: z.boolean(),
  rejectPermanentDelegate: z.boolean(),
  rejectTransferHook: z.boolean(),
  maxTransferFeeBps: Bps,
  minLiquidityUsd: UsdValue,
  minVolume24hUsd: UsdValue,
  minHolderCount: z.number().int().nonnegative(),
  /** Chain-derived top-10 share above which entry is hard-rejected. */
  maxTop10Fraction: Fraction,
  /** Chain-derived top-10 share above which the grade is penalised. */
  softTop10Fraction: Fraction,
  maxCreatorPercentage: z.number().min(0).max(100),
  /** Absolute tolerance between chain top-10 and analytics top-10 before D45 mismatch blocks entry. */
  concentrationMismatchTolerance: Fraction,
  minTokenAgeMs: Milliseconds,
  maxSecurityAgeMs: Milliseconds,
  /** An eligibility record older than this cannot authorise an entry (§7.4 "immediately before entry"). */
  maxEligibilityAgeMs: Milliseconds,
  /** Standard probe sizes and the impact ceiling per size (§7.2 "maximum simulated/quoted price impact"). */
  probeSizesUsd: z.array(UsdValue.refine((v) => v > 0)).min(1),
  maxImpactBps: Bps,
  denylist: z.array(MintAddress),
});
export type EligibilityPolicy = z.infer<typeof EligibilityPolicy>;

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  version: 'eligibility-v1' as VersionId,
  rejectMintAuthority: true,
  rejectFreezeAuthority: true,
  rejectPermanentDelegate: true,
  rejectTransferHook: true,
  maxTransferFeeBps: 100 as Bps,
  minLiquidityUsd: 50_000,
  minVolume24hUsd: 100_000,
  minHolderCount: 500,
  maxTop10Fraction: 0.6,
  softTop10Fraction: 0.35,
  maxCreatorPercentage: 10,
  concentrationMismatchTolerance: 0.15,
  minTokenAgeMs: 24 * 60 * 60_000,
  maxSecurityAgeMs: 60 * 60_000,
  maxEligibilityAgeMs: 15 * 60_000,
  probeSizesUsd: [250, 1_000, 5_000],
  maxImpactBps: 300 as Bps,
  denylist: [],
};
