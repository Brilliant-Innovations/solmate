import { addMs, DEFAULT_CALIBRATION_TARGET, fixtures, type Instant, type ReplayDecision, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { ExecutionFailureSampler, latencyMatchedDecisionAt, modelledExecutionAt, seededRandom } from '../cost/model.js';
import { checkReproduced, decisionsDigest, newReplayRun, orderDecisions, sampleOf } from './record.js';
import { DEFAULT_REPLAY_COST_MODEL } from '@sol-agent-trader/contracts';

const T0 = fixtures.T0 as Instant;
const RUN = '10000000-0000-4000-8000-000000000001' as Uuid;
const window = { from: T0, to: addMs(T0, 3_600_000), datasetCutoff: addMs(T0, 3_600_000), inSampleUntil: addMs(T0, 1_800_000) };

function decision(i: number, over: Partial<ReplayDecision> = {}): ReplayDecision {
  return {
    id: `2000000${i}-0000-4000-8000-000000000000` as Uuid,
    runId: RUN,
    strategyVersionId: 'S0_SAFE@1.0.0' as VersionId,
    variant: 'FULL',
    at: addMs(T0, i * 60_000),
    candidateId: `3000000${i}-0000-4000-8000-000000000000` as Uuid,
    assetId: '40000000-0000-4000-8000-000000000000' as Uuid,
    sample: 'IN_SAMPLE',
    cycleState: 'CLEARED',
    action: 'ENTER',
    proposerConfidence: null,
    adversaryVerdict: 'CONFIRM',
    reasonCodes: [],
    decisionLatencyMs: 5,
    rejection: null,
    fill: null,
    outcome: null,
    ...over,
  };
}

describe('reproducibility record (§18.5)', () => {
  it('digest is order-independent and id-independent, and changes with any decision', async () => {
    const a = [decision(1), decision(2), decision(3)];
    const b = [decision(3, { id: '2fffffff-0000-4000-8000-000000000000' as Uuid }), decision(1), decision(2)];
    const da = await decisionsDigest(a);
    expect(await decisionsDigest(b)).toBe(da);
    expect(await decisionsDigest([decision(1), decision(2), decision(3, { reasonCodes: ['CANDIDATE_STALE'] })])).not.toBe(da);
    expect(orderDecisions(b).map((d) => d.at)).toEqual(a.map((d) => d.at));
  });

  it('a run records derived model disclosures and the holdout split labels decisions', async () => {
    const run = newReplayRun({
      id: RUN,
      name: 'S0 gate value, week 1',
      fidelity: 'B_CAPTURED',
      requestedBy: null,
      window,
      strategyVersionIds: ['S0_RAW@1.0.0', 'S0_SAFE@1.0.0'] as VersionId[],
      baselineStrategyVersionId: 'S0_RAW@1.0.0' as VersionId,
      versions: { gitSha: 'abcdef1' as never, contractSetDigest: 'a'.repeat(64) as Sha256Hex, featureEngineVersion: 'features-v1' as VersionId, riskPolicyVersion: 'risk-v1' as VersionId, gatePolicyVersion: 's0-gate-v1' as VersionId, costModelVersion: DEFAULT_REPLAY_COST_MODEL.version, promptVersions: {}, modelSelections: {}, providerDatasetVersions: { birdeye: 'ohlcv-v3' }, skillVersionId: null, guidelineVersionId: null },
      models: [
        { role: 'proposer', model: 'claude-sonnet-5', trainingCutoff: addMs(T0, 1) },
        { role: 'adversary', model: 'gpt-5', trainingCutoff: addMs(T0, -1) },
        { role: 'tool:news', model: 'unknown', trainingCutoff: null },
      ],
      seed: 7,
      latencyMatchedBaseline: true,
      proposerOnlyShadow: true,
      calibrationTarget: DEFAULT_CALIBRATION_TARGET,
      createdAt: T0,
    });
    expect(run.status).toBe('QUEUED');
    expect(run.models.map((m) => m.lookAhead)).toEqual(['POST_WINDOW', 'WITHIN_WINDOW', 'UNKNOWN']);
    expect(sampleOf(window, addMs(T0, 1_800_000))).toBe('IN_SAMPLE');
    expect(sampleOf(window, addMs(T0, 1_800_001))).toBe('HOLD_OUT');
    const done = { ...run, decisionsDigest: await decisionsDigest([decision(1)]) };
    expect((await checkReproduced(done, [decision(1, { id: '2eeeeeee-0000-4000-8000-000000000000' as Uuid })])).reproduced).toBe(true);
    expect((await checkReproduced(done, [decision(2)])).reproduced).toBe(false);
  });

  it('seeded failure draws repeat exactly for the same seed and differ across seeds', () => {
    const a = new ExecutionFailureSampler(42, 0.5);
    const b = new ExecutionFailureSampler(42, 0.5);
    const seqA = Array.from({ length: 20 }, () => a.sample());
    const seqB = Array.from({ length: 20 }, () => b.sample());
    expect(seqA).toEqual(seqB);
    expect(seqA.map((s) => s.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const other = Array.from({ length: 20 }, seededRandom(43));
    expect(other).not.toEqual(seqA.map((s) => s.draw));
    expect(new ExecutionFailureSampler(1, 0).sample().failed).toBe(false);
    expect(modelledExecutionAt(T0, DEFAULT_REPLAY_COST_MODEL)).toBe(addMs(T0, DEFAULT_REPLAY_COST_MODEL.decisionLatencyMs + DEFAULT_REPLAY_COST_MODEL.fill.submissionDelayMs));
    expect(latencyMatchedDecisionAt(T0, 2_500)).toBe(addMs(T0, 2_500));
  });
});
