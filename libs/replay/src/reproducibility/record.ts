import { canonicalHash, modelWeightLookAhead, type Instant, type ReplayDecision, type ReplayModelDisclosure, type ReplayRun, type ReplayWindow, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Reproducibility record (blueprint §18.5). A run's decisions are digested in a canonical order
 * so that two runs over the same inputs, versions and seed prove their equality by one hash, and
 * any changed decision changes it. Model disclosures are derived, never hand-written: the
 * look-ahead label comes from the training cutoff and the window.
 */

export function orderDecisions(decisions: readonly ReplayDecision[]): ReplayDecision[] {
  const key = (d: ReplayDecision) => `${d.at}|${d.strategyVersionId}|${d.variant}|${d.assetId}|${d.cycleState}|${d.reasonCodes.join(',')}`;
  return [...decisions].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Digest over the decision content; row ids, run ids and the run-scoped synthetic candidate ids are excluded so a re-run with fresh ids still matches (a candidate is identified by its asset and discovery moment). */
export async function decisionsDigest(decisions: readonly ReplayDecision[]): Promise<Sha256Hex> {
  const rows = orderDecisions(decisions).map((d) => {
    const { id: _id, runId: _runId, candidateId: _candidateId, ...content } = d;
    return content;
  });
  return canonicalHash(rows);
}

export async function resultsDigest(results: unknown): Promise<Sha256Hex> {
  return canonicalHash(results);
}

export function disclosures(models: readonly { role: string; model: string; trainingCutoff: Instant | null }[], window: ReplayWindow): ReplayModelDisclosure[] {
  return models.map((m) => ({ role: m.role, model: m.model, trainingCutoff: m.trainingCutoff, lookAhead: modelWeightLookAhead(m.trainingCutoff, window) }));
}

export type NewReplayRun = Omit<ReplayRun, 'status' | 'startedAt' | 'completedAt' | 'decisionsDigest' | 'resultsDigest' | 'error' | 'models'> & {
  models: readonly { role: string; model: string; trainingCutoff: Instant | null }[];
};

export function newReplayRun(input: NewReplayRun): ReplayRun {
  return {
    ...input,
    models: disclosures(input.models, input.window),
    status: 'QUEUED',
    startedAt: null,
    completedAt: null,
    decisionsDigest: null,
    resultsDigest: null,
    error: null,
  };
}

/** In-sample or hold-out under the run's forward holdout protocol. */
export function sampleOf(window: ReplayWindow, at: Instant): 'IN_SAMPLE' | 'HOLD_OUT' {
  return window.inSampleUntil !== null && at > window.inSampleUntil ? 'HOLD_OUT' : 'IN_SAMPLE';
}

export interface ReproducibilityCheck {
  reproduced: boolean;
  expected: Sha256Hex;
  actual: Sha256Hex;
  runId: Uuid;
}

export async function checkReproduced(run: ReplayRun, rerunDecisions: readonly ReplayDecision[]): Promise<ReproducibilityCheck> {
  if (run.decisionsDigest === null) throw new Error(`run ${run.id} has no decisions digest to reproduce`);
  const actual = await decisionsDigest(rerunDecisions);
  return { reproduced: actual === run.decisionsDigest, expected: run.decisionsDigest, actual, runId: run.id };
}
