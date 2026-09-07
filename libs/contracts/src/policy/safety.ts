import { z } from 'zod';
import { Bps, Fraction, Milliseconds, VersionId } from '../primitives.js';

/**
 * Held-asset safety policy (blueprint §7.5, D34). Thresholds are configuration, versioned like
 * the eligibility policy; every HeldAssetSafety record names the version that produced it.
 */
export const SafetyPolicy = z.strictObject({
  version: VersionId,
  /** Selling the whole position through the primary route above this impact is EXIT_RECOMMENDED. */
  maxSellImpactBps: Bps,
  /** Liquidity below (1 - fraction) × baseline is DEGRADED. */
  liquidityDropFraction: Fraction,
  /** Liquidity below (1 - fraction) × baseline is EXIT_RECOMMENDED. */
  liquidityCollapseFraction: Fraction,
  /** Top-10 chain concentration rising by more than this (absolute) is DEGRADED. */
  concentrationShockDelta: Fraction,
  /** A transfer fee raised by more than this over the baseline is EXIT_RECOMMENDED. */
  transferFeeRaiseBps: Bps,
  maxEmergencySnapshotAgeMs: Milliseconds,
  maxSecurityAgeMs: Milliseconds,
  maxChainReadAgeMs: Milliseconds,
});
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  version: 'safety-v1' as VersionId,
  maxSellImpactBps: 600 as Bps,
  liquidityDropFraction: 0.5,
  liquidityCollapseFraction: 0.8,
  concentrationShockDelta: 0.2,
  transferFeeRaiseBps: 100 as Bps,
  maxEmergencySnapshotAgeMs: 6 * 3_600_000,
  maxSecurityAgeMs: 6 * 3_600_000,
  maxChainReadAgeMs: 10 * 60_000,
};
