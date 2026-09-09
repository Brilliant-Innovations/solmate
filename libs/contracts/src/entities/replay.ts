import { z } from 'zod';
import { ActionCycleTerminalState, AdversaryVerdict, ReplayFidelity, TradingActionType } from '../enums.js';
import { Fraction, GitSha, Instant, Milliseconds, Sha256Hex, Uuid, VersionId } from '../primitives.js';

/**
 * Replay run record (blueprint §18.5 reproducibility, §18.1 fidelity levels, P9; execution plan
 * M10). A run names everything that shaped its decisions: strategy versions, code SHA, dataset
 * cutoff, provider dataset versions, seed, model/provider versions with their training-cutoff
 * disclosure, prompt versions and the calibration target. Its decisions are stored as rows
 * (§18.5: model outputs are not reproducible bit-for-bit, so outputs themselves are the record)
 * and digested, so a re-run can prove it reproduced the same timeline.
 */

export const ReplayRunStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);
export type ReplayRunStatus = z.infer<typeof ReplayRunStatus>;

/** Model-weight look-ahead (plan M10 addition): a model trained after the replay window starts has seen part of the window. */
export const ModelWeightLookAhead = z.enum(['WITHIN_WINDOW', 'POST_WINDOW', 'UNKNOWN']);
export type ModelWeightLookAhead = z.infer<typeof ModelWeightLookAhead>;

export const ReplayModelDisclosure = z.object({
  /** proposer | adversary | <tool name> */
  role: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  trainingCutoff: Instant.nullable(),
  lookAhead: ModelWeightLookAhead,
});
export type ReplayModelDisclosure = z.infer<typeof ReplayModelDisclosure>;

/** Every version id a result must carry (P9 acceptance: "results identify strategy/model/prompt/data versions"). */
export const ReplayVersions = z.object({
  gitSha: GitSha,
  contractSetDigest: Sha256Hex,
  featureEngineVersion: VersionId,
  riskPolicyVersion: VersionId,
  gatePolicyVersion: VersionId,
  costModelVersion: VersionId,
  promptVersions: z.record(z.string(), VersionId),
  modelSelections: z.record(z.string(), z.string()),
  /** Provider dataset versions where known (§18.5), e.g. { birdeye: 'ohlcv-v3' }. */
  providerDatasetVersions: z.record(z.string(), z.string()),
  skillVersionId: VersionId.nullable(),
  guidelineVersionId: VersionId.nullable(),
});
export type ReplayVersions = z.infer<typeof ReplayVersions>;

/** The prediction target confidence is calibrated against (plan M10 addition; §11.14 bins). */
export const CalibrationTarget = z.object({
  kind: z.enum(['NET_PNL_POSITIVE_AT_CLOSE', 'REACHED_TARGET_BEFORE_STOP']),
  /** Outcomes are read at close or at this horizon after entry, whichever comes first. */
  horizonMs: Milliseconds,
});
export type CalibrationTarget = z.infer<typeof CalibrationTarget>;

export const ReplayWindow = z
  .object({
    from: Instant,
    to: Instant,
    /** No observation made after this instant is readable by the run (§18.5 dataset cutoff). */
    datasetCutoff: Instant,
    /** Forward holdout protocol: decisions at or before this instant are in-sample, later ones hold-out; null = no split. */
    inSampleUntil: Instant.nullable(),
  })
  .refine((w) => w.from < w.to, { message: 'from must precede to' })
  .refine((w) => w.datasetCutoff >= w.to, { message: 'datasetCutoff must not precede the window end' })
  .refine((w) => w.inSampleUntil === null || (w.inSampleUntil > w.from && w.inSampleUntil < w.to), { message: 'inSampleUntil must fall inside the window' });
export type ReplayWindow = z.infer<typeof ReplayWindow>;

/** Which decision stream a row belongs to when one run evaluates a strategy under several protocols. */
export const ReplayVariant = z.enum(['FULL', 'PROPOSER_ONLY', 'LATENCY_MATCHED']);
export type ReplayVariant = z.infer<typeof ReplayVariant>;

