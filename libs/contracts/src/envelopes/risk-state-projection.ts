import { z } from 'zod';
import { ProtectionMode } from '../enums.js';
import { Amount, Fraction, Instant, Milliseconds, MintAddress, Sequence, Sha256Hex, Slot, UsdValue, Uuid, VersionId } from '../primitives.js';
import { signedEnvelopeOf } from '../signing/signed-envelope.js';

// §6.14A risk.state_projections (D21, D52) ------------------------------------------------------

export const CustodyBalance = z.strictObject({
  custodyAccountId: Uuid,
  mint: MintAddress,
  amount: Amount,
});

export const SleeveUsage = z.strictObject({
  sleeveId: Uuid,
  strategyVersionId: VersionId,
  committedBaseUnits: Amount,
  capBaseUnits: Amount,
  riskRemainingBaseUnits: Amount,
});

export const OpenLotSummary = z.strictObject({
  lotId: Uuid,
  positionId: Uuid,
  assetId: Uuid,
  mint: MintAddress,
  quantity: Amount,
  /** Settlement base units paid for the lot: per-asset exposure for the risk-authorizer's token cap (§13.1). */
  costBasisBaseUnits: Amount,
  protectionMode: ProtectionMode,
  providerProtectionActive: z.boolean(),
});

export const CapacityEntry = z.strictObject({
  id: z.string().min(1).max(128),
  usedFraction: Fraction,
  capFraction: Fraction,
});

export const EligibilitySummaryEntry = z.strictObject({
  assetId: Uuid,
  evaluationId: Uuid,
  eligible: z.boolean(),
  evaluatedAt: Instant,
});

export const FreshnessSummaryEntry = z.strictObject({
  dataClass: z.string().min(1).max(64),
  ageMs: Milliseconds.nullable(),
  fresh: z.boolean(),
});

/**
 * Inputs to authorization, never authorization itself. Signed and sequenced by the worker state
 * projector; the risk-authorizer rejects missing, stale, rollback-sequence or signature-invalid
 * projections and independently re-reads D45 fields and balances from chain before signing.
 */
export const RiskStateProjection = z.strictObject({
  sequence: Sequence,
  asOf: Instant,
  chainSlot: Slot,
  releaseId: Uuid,
  releaseDigest: Sha256Hex,
  policyVersion: VersionId,
  sourceDigests: z.array(z.strictObject({ source: z.string(), digest: Sha256Hex })),
  settlementMint: MintAddress,
  custody: z.array(CustodyBalance),
  settlementAvailableBaseUnits: Amount,
  gasReserveLamports: Amount,
  aggregateNonSettlementExposureBaseUnits: Amount,
  exposureUsd: UsdValue.nullable(),
  signerDependentExposureBaseUnits: Amount,
  sleeves: z.array(SleeveUsage),
  openLots: z.array(OpenLotSummary),
  drawdown: z.strictObject({
    dailyFraction: Fraction,
    rollingFraction: Fraction,
    circuitBreakerTripped: z.boolean(),
    consecutiveLosses: z.number().int().nonnegative(),
  }),
  cohortCapacity: z.array(CapacityEntry),
  clusterCapacity: z.array(CapacityEntry),
  eligibilitySummary: z.array(EligibilitySummaryEntry),
  freshnessSummary: z.array(FreshnessSummaryEntry),
  capitalAttestation: z.strictObject({
    ceilingUsd: UsdValue,
    recognizedUsd: UsdValue,
    reattestRequired: z.boolean(),
  }),
});
export type RiskStateProjection = z.infer<typeof RiskStateProjection>;
export type CustodyBalance = z.infer<typeof CustodyBalance>;
export type SleeveUsage = z.infer<typeof SleeveUsage>;
export type OpenLotSummary = z.infer<typeof OpenLotSummary>;
export type CapacityEntry = z.infer<typeof CapacityEntry>;
export type EligibilitySummaryEntry = z.infer<typeof EligibilitySummaryEntry>;
export type FreshnessSummaryEntry = z.infer<typeof FreshnessSummaryEntry>;

export const SignedRiskStateProjection = signedEnvelopeOf(RiskStateProjection);
export type SignedRiskStateProjection = z.infer<typeof SignedRiskStateProjection>;
