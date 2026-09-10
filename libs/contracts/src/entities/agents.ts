import { z } from 'zod';
import { ClearedAuditRef } from './audit.js';
import {
  ActionCycleState,
  AdversaryVerdict,
  AgentRole,
  AutomationTriggerFamily,
  CapitalAuthority,
  SkillStatus,
  SpeedTier,
  ToolClassification,
  TradingActionType,
  UnresolvedReason,
} from '../enums.js';
import { Fraction, GitSha, Instant, Milliseconds, Sha256Hex, UsdValue, Uuid, VersionId } from '../primitives.js';
import { JsonRecord, ReasonCode, ReasonCodes } from './common.js';

// §6.10 agents.runs -----------------------------------------------------------------------------

export const AgentRun = z.object({
  id: Uuid,
  actionCycleId: Uuid.nullable(),
  candidateId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  role: AgentRole,
  provider: z.string(),
  model: z.string(),
  promptVersion: VersionId,
  temperature: z.number().min(0).max(2).nullable(),
  reasoningConfig: JsonRecord.nullable(),
  inputEvidenceIds: z.array(Uuid),
  cutoffVersion: z.number().int().positive(),
  cutoffAt: Instant,
  structuredOutput: JsonRecord.nullable(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  costUsd: UsdValue,
  /**
   * Whether costUsd is what the provider billed, or a floor because we never learned (2026-09-10).
   *
   * A call we abandon on our own deadline may well have been generated and billed; a non-2xx may not
   * have been. Recording 0 for both made a failed cycle look free, which understates D43 spend and -
   * because EVALUATION.md 7(2) divides edge by model cost per decision - inflates the measured edge.
   * Both errors point the same way, toward proceeding, so the uncertainty is recorded rather than
   * rounded to zero.
   */
  costAccrual: z.enum(["MEASURED", "UNKNOWN"]),
  latencyMs: Milliseconds,
  success: z.boolean(),
  schemaValidation: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
  createdAt: Instant,
});
export type AgentRun = z.infer<typeof AgentRun>;

// §6.10A agents.skill_versions ------------------------------------------------------------------

export const SkillVersion = z.object({
  id: Uuid,
  skillId: z.string().min(1).max(64),
  versionId: VersionId,
  gitSha: GitSha,
  toolManifestVersion: VersionId,
  guidelineVersion: VersionId,
  supportedActionTypes: z.array(TradingActionType),
  workflowGraphVersion: VersionId,
  contextBuilderVersion: VersionId,
  proposerModelPolicyVersion: VersionId,
  adversaryPolicyRequired: z.literal(true),
  status: SkillStatus,
  effectiveFrom: Instant,
  effectiveTo: Instant.nullable(),
});
export type SkillVersion = z.infer<typeof SkillVersion>;

// §6.10B agents.tool_invocations ----------------------------------------------------------------

export const ToolInvocation = z.object({
  id: Uuid,
  agentRunId: Uuid,
  actionCycleId: Uuid,
  toolName: z.string().min(1).max(64),
  toolVersion: VersionId,
  classification: ToolClassification,
  requestHash: Sha256Hex,
  responseRefs: z.array(z.string()),
  cutoffVersion: z.number().int().positive(),
  latencyMs: Milliseconds,
  error: z.string().nullable(),
  createdAt: Instant,
});
export type ToolInvocation = z.infer<typeof ToolInvocation>;

// §6.10C automations ----------------------------------------------------------------------------

export const AutomationDefinition = z.object({
  id: Uuid,
  name: z.string().min(1).max(64),
  versionId: VersionId,
  triggerFamily: AutomationTriggerFamily,
  triggerType: z.string().min(1).max(64),
  strategyVersionId: VersionId,
  skillVersionId: VersionId,
  filter: JsonRecord,
  minIntervalMs: Milliseconds,
  cooldownMs: Milliseconds,
  priority: z.number().int().min(0).max(100),
  scope: z.enum(['CANDIDATE', 'POSITION', 'SYSTEM']),
  enabledModes: z.array(CapitalAuthority),
  contextDeadlineMs: Milliseconds,
  enabled: z.boolean(),
  lastFiredAt: Instant.nullable(),
  nextEligibleAt: Instant.nullable(),
});
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

export const AutomationRunDisposition = z.enum([
  'INVOKED',
  'SKIPPED_COOLDOWN',
  'SKIPPED_BUDGET',
  'SKIPPED_MODE',
  'SKIPPED_ACTIVITY_STATE',
  'ERROR',
]);

export const AutomationRun = z.object({
  id: Uuid,
  automationId: Uuid,
  automationVersionId: VersionId,
  triggerEvent: JsonRecord,
  cutoffVersion: z.number().int().positive().nullable(),
  cutoffAt: Instant.nullable(),
  skillInvocationRunId: Uuid.nullable(),
  actionCycleId: Uuid.nullable(),
  disposition: AutomationRunDisposition,
  createdAt: Instant,
});
export type AutomationRun = z.infer<typeof AutomationRun>;

// §6.10D agents.action_cycles / adversarial_reviews (ADR-0001) ----------------------------------

export const EvidenceCutoff = z.object({
  version: z.number().int().positive(),
  at: Instant,
  consumedByRunIds: z.array(Uuid),
});
export type EvidenceCutoff = z.infer<typeof EvidenceCutoff>;

export const ActionCycle = z.object({
  id: Uuid,
  automationRunId: Uuid.nullable(),
  triggerId: Uuid,
  candidateId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  strategyVersionId: VersionId,
  skillVersionId: VersionId.nullable(),
  guidelineVersionId: VersionId.nullable(),
  speedTier: SpeedTier,
  decisionBudgetMs: Milliseconds,
  proposedAction: TradingActionType.nullable(),
  proposalId: Uuid.nullable(),
  proposerRunIds: z.array(Uuid),
  adversaryRunIds: z.array(Uuid),
  verdict: AdversaryVerdict.nullable(),
  reasonCodes: ReasonCodes,
  revisionRound: z.number().int().min(0).max(1),
  state: ActionCycleState,
  /** Present iff state is UNRESOLVED (D39 causes). */
  unresolvedReason: UnresolvedReason.nullable(),
  /** Ordered cutoff history (`cutoff_v1`, `cutoff_v2`, …) with the runs that consumed each (D40). */
  cutoffs: z.array(EvidenceCutoff).min(1),
  clearedCutoffVersion: z.number().int().positive().nullable(),
  riskEvaluationId: Uuid.nullable(),
  intentId: Uuid.nullable(),
  /** ADR-0009 P2: the ledger row that recorded the CLEARED transition; required by the risk-authorizer. */
  clearedAudit: ClearedAuditRef.nullable().optional(),
  startedAt: Instant,
  terminalAt: Instant.nullable(),
});
export type ActionCycle = z.infer<typeof ActionCycle>;

export const AdversaryObjection = z.object({
  code: ReasonCode,
  detail: z.string().max(2048),
  evidenceIds: z.array(Uuid),
});

export const AdversarialReview = z.object({
  id: Uuid,
  actionCycleId: Uuid,
  agentRunId: Uuid.nullable(),
  /** True for the T0_FAST deterministic counter-signal/safety gate (D30). */
  deterministicGate: z.boolean(),
  verdict: AdversaryVerdict,
  objections: z.array(AdversaryObjection),
  confidence: Fraction.nullable(),
  cutoffVersion: z.number().int().positive(),
  latencyMs: Milliseconds,
  /** False when recorded for a mandatory risk-reduction action, whose execution never waited (D31). */
  blocking: z.boolean(),
  createdAt: Instant,
});
export type AdversarialReview = z.infer<typeof AdversarialReview>;