export const ReplayRun = z.object({
  id: Uuid,
  name: z.string().min(1).max(120),
  fidelity: ReplayFidelity,
  status: ReplayRunStatus,
  requestedBy: Uuid.nullable(),
  window: ReplayWindow,
  /** Every strategy evaluated against the same timeline (P9: baseline and AI run on the same timeline). */
  strategyVersionIds: z.array(VersionId).min(1),
  baselineStrategyVersionId: VersionId,
  versions: ReplayVersions,
  models: z.array(ReplayModelDisclosure),
  /** Seed for every modelled random draw (execution failure sampling); identical seed + inputs = identical decisions. */
  seed: z.number().int().nonnegative(),
  /** Plan M10 addition: the baseline is also decided at the AI strategy's decision latency. */
  latencyMatchedBaseline: z.boolean(),
  /** Plan M10 addition: proposer-only shadow beside proposer+adversary. */
  proposerOnlyShadow: z.boolean(),
  calibrationTarget: CalibrationTarget,
  createdAt: Instant,
  startedAt: Instant.nullable(),
  completedAt: Instant.nullable(),
  decisionsDigest: Sha256Hex.nullable(),
  resultsDigest: Sha256Hex.nullable(),
  error: z.string().nullable(),
});
export type ReplayRun = z.infer<typeof ReplayRun>;

export const ReplayFill = z.object({
  inputAmount: z.string(),
  outputAmount: z.string(),
  executionShortfallBps: z.number().nullable(),
  feesBaseUnits: z.string(),
  executedAt: Instant,
});

export const ReplayOutcome = z.object({
  closedAt: Instant,
  realizedPnlBaseUnits: z.string(),
  holdMs: Milliseconds,
  exitReason: z.string(),
  /** Calibration target evaluated for this decision (null when the target was not decidable inside the window). */
  targetHit: z.boolean().nullable(),
});

/** One decision a replayed strategy made; the unit of the decisions digest and of every attribution query. */
export const ReplayDecision = z.object({
  id: Uuid,
  runId: Uuid,
  strategyVersionId: VersionId,
  variant: ReplayVariant,
  at: Instant,
  candidateId: Uuid,
  assetId: Uuid,
  /** In-sample or hold-out under the run's forward holdout protocol. */
  sample: z.enum(['IN_SAMPLE', 'HOLD_OUT']),
  cycleState: ActionCycleTerminalState,
  action: TradingActionType.nullable(),
  proposerConfidence: Fraction.nullable(),
  adversaryVerdict: AdversaryVerdict.nullable(),
  reasonCodes: z.array(z.string()),
  decisionLatencyMs: Milliseconds,
  /** Deterministic rejection after the decision (risk refusal, pre-submit chase/expiry, modelled failure); null when filled or not attempted. */
  rejection: z.string().nullable(),
  fill: ReplayFill.nullable(),
  outcome: ReplayOutcome.nullable(),
});
export type ReplayDecision = z.infer<typeof ReplayDecision>;

/** What the operator (or `tools/replay.mjs`) files as a RUN_REPLAY control request; the worker's replay role fills in every version and creates the run. */
export const ReplayRequestPayload = z.object({
  name: z.string().min(1).max(120),
  fidelity: ReplayFidelity,
  window: z.object({ from: Instant, to: Instant, inSampleUntil: Instant.nullable().default(null) }),
  strategyVersionIds: z.array(VersionId).min(1),
  baselineStrategyVersionId: VersionId,
  seed: z.number().int().nonnegative().default(0),
  latencyMatchedBaseline: z.boolean().default(true),
  proposerOnlyShadow: z.boolean().default(true),
  /** Restrict the universe; null = every asset with candles in the window. */
  assetIds: z.array(Uuid).nullable().default(null),
  calibrationTarget: CalibrationTarget.optional(),
});
export type ReplayRequestPayload = z.infer<typeof ReplayRequestPayload>;

/** Stored results for one run: strategy comparison and every attribution the Replay Lab renders. */
export const ReplayResults = z.object({
  comparison: z.array(z.object({ strategyVersionId: VersionId, variant: ReplayVariant, sample: z.enum(['IN_SAMPLE', 'HOLD_OUT', 'ALL']), metrics: z.record(z.string(), z.unknown()) })),
  incremental: z.array(z.record(z.string(), z.unknown())),
  disagreement: z.array(z.record(z.string(), z.unknown())),
  latency: z.array(z.record(z.string(), z.unknown())),
  calibration: z.array(z.record(z.string(), z.unknown())),
  attribution: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  economic: z.record(z.string(), z.unknown()),
  perStrategy: z.array(z.record(z.string(), z.unknown())),
  candidates: z.number().int().nonnegative(),
  ticks: z.number().int().nonnegative(),
});
export type ReplayResults = z.infer<typeof ReplayResults>;
