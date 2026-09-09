import { canonicalHash, modelWeightLookAhead, type Instant, type ReplayDecision, type ReplayModelDisclosure, type ReplayRun, type ReplayWindow, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Reproducibility record (blueprint §18.5). A run's decisions are digested in a canonical order
 * so that two runs over the same inputs, versions and seed prove their equality by one hash, and
 * any changed decision changes it. Model disclosures are derived, never hand-written: the
 * look-ahead label comes from the training cutoff and the window.
 */

/**
 * Run-scoped candidate ids are fresh uuids on every run, so they cannot enter the digest directly.
 * But the pairing they express — which decisions belong to the same opportunity — is exactly what
 * `incrementalValue`, `disagreementAttribution` and `latencyCost` compute over, and a digest blind
 * to it lets two runs with different pairings hash identically (adversarial review 2026-09-09,
 * M-11). Each candidate therefore gets a re-run-stable key: its asset plus the earliest decision
 * moment recorded against it, with an ordinal when two candidates on one asset share that moment.
 */
export function candidateKeys(decisions: readonly ReplayDecision[]): Map<string, string> {
  const first = new Map<string, { assetId: string; at: string }>();
  for (const d of decisions) {
    const cur = first.get(d.candidateId);
    if (!cur || d.at < cur.at) first.set(d.candidateId, { assetId: d.assetId, at: d.at });
  }
  const ordered = [...first.entries()].sort(([, a], [, b]) => (a.at === b.at ? (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) : a.at < b.at ? -1 : 1));
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const [id, { assetId, at }] of ordered) {
    const base = `${assetId}@${at}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(id, n === 0 ? base : `${base}#${n}`);
  }
  return out;
}

export function orderDecisions(decisions: readonly ReplayDecision[]): ReplayDecision[] {
  const keys = candidateKeys(decisions);
  const key = (d: ReplayDecision) => `${d.at}|${d.strategyVersionId}|${d.variant}|${d.assetId}|${keys.get(d.candidateId) ?? ''}|${d.cycleState}|${d.reasonCodes.join(',')}`;
  return [...decisions].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Digest over the decision content. Row ids and run ids are excluded so a re-run with fresh ids
 * still matches; the run-scoped candidate id is replaced by its re-run-stable key rather than
 * dropped, so a run that pairs decisions differently cannot share a digest with this one.
 */
export async function decisionsDigest(decisions: readonly ReplayDecision[]): Promise<Sha256Hex> {
  const keys = candidateKeys(decisions);
  const rows = orderDecisions(decisions).map((d) => {
    const { id: _id, runId: _runId, candidateId, ...content } = d;
    return { ...content, candidateKey: keys.get(candidateId) ?? candidateId };
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
