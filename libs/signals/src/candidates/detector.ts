import { addMs, instantToMs, type Candidate, type FeatureEngineSpec, type FeatureSnapshot, type Instant, type MomentumTriggerPolicy, type ReasonCode, type Uuid } from '@sol-agent-trader/contracts';
import { selfInfluenceCheck, type SelfInfluenceContext } from '../self-influence/guard.js';
import { evaluateMomentumTrigger, type MomentumEvaluation } from '../triggers/momentum.js';

/**
 * Candidate detection (blueprint §6.9, §9.1, §9.7, §8.6, D63, ADR-0007). Pure decision over a
 * feature snapshot and the state the scanner already knows. Order of checks:
 *   1. warm-up: a required indicator that is still cold means no scoring at all (D63);
 *   2. the deterministic trigger;
 *   3. dedupe (an open candidate for the same asset and family inside the window) and cooldown
 *      (a recent rejection/expiry) — silent skips, not records;
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

export interface DetectorInput {
  newId: () => Uuid;
  now: Instant;
  snapshot: FeatureSnapshot;
  spec: FeatureEngineSpec;
  policy: MomentumTriggerPolicy;
  solRelativeReturn1h: number | null;
  entryGate: EntryGateInput;
  selfInfluence: SelfInfluenceContext;
  /** Open (non-terminal) candidates for this asset and family. */
  openCandidates: readonly Pick<Candidate, 'dedupeKey' | 'discoveredAt'>[];
  /** Newest terminal (REJECTED/EXPIRED) candidate time for this asset and family, if any. */
  lastTerminalAt: Instant | null;
}

export type DetectorDecision =
  | { kind: 'CANDIDATE'; candidate: Candidate; evaluation: MomentumEvaluation }
  | { kind: 'REJECTED'; candidate: Candidate; evaluation: MomentumEvaluation; reason: ReasonCode }
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

export function detectMomentumCandidate(input: DetectorInput): DetectorDecision {
  const family: Candidate['triggerFamily'] = 'MOMENTUM_CONTINUATION';
  const { warm, cold } = isWarm(input.snapshot, input.spec);
  if (!warm) return { kind: 'SKIP', reason: 'FEATURES_COLD', detail: cold.join(',') };

  const evaluation = evaluateMomentumTrigger(input.snapshot, input.policy, input.solRelativeReturn1h);
  if (!evaluation.fires) return { kind: 'SKIP', reason: 'NO_TRIGGER', detail: evaluation.failed.map((f) => `${f.condition}:${f.reason}`).join(',') || `score ${evaluation.score} < ${input.policy.minScannerScore}` };

  const dedupeKey = dedupeKeyFor(input.snapshot.assetId, family, input.now, input.policy.dedupeWindowMs);
  const windowStart = instantToMs(input.now) - input.policy.dedupeWindowMs;
  const duplicate = input.openCandidates.find((c) => c.dedupeKey === dedupeKey || instantToMs(c.discoveredAt) >= windowStart);
  if (duplicate) return { kind: 'SKIP', reason: 'DEDUPED', detail: duplicate.dedupeKey };
  if (input.lastTerminalAt !== null && instantToMs(input.now) - instantToMs(input.lastTerminalAt) < input.policy.cooldownMs) {
    return { kind: 'SKIP', reason: 'COOLDOWN', detail: input.lastTerminalAt };
  }

  const base: Omit<Candidate, 'status' | 'deterministicRejectionReason'> = {
    id: input.newId(),
    assetId: input.snapshot.assetId,
    discoveredAt: input.now,
    triggerFamily: family,
    triggerDetails: { policyVersion: input.policy.version, featureEngineVersion: input.snapshot.featureEngineVersion, inputs: evaluation.inputs, passed: evaluation.passed, score: evaluation.score },
    scannerScore: evaluation.score,
    featureSnapshotId: input.snapshot.id,
    eligibilityEvaluationId: input.entryGate.eligibilityEvaluationId ?? input.snapshot.id,
    expiresAt: addMs(input.now, input.policy.candidateTtlMs),
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
