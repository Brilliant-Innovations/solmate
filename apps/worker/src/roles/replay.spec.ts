import { addMs, DEFAULT_ELIGIBILITY_POLICY, DEFAULT_MARKET_REGIME_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_REPLAY_COST_MODEL, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, FEATURE_ENGINE_V2, fixtures, type Instant, type ReplayDecision, type ReplayRun, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest, ReplayRunRow, ReplayTradeRow } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import type { ReplayDataset, ReplayOutput } from '../replay/types.js';
import { buildResults, runReplayExecutionCycle, runReplayRequestsCycle, strategiesFor, type ReplayRepo, type ReplayRoleDeps } from './replay.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = fixtures.T0 as Instant;
const OP = '11111111-1111-4111-8111-111111111111' as Uuid;
const RAW = s0StrategyVersion('RAW', 'abcdef1', addMs(T0, -86_400_000));
const SAFE = s0StrategyVersion('SAFE', 'abcdef1', addMs(T0, -86_400_000));
const ASSET = 'a0000000-0000-4000-8000-000000000001' as Uuid;

function harness(role: 'operator' | 'viewer' = 'operator') {
  const runs: ReplayRun[] = [];
  const resolved: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  const decisions: ReplayDecision[] = [];
  const trades: ReplayTradeRow[] = [];
  const completed: Record<string, unknown>[] = [];
  const failed: string[] = [];
  let pending: PendingControlRequest[] = [];
  let queued: ReplayRunRow | null = null;
  let counter = 0;
  const repo: ReplayRepo = {
    async listPending() { return pending; },
    async operatorRole() { return role; },
    async resolve(id, state, resolution) { resolved.push({ id, state, resolution }); return true; },
    async insertRun(run) { runs.push(run); },
    async claimQueued() { const q = queued; queued = null; return q; },
    async complete(_id, done) { completed.push(done as unknown as Record<string, unknown>); },
    async fail(_id, error) { failed.push(error); },
    async insertDecisions(rows) { decisions.push(...rows); return rows.length; },
    async insertTrades(rows) { trades.push(...rows); return rows.length; },
  };
  const deps: ReplayRoleDeps = {
    repo,
    clock: { now: () => T0, nowMs: () => Date.parse(T0) },
    logger,
    versions: { gitSha: 'abcdef1', contractSetDigest: 'c'.repeat(64) as Sha256Hex, strategies: { [RAW.versionId]: RAW, [SAFE.versionId]: SAFE }, skillVersionId: null, guidelineVersionId: null, modelCutoffs: {}, providerDatasetVersions: { test: 'v1' } },
    policies: { featureSpec: FEATURE_ENGINE_V2, momentum: DEFAULT_MOMENTUM_TRIGGER_POLICY, gate: DEFAULT_S0_SAFETY_GATE_POLICY, risk: DEFAULT_RISK_POLICY, costModel: DEFAULT_REPLAY_COST_MODEL, eligibility: DEFAULT_ELIGIBILITY_POLICY, regime: DEFAULT_MARKET_REGIME_POLICY },
    account: { settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never, settlementDecimals: 6, startingCapital: '10000000000', virtualSolLamports: '1000000000', sleeveCap: '4000000000', sleeveRiskBudget: '400000000' },
    platformMonthlyUsd: 84,
    loadDataset: async () => emptyDataset(),
    newId: () => `${(++counter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid,
    config: { batchSize: 10, maxWindowMs: 14 * 86_400_000 },
  };
  return { deps, runs, resolved, decisions, trades, completed, failed, setPending: (p: PendingControlRequest[]) => { pending = p; }, setQueued: (q: ReplayRunRow | null) => { queued = q; } };
}

function emptyDataset(): ReplayDataset {
  return { assets: [], candles: new Map(), eligibility: new Map(), quoteProbes: new Map(), events: [], memberships: [], recorded: [], solReturn1h: new Map() };
}

const request = (payload: Record<string, unknown>): PendingControlRequest => ({ id: 'b0000000-0000-4000-8000-000000000001' as Uuid, requestedBy: OP, kind: 'RUN_REPLAY', payload, createdAt: T0 });
const good = { name: 'gate value', fidelity: 'B_CAPTURED', window: { from: addMs(T0, -86_400_000), to: addMs(T0, -3_600_000), inSampleUntil: addMs(T0, -43_200_000) }, strategyVersionIds: [RAW.versionId, SAFE.versionId], baselineStrategyVersionId: RAW.versionId, seed: 3 };

describe('worker replay role (§18.5, P9)', () => {
  it('queues a valid request as a run bound to every current version, with the dataset cutoff at filing time', async () => {
    const h = harness();
    h.setPending([request(good)]);
    const r = await runReplayRequestsCycle(h.deps);
    expect(r.queued).toBe(1);
    const run = h.runs[0]!;
    expect(run.status).toBe('QUEUED');
    expect(run.window.datasetCutoff).toBe(T0);
    expect(run.window.inSampleUntil).toBe(good.window.inSampleUntil);
    expect(run.versions).toMatchObject({ gitSha: 'abcdef1', featureEngineVersion: FEATURE_ENGINE_V2.version, riskPolicyVersion: DEFAULT_RISK_POLICY.version, gatePolicyVersion: DEFAULT_S0_SAFETY_GATE_POLICY.version, costModelVersion: DEFAULT_REPLAY_COST_MODEL.version, providerDatasetVersions: { test: 'v1' } });
    expect(run.seed).toBe(3);
    expect(run.latencyMatchedBaseline).toBe(true);
    expect(h.resolved[0]).toMatchObject({ state: 'ACCEPTED', resolution: { runId: run.id, status: 'QUEUED' } });
  });

  it('refuses viewers, malformed payloads, unknown strategies, a baseline outside the set, future or over-long windows', async () => {
    const v = harness('viewer');
    v.setPending([request(good)]);
    expect((await runReplayRequestsCycle(v.deps)).refused).toEqual({ NOT_AN_OPERATOR: 1 });
    const h = harness();
    h.setPending([request({ ...good, fidelity: 'D' })]);
    expect((await runReplayRequestsCycle(h.deps)).refused).toEqual({ MALFORMED_PAYLOAD: 1 });
    h.setPending([request({ ...good, strategyVersionIds: [RAW.versionId, 'S9@0.0.1'] })]);
    expect((await runReplayRequestsCycle(h.deps)).refused).toEqual({ UNKNOWN_STRATEGY_VERSION: 1 });
    h.setPending([request({ ...good, strategyVersionIds: [SAFE.versionId] })]);
    expect((await runReplayRequestsCycle(h.deps)).refused).toEqual({ BASELINE_NOT_IN_SET: 1 });
    h.setPending([request({ ...good, window: { from: addMs(T0, -3_600_000), to: addMs(T0, 3_600_000), inSampleUntil: null } })]);
    expect((await runReplayRequestsCycle(h.deps)).refused).toEqual({ WINDOW_INVALID: 1 });
    h.setPending([request({ ...good, window: { from: addMs(T0, -20 * 86_400_000), to: addMs(T0, -1), inSampleUntil: null } })]);
    expect((await runReplayRequestsCycle(h.deps)).refused).toEqual({ WINDOW_TOO_LONG: 1 });
    expect(h.runs).toHaveLength(0);
  });

  it('executes a claimed run through the injected engine, stores decisions and trades and completes it with digests', async () => {
    const h = harness();
    h.setPending([request(good)]);
    await runReplayRequestsCycle(h.deps);
    const run = h.runs[0]!;
    const decision: ReplayDecision = { id: 'd0000000-0000-4000-8000-000000000001' as Uuid, runId: run.id, strategyVersionId: RAW.versionId, variant: 'FULL', at: run.window.from, candidateId: 'c0000000-0000-4000-8000-000000000001' as Uuid, assetId: ASSET, sample: 'IN_SAMPLE', cycleState: 'CLEARED', action: 'ENTER', proposerConfidence: null, adversaryVerdict: 'CONFIRM', reasonCodes: [], decisionLatencyMs: 0, rejection: null, fill: { inputAmount: '100000000', outputAmount: '1', executionShortfallBps: 5, feesBaseUnits: '0', executedAt: run.window.from }, outcome: { closedAt: addMs(run.window.from, 600_000), realizedPnlBaseUnits: '5000000', holdMs: 600_000, exitReason: 'TARGET_REACHED', targetHit: true } };
    const out: ReplayOutput = {
      run: { ...run, status: 'RUNNING' },
      decisions: [decision],
      trades: [{ id: 't1', variant: 'FULL', sample: 'IN_SAMPLE', strategyVersionId: RAW.versionId, assetId: ASSET, candidateId: decision.candidateId, openedAt: run.window.from, closedAt: addMs(run.window.from, 600_000), cost: 100, proceeds: 105, fees: 0.1, slippageCost: 0.05, executionShortfallBps: 5, executionPath: 'JUPITER_ORDER', exitReason: 'TARGET_REACHED', decisionToFillMs: 2_000, attributes: { candidateFamily: 'MOMENTUM_CONTINUATION', regime: null, sessions: ['US'], tokenAgeBand: null, liquidityBand: '500k–1M', marketCapBand: null, relativeVolumeBand: '3x–5x', smartMoneyPresent: null, newsCatalystPresent: null, socialAccelerationPresent: null, proposerConfidence: null, adversaryVerdict: 'CONFIRM' } }],
      perStrategy: [{ strategyVersionId: RAW.versionId, variant: 'FULL', decisions: 1, fills: 1, rejections: {}, closedTrades: 1, finalEquity: '10004900000', realizedPnlBaseUnits: '5000000' }],
      candidates: 1,
      ticks: 10,
      dataset: { observationDiscipline: 'OBSERVED_TIME', candles: { total: 10, withObservedAt: 10, lateObserved: 0, medianLagMs: null, maxLagMs: null }, universe: { requested: null, selected: 1, available: 1, truncated: false, selectionRule: 'test' }, solPriceSettlement: 200 },
      latencyMatchedMs: null,
    };
    h.setQueued({ run: { ...run, status: 'RUNNING' }, assetIds: null, controlRequestId: null, results: null });
    const x = await runReplayExecutionCycle({ ...h.deps, execute: async () => out });
    expect(x).toMatchObject({ claimed: true, status: 'COMPLETED', decisions: 1, trades: 1 });
    expect(h.decisions[0]!.runId).toBe(run.id);
    expect(h.trades[0]).toMatchObject({ runId: run.id, variant: 'FULL', sample: 'IN_SAMPLE', exitReason: 'TARGET_REACHED' });
    const done = h.completed[0]!;
    expect(done['decisionsDigest']).toMatch(/^[0-9a-f]{64}$/);
    expect(done['resultsDigest']).toMatch(/^[0-9a-f]{64}$/);
    const results = done['results'] as ReturnType<typeof buildResults>;
    expect(results.comparison.find((c) => c.strategyVersionId === RAW.versionId && c.sample === 'ALL')!.metrics['netPnl']).toBeCloseTo(4.9);
    expect(results.comparison.some((c) => c.sample === 'HOLD_OUT')).toBe(true);
    expect(results.incremental[0]).toMatchObject({ aiStrategyVersionId: SAFE.versionId, baselineStrategyVersionId: RAW.versionId });
    expect(results.economic['rows']).toHaveLength(2);
    expect(Object.keys(results.attribution)).toContain('session');
  });

  it('records an engine failure on the run instead of retrying silently', async () => {
    const h = harness();
    h.setPending([request(good)]);
    await runReplayRequestsCycle(h.deps);
    h.setQueued({ run: { ...h.runs[0]!, status: 'RUNNING' }, assetIds: null, controlRequestId: null, results: null });
    const x = await runReplayExecutionCycle({ ...h.deps, execute: async () => { throw new Error('LookAheadError: peeked'); } });
    expect(x.status).toBe('FAILED');
    expect(h.failed[0]).toContain('peeked');
    expect(h.completed).toHaveLength(0);
  });

  it('builds S0 strategies from their versions and refuses unknown ones', () => {
    const h = harness();
    h.setPending([request(good)]);
    const run = { ...h.runs[0], strategyVersionIds: [RAW.versionId, SAFE.versionId], id: 'r0000000-0000-4000-8000-000000000001' as Uuid } as unknown as ReplayRun;
    const s = strategiesFor(run, h.deps.versions.strategies, h.deps.policies);
    expect(s.map((x) => x.version.strategyId)).toEqual(['S0_RAW', 'S0_SAFE']);
    expect(() => strategiesFor({ ...run, strategyVersionIds: ['S9@1' as never] }, h.deps.versions.strategies, h.deps.policies)).toThrow(/unknown strategy version/);
  });
});
