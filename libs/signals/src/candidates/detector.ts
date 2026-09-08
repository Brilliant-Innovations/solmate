import { type CatalystTriggerPolicy, type SmartMoneyTriggerPolicy, type HybridTriggerPolicy, addMs, instantToMs, type Candidate, type CandidateLifecyclePolicy, type EarlyAccelerationTriggerPolicy, type FeatureEngineSpec, type FeatureSnapshot, type Instant, type MomentumTriggerPolicy, type ReasonCode, type TriggerFamily, type Uuid } from '@sol-agent-trader/contracts';
import { selfInfluenceCheck, type SelfInfluenceContext } from '../self-influence/guard.js';
import { evaluateMomentumTrigger, type MomentumEvaluation } from '../triggers/momentum.js';
import { evaluateEarlyAccelerationTrigger, type EarlyAccelerationEvaluation } from '../triggers/early-acceleration.js';
import { evaluateCatalystTrigger, type CatalystEvaluation, type CatalystEvidence } from '../triggers/catalyst.js';
import { evaluateSmartMoneyTrigger, type SmartMoneyEvaluation, type SmartMoneyFlowFacts } from '../triggers/smart-money.js';
import { evaluateHybridTrigger, type FamilySignal, type HybridEvaluation } from '../triggers/hybrid.js';

/**
 * Candidate detection (blueprint §6.9, §9.1, §9.2, §9.7, §8.6, D63, ADR-0007). Pure decision over
 * a feature snapshot and the state the scanner already knows. Order of checks, per trigger family:
 *   1. warm-up: a required indicator that is still cold means no scoring at all (D63);
 *   2. the deterministic trigger of the family;
 *   3. dedupe (an open candidate for the same asset inside the window, any family: related
 *      triggers aggregate under one candidate) and cooldown (a recent rejection/expiry of this
 *      family) — silent skips, not records;
 *   4. the self-influence guard and the entry-eligibility gate — a trigger that fires but is
 *      refused here is recorded as a REJECTED candidate with its deterministic reason, so the
 *      research questions about filter value see rejected opportunities (§32).
 * A candidate never becomes tradeable here: DETECTED only means the strategy may look at it.
 */

export interface EntryGateInput {
  allowed: boolean;
  reason: string | null;
  eligibilityEvaluationId: Uuid | null;
}

export interface DetectorContext {
  newId: () => Uuid;
  now: Instant;
  snapshot: FeatureSnapshot;
  spec: FeatureEngineSpec;
  solRelativeReturn1h: number | null;
  entryGate: EntryGateInput;
  selfInfluence: SelfInfluenceContext;
  /** Open (non-terminal) candidates for this asset, any family (§9.7 aggregation). */
  openCandidates: readonly Pick<Candidate, 'dedupeKey' | 'discoveredAt'>[];
  /** Newest terminal (REJECTED/EXPIRED) candidate time for this asset and this family, if any. */
  lastTerminalAt: Instant | null;
}

export interface DetectorInput extends DetectorContext {
  policy: MomentumTriggerPolicy;
}

export interface EarlyAccelerationDetectorInput extends DetectorContext {
  policy: EarlyAccelerationTriggerPolicy;
}

export interface CatalystDetectorInput extends DetectorContext {
  policy: CatalystTriggerPolicy;
  /** Events visible at `now` for this asset (first seen at or before now), as the intelligence layer stored them. */
  events: readonly CatalystEvidence[];
}

export interface SmartMoneyDetectorInput extends DetectorContext {
  policy: SmartMoneyTriggerPolicy;
  flow: SmartMoneyFlowFacts;
}

export interface HybridDetectorInput extends DetectorContext {
  policy: HybridTriggerPolicy;
  /** Other families' recent verdicts on this asset (detected candidates and this tick's detections). */
  signals: readonly FamilySignal[];
}

export type TriggerEvaluation = MomentumEvaluation | EarlyAccelerationEvaluation | CatalystEvaluation | SmartMoneyEvaluation | HybridEvaluation;

export type DetectorDecision =
  | { kind: 'CANDIDATE'; candidate: Candidate; evaluation: TriggerEvaluation }
  | { kind: 'REJECTED'; candidate: Candidate; evaluation: TriggerEvaluation; reason: ReasonCode }
  | { kind: 'SKIP'; reason: 'FEATURES_COLD' | 'NO_TRIGGER' | 'DEDUPED' | 'COOLDOWN'; detail: string };

/** Warm when every indicator the spec requires for scoring is present in the snapshot (D63). */
export function isWarm(snapshot: Pick<FeatureSnapshot, 'features'>, spec: FeatureEngineSpec): { warm: boolean; cold: string[] } {
  const cold = spec.requiredForScoring.filter((f) => snapshot.features[f] === null || snapshot.features[f] === undefined);
  return { warm: cold.length === 0, cold };
}

export function dedupeKeyFor(assetId: Uuid, family: Candidate['triggerFamily'], at: Instant, windowMs: number): string {
  const bucket = Math.floor(instantToMs(at) / windowMs);
  return `${assetId}:${family}:${bucket}`;
}

