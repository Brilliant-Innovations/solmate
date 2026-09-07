import { addMs, type Candidate, type FeatureSnapshot, type Instant, type Proposal, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';

/**
 * S0 deterministic proposer (blueprint §12.1, §11.6). No LLM: the proposal is a typed rendering
 * of the momentum trigger that produced the candidate. It carries no amount and no destination
 * (D3, D4); size is the risk core's output. Identical for RAW and SAFE, which is what makes the
 * gate's value measurable.
 */

export interface S0ProposeInput {
  id: Uuid;
  actionCycleId: Uuid;
  candidate: Candidate;
  snapshot: FeatureSnapshot;
  strategy: Pick<StrategyVersion, 'versionId' | 'maxCandidateAgeMs'>;
  now: Instant;
  cutoffVersion: number;
}

export function proposeS0Entry(input: S0ProposeInput): Proposal {
  const { candidate, snapshot } = input;
  const f = snapshot.features;
  const num = (name: string) => (typeof f[name] === 'number' ? (f[name] as number) : null);
  const expiresAt = candidate.expiresAt < addMs(input.now, input.strategy.maxCandidateAgeMs) ? candidate.expiresAt : addMs(input.now, input.strategy.maxCandidateAgeMs);
  const thesis = `Momentum continuation: ret_15m=${fmt(num('ret_15m'))} rel_volume_60=${fmt(num('rel_volume_60'))} ema_9_over_21=${fmt(num('ema_9_over_21'))} scanner_score=${candidate.scannerScore}`;
  return {
    id: input.id,
    actionCycleId: input.actionCycleId,
    candidateId: candidate.id,
    positionId: null,
    strategyVersionId: input.strategy.versionId,
    source: 'DETERMINISTIC',
    proposal: {
      actionType: 'ENTER',
      direction: 'LONG',
      candidateId: candidate.id,
      positionId: null,
      strategyVersionId: input.strategy.versionId,
      skillVersionId: null,
      triggerId: candidate.id,
      thesis,
      supportingEvidenceIds: [snapshot.id, candidate.eligibilityEvaluationId],
      contradictingEvidenceIds: [],
      catalystNovelty: null,
      expectedHorizonMinutes: 240,
      confidence: Math.max(0, Math.min(1, candidate.scannerScore / 100)),
      invalidation: 'Deterministic stop per risk policy; momentum trigger conditions no longer hold',
      requestedFractionToReduce: null,
      protectionIntent: null,
      urgency: 'normal',
      expiresAt,
      reasoningSummary: `S0 deterministic rule ${String(candidate.triggerDetails['policyVersion'] ?? '')} on feature engine ${snapshot.featureEngineVersion}`,
      evidenceCutoffVersion: input.cutoffVersion,
    },
    createdAt: input.now,
    expiresAt,
  };
}

function fmt(v: number | null): string {
  return v === null ? 'null' : v.toPrecision(4);
}
