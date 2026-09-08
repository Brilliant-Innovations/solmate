import { z } from 'zod';
import { SpeedTier, TradingActionType } from '../enums.js';
import { JsonRecord } from '../entities/common.js';
import { Fraction, Instant, Uuid, VersionId } from '../primitives.js';
import { AdversaryObjectionOutput, TradingActionProposal } from './trading-action.js';

/**
 * Model-gateway envelopes (blueprint §11.2, §11.8–11.9, §11.13, D30, D40). The proposer and the
 * adversary receive the same point-in-time packet under one explicit cutoff. Evidence is quoted
 * data with ids the run may cite; it is never an instruction channel. Nothing here carries an
 * amount, a destination, a credential or a control surface.
 */

export const EvidenceItem = z.strictObject({
  id: Uuid,
  kind: z.enum(['EVENT', 'FEATURE_SNAPSHOT', 'SAFETY_STATE', 'ONCHAIN_CONTEXT', 'EXECUTION_PREVIEW', 'POSITION_STATE']),
  /** First-seen (events) or observation time; never later than the cutoff. */
  observedAt: Instant,
  /** Provider-independent quality label where one exists (events), else null. */
  quality: z.string().max(64).nullable(),
  /** Quoted content, bounded; the prompt renders it as data. */
  quoted: z.string().max(4096),
  /** Typed facts (numbers, enums) the model may reason over. */
  facts: JsonRecord,
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const TradingSkillContext = z.strictObject({
  actionCycleId: Uuid,
  candidateId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  assetId: Uuid,
  strategyVersionId: VersionId,
  skillVersionId: VersionId,
  guidelineVersionId: VersionId.nullable(),
  speedTier: SpeedTier,
  triggerId: Uuid,
  /** Actions this run may propose: the machine's target rule intersected with the skill version. */
  allowedActions: z.array(TradingActionType).min(1),
  cutoffVersion: z.number().int().positive(),
  cutoffAt: Instant,
  /** The cycle's decision deadline; the model is told, and the runner enforces it. */
  deadlineAt: Instant,
  evidence: z.array(EvidenceItem),
  /** Strategy contract facts the skill must respect (chase tolerance, horizon, invalidation style). */
  strategyFacts: JsonRecord,
  /** 0 for the first proposal, 1 for the single permitted revision. */
  revisionRound: z.number().int().min(0).max(1),
  /** Typed objections from the adversary when this is a revision, else empty. */
  priorObjections: z.array(AdversaryObjectionOutput),
});
export type TradingSkillContext = z.infer<typeof TradingSkillContext>;

export const AdversarialReviewInput = z.strictObject({
  context: TradingSkillContext,
  proposalId: Uuid,
  proposal: TradingActionProposal,
});
export type AdversarialReviewInput = z.infer<typeof AdversarialReviewInput>;

/** What every model call reports about itself, stored on the agent run (§11.2). */
export const ModelCallMetadata = z.strictObject({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  promptVersion: VersionId,
  temperature: z.number().min(0).max(2).nullable(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  costUsd: z.number().nonnegative(),
});
export type ModelCallMetadata = z.infer<typeof ModelCallMetadata>;

/** Runner policy for discretionary cycles (§11.9, D40, D43). */
export const DiscretionaryCyclePolicy = z.strictObject({
  version: VersionId,
  /** A permitted refresh after CHALLENGE mints cutoff vN+1 for the revision and its review (D40). */
  refreshEvidenceOnRevision: z.boolean(),
  /** Ceiling for a single model call inside the cycle budget. */
  maxModelCallMs: z.number().int().positive(),
  /** Below this remaining budget no further model call starts; the cycle expires (§11.9). */
  minRemainingBudgetMs: z.number().int().nonnegative(),
  /** The adversary should not be the proposer's model; the runner records when it is (§11.2). */
  requireDistinctAdversaryModel: z.boolean(),
  minConfidence: Fraction,
});
export type DiscretionaryCyclePolicy = z.infer<typeof DiscretionaryCyclePolicy>;

export const DEFAULT_DISCRETIONARY_CYCLE_POLICY: DiscretionaryCyclePolicy = {
  version: 'cycle-v1' as VersionId,
  refreshEvidenceOnRevision: true,
  maxModelCallMs: 45_000,
  minRemainingBudgetMs: 2_000,
  requireDistinctAdversaryModel: false,
  minConfidence: 0.5,
};
