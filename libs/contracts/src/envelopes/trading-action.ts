import { z } from 'zod';
import { AdversaryVerdict, CatalystNovelty, ProtectionMode, TradingActionType, Urgency } from '../enums.js';
import { Fraction, Instant, Uuid, VersionId } from '../primitives.js';
import { ReasonCode } from '../entities/common.js';

// §11.6 Trading action contract -----------------------------------------------------------------

/** What the agent may request for protection. The runtime may only ever tighten (D39, §11.8). */
export const ProtectionIntent = z.strictObject({
  mode: ProtectionMode.nullable(),
  tightenStopToPrice: z.number().nonnegative().nullable(),
  enableTrailing: z.boolean().nullable(),
  cancelProviderOrder: z.boolean().nullable(),
  rationale: z.string().max(1024),
});
export type ProtectionIntent = z.infer<typeof ProtectionIntent>;

/**
 * The proposer's typed output. It carries no executable destination and no position amount;
 * entry size is deterministic risk output (D3, D4, §11.6).
 */
export const TradingActionProposal = z.strictObject({
  actionType: TradingActionType,
  /** v1 is spot long only (§6.11). */
  direction: z.literal('LONG'),
  candidateId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  strategyVersionId: VersionId,
  skillVersionId: VersionId.nullable(),
  triggerId: Uuid,
  thesis: z.string().min(1).max(4096),
  supportingEvidenceIds: z.array(Uuid),
  contradictingEvidenceIds: z.array(Uuid),
  catalystNovelty: CatalystNovelty.nullable(),
  expectedHorizonMinutes: z.number().int().positive(),
  confidence: Fraction,
  invalidation: z.string().min(1).max(2048),
  requestedFractionToReduce: Fraction.nullable(),
  protectionIntent: ProtectionIntent.nullable(),
  urgency: Urgency,
  expiresAt: Instant,
  reasoningSummary: z.string().min(1).max(4096),
  evidenceCutoffVersion: z.number().int().positive(),
});
export type TradingActionProposal = z.infer<typeof TradingActionProposal>;

// §11.8 Adversary output ------------------------------------------------------------------------

export const AdversaryObjectionOutput = z.strictObject({
  code: ReasonCode,
  detail: z.string().min(1).max(2048),
  evidenceIds: z.array(Uuid),
});

/** The adversary never edits the proposal; it returns a verdict and typed objections (§11.9). */
export const AdversarialReviewOutput = z.strictObject({
  verdict: AdversaryVerdict,
  objections: z.array(AdversaryObjectionOutput),
  counterEvidenceIds: z.array(Uuid),
  confidence: Fraction,
  evidenceCutoffVersion: z.number().int().positive(),
  reasoningSummary: z.string().min(1).max(4096),
});
export type AdversarialReviewOutput = z.infer<typeof AdversarialReviewOutput>;