/** Steps 3–4 shared by every deterministic family. */
function completeDetection(input: DetectorContext, family: TriggerFamily, policy: CandidateLifecyclePolicy & { version: string }, evaluation: TriggerEvaluation): DetectorDecision {
  const dedupeKey = dedupeKeyFor(input.snapshot.assetId, family, input.now, policy.dedupeWindowMs);
  const windowStart = instantToMs(input.now) - policy.dedupeWindowMs;
  const duplicate = input.openCandidates.find((c) => c.dedupeKey === dedupeKey || instantToMs(c.discoveredAt) >= windowStart);
  if (duplicate) return { kind: 'SKIP', reason: 'DEDUPED', detail: duplicate.dedupeKey };
  if (input.lastTerminalAt !== null && instantToMs(input.now) - instantToMs(input.lastTerminalAt) < policy.cooldownMs) {
    return { kind: 'SKIP', reason: 'COOLDOWN', detail: input.lastTerminalAt };
  }

  const base: Omit<Candidate, 'status' | 'deterministicRejectionReason'> = {
    id: input.newId(),
    assetId: input.snapshot.assetId,
    discoveredAt: input.now,
    triggerFamily: family,
    triggerDetails: { policyVersion: policy.version, featureEngineVersion: input.snapshot.featureEngineVersion, inputs: evaluation.inputs, passed: evaluation.passed, score: evaluation.score, regime: input.snapshot.regime, marketSessions: input.snapshot.marketSessions },
    scannerScore: evaluation.score,
    featureSnapshotId: input.snapshot.id,
    eligibilityEvaluationId: input.entryGate.eligibilityEvaluationId ?? input.snapshot.id,
    expiresAt: addMs(input.now, policy.candidateTtlMs),
    dedupeKey,
    strategyVersionIds: [],
  };

  // Our own footprint can never be the reason (D26, INV-11); the aggregate-metric trigger honours the suppression window.
  const self = selfInfluenceCheck({ assetId: input.snapshot.assetId, evidenceSignatures: [], evidenceWallets: [], usesAggregateMetrics: true }, input.selfInfluence);
  if (!self.allowed) {
    return { kind: 'REJECTED', candidate: { ...base, status: 'REJECTED', deterministicRejectionReason: self.reason as ReasonCode }, evaluation, reason: self.reason as ReasonCode };
  }
  if (!input.entryGate.allowed) {
    const reason = (input.entryGate.reason ?? 'NOT_ELIGIBLE') as ReasonCode;
    return { kind: 'REJECTED', candidate: { ...base, status: 'REJECTED', deterministicRejectionReason: reason }, evaluation, reason };
  }
  return { kind: 'CANDIDATE', candidate: { ...base, status: 'DETECTED', deterministicRejectionReason: null }, evaluation };
}

export function detectMomentumCandidate(input: DetectorInput): DetectorDecision {
  const { warm, cold } = isWarm(input.snapshot, input.spec);
  if (!warm) return { kind: 'SKIP', reason: 'FEATURES_COLD', detail: cold.join(',') };
  const evaluation = evaluateMomentumTrigger(input.snapshot, input.policy, input.solRelativeReturn1h);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };
  return completeDetection(input, 'MOMENTUM_CONTINUATION', input.policy, evaluation);
}

/** §9.4: the catalyst must be fresh, trusted and novel, and the market must confirm; the catalyst id is recorded on the candidate. */
export function detectCatalystCandidate(input: CatalystDetectorInput): DetectorDecision {
  const evaluation = evaluateCatalystTrigger(input.events, input.snapshot, input.policy, input.now);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };
  const decision = completeDetection(input, 'CATALYST_RESPONSE', input.policy, evaluation);
  if (decision.kind === 'SKIP') return decision;
  return { ...decision, candidate: { ...decision.candidate, triggerDetails: { ...decision.candidate.triggerDetails, catalystEvidenceId: evaluation.catalystEvidenceId } } };
}

/** §9.3: independent tracked buyers accumulating with structure confirming; owned wallets were excluded upstream (INV-11). */
export function detectSmartMoneyCandidate(input: SmartMoneyDetectorInput): DetectorDecision {
  const evaluation = evaluateSmartMoneyTrigger(input.flow, input.snapshot, input.policy);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };
  return completeDetection(input, 'SMART_MONEY_ACCUMULATION', input.policy, evaluation);
}

/** §12.1 S4: two independent families aligned inside the window; the hybrid never dedupes against the families it is built from. */
export function detectHybridCandidate(input: HybridDetectorInput): DetectorDecision {
  const evaluation = evaluateHybridTrigger(input.signals, input.policy, input.now);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };
  const decision = completeDetection({ ...input, openCandidates: input.openCandidates.filter((c) => c.dedupeKey.includes(':HYBRID') || c.dedupeKey.includes(':' + 'HOLDER_LIQUIDITY_EXPANSION')) }, 'HOLDER_LIQUIDITY_EXPANSION', input.policy, evaluation);
  if (decision.kind === 'SKIP') return decision;
  return { ...decision, candidate: { ...decision.candidate, triggerDetails: { ...decision.candidate.triggerDetails, families: evaluation.families } } };
}

export function detectEarlyAccelerationCandidate(input: EarlyAccelerationDetectorInput): DetectorDecision {
  const { warm, cold } = isWarm(input.snapshot, input.spec);
  if (!warm) return { kind: 'SKIP', reason: 'FEATURES_COLD', detail: cold.join(',') };
  const evaluation = evaluateEarlyAccelerationTrigger(input.snapshot, input.policy, input.solRelativeReturn1h);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };
  return completeDetection(input, 'EARLY_ACCELERATION', input.policy, evaluation);
}
