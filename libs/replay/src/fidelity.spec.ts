import { addMs, fixtures, type Candle, type Instant, type ReplayDecision, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { coreMetrics, decisionsDigest, disciplineFor, guardedCandles, incrementalValue, latencyCost, observationLagReport, SimulatedClock, type ClosedTrade, type GuardContext } from './index.js';

/**
 * Regression tests for the replay-fidelity defects found by the adversarial review of 2026-09-09:
 * the dataset cutoff that could never bind (H-1), the latency counters that were structurally zero
 * (M-8, M-9), the digest blind to candidate pairing (M-11), risk refusals credited to the model as
 * filtering skill (M-12), and SOL-denominated fees that never reached any reported number (M-14).
 */

const T0 = fixtures.T0 as Instant;
const RAW = 'S0_RAW@1.0.0' as VersionId;
const AI = 'S1@1.0.0' as VersionId;
const CUTOFF = addMs(T0, 24 * 3_600_000);

const ctx = (now: Instant, discipline: 'SOURCE_TIME' | 'OBSERVED_TIME'): GuardContext => ({ clock: new SimulatedClock(now), datasetCutoff: CUTOFF, observationDiscipline: discipline });

function candle(bucketMinutes: number, observedMinutes: number): Candle & { observedAt: Instant } {
  return {
    assetId: '40000000-0000-4000-8000-000000000000' as Uuid,
    provider: 'birdeye',
    resolution: '1m',
    bucketTime: addMs(T0, bucketMinutes * 60_000),
    observedAt: addMs(T0, observedMinutes * 60_000),
    provenance: 'BACKFILL',
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volumeUsd: 10,
    tradeCount: 3,
  } as unknown as Candle & { observedAt: Instant };
}

describe('observation discipline (§18.1, review H-1)', () => {
  // The engine's own lag is 5 s, so a bucket at T+0 is source-visible from T+65 s.
  const lagMs = 5_000;
  const live = candle(0, 1); // observed at bucket close, inside the availability lag
  const backfilled = candle(0, 180); // observed three hours after its bucket

  it('Level A reads a backfilled candle from its source time; Level B waits for the observation', () => {
    const at = addMs(T0, 10 * 60_000);
    expect(guardedCandles('candles', [backfilled], 60_000, lagMs, at, ctx(at, 'SOURCE_TIME'))).toHaveLength(1);
    expect(guardedCandles('candles', [backfilled], 60_000, lagMs, at, ctx(at, 'OBSERVED_TIME'))).toHaveLength(0);
    // Once the observation moment passes, Level B sees it too.
    const later = addMs(T0, 200 * 60_000);
    expect(guardedCandles('candles', [backfilled], 60_000, lagMs, later, ctx(later, 'OBSERVED_TIME'))).toHaveLength(1);
  });

  it('a promptly observed candle is visible under both disciplines, and neither shows one before its bucket closes', () => {
    const at = addMs(T0, 10 * 60_000);
    for (const d of ['SOURCE_TIME', 'OBSERVED_TIME'] as const) expect(guardedCandles('candles', [live], 60_000, lagMs, at, ctx(at, d))).toHaveLength(1);
    const tooEarly = addMs(T0, 30_000);
    for (const d of ['SOURCE_TIME', 'OBSERVED_TIME'] as const) expect(guardedCandles('candles', [live], 60_000, lagMs, tooEarly, ctx(tooEarly, d))).toHaveLength(0);
  });

  it('the fidelity level, and only the fidelity level, chooses the discipline', () => {
    expect(disciplineFor('A_HISTORICAL')).toBe('SOURCE_TIME');
    expect(disciplineFor('B_CAPTURED')).toBe('OBSERVED_TIME');
    expect(disciplineFor('C_LIVE_PAPER')).toBe('OBSERVED_TIME');
  });

  it('reports how much of a series was observed later than its source time', () => {
    const r = observationLagReport([live, backfilled, candle(1, 1.5)], 60_000, lagMs);
    expect(r).toMatchObject({ total: 3, withObservedAt: 3, lateObserved: 1 });
    expect(r.maxLagMs).toBe(180 * 60_000 - 65_000);
  });
});

// --- decisions digest ------------------------------------------------------------------------------

const decision = (over: Partial<ReplayDecision> & Pick<ReplayDecision, 'candidateId' | 'strategyVersionId' | 'at'>): ReplayDecision => ({
  id: '20000000-0000-4000-8000-000000000000' as Uuid,
  runId: '10000000-0000-4000-8000-000000000001' as Uuid,
  variant: 'FULL',
  assetId: '40000000-0000-4000-8000-000000000000' as Uuid,
  sample: 'IN_SAMPLE',
  cycleState: 'CLEARED',
  action: 'ENTER',
  proposerConfidence: null,
  adversaryVerdict: null,
  reasonCodes: [],
  decisionLatencyMs: 0,
  rejection: null,
  fill: null,
  outcome: null,
  ...over,
});

describe('decisions digest sees the candidate pairing (review M-11)', () => {
  const c1 = 'c1000000-0000-4000-8000-000000000000' as Uuid;
  const c2 = 'c2000000-0000-4000-8000-000000000000' as Uuid;
  // Same rows, same moments, same strategies — only which decisions belong to the same opportunity
  // differs. `incrementalValue` pairs on exactly that, so the digest must not be blind to it.
  const paired = [decision({ candidateId: c1, strategyVersionId: RAW, at: T0 }), decision({ candidateId: c1, strategyVersionId: AI, at: T0 })];
  const split = [decision({ candidateId: c1, strategyVersionId: RAW, at: T0 }), decision({ candidateId: c2, strategyVersionId: AI, at: T0 })];

  it('separates two runs whose pairings differ', async () => {
    expect(await decisionsDigest(paired)).not.toBe(await decisionsDigest(split));
  });

  it('still matches a re-run that minted fresh candidate and row ids', async () => {
    const rerun = paired.map((d) => ({ ...d, id: '90000000-0000-4000-8000-000000000009' as Uuid, candidateId: 'cf000000-0000-4000-8000-000000000000' as Uuid }));
    expect(await decisionsDigest(rerun)).toBe(await decisionsDigest(paired));
  });
});

// --- incremental value -----------------------------------------------------------------------------

describe('risk refusals are not AI filtering (review M-12)', () => {
  const cand = 'c1000000-0000-4000-8000-000000000000' as Uuid;
  const filled = { inputAmount: '100', outputAmount: '1', executionShortfallBps: null, feesBaseUnits: '0', executedAt: T0 };
  const baselineLoser = decision({ candidateId: cand, strategyVersionId: RAW, at: T0, fill: filled, outcome: { closedAt: addMs(T0, 60_000), realizedPnlBaseUnits: '-5000000', holdMs: 60_000, exitReason: 'HARD_STOP', targetHit: false } });

  it('a candidate the strategy wanted but risk refused lands in its own bucket, not AI_FILTERED_LOSER', () => {
    const riskRefused = decision({ candidateId: cand, strategyVersionId: AI, at: T0, cycleState: 'REJECTED', action: 'ENTER', rejection: 'RISK:SLEEVE_CAPACITY_EXCEEDED' });
    const v = incrementalValue([baselineLoser, riskRefused], RAW, AI, 0, 1e6);
    expect(v.byCategory.AI_FILTERED_LOSER.count).toBe(0);
    expect(v.byCategory.RISK_BLOCKED_AI.count).toBe(1);
    expect(v.riskBlocked).toBe(1);
    // Excluded from the denominator too, so the headline expectancy is not diluted by a non-decision.
    expect(v.candidates).toBe(0);
    expect(v.incrementalNetExpectancy).toBeNull();
  });

  it('a candidate the strategy itself passed on is still credited as filtering', () => {
    const passed = decision({ candidateId: cand, strategyVersionId: AI, at: T0, cycleState: 'REJECTED', action: null, rejection: 'GATE_BLOCKED' });
    const v = incrementalValue([baselineLoser, passed], RAW, AI, 0, 1e6);
    expect(v.byCategory.AI_FILTERED_LOSER.count).toBe(1);
    expect(v.riskBlocked).toBe(0);
    expect(v.candidates).toBe(1);
  });
});

// --- latency -----------------------------------------------------------------------------------------

describe('latency counters state what the data cannot produce (review M-8, M-9)', () => {
  const rows = [decision({ candidateId: 'c1000000-0000-4000-8000-000000000000' as Uuid, strategyVersionId: AI, at: T0, decisionLatencyMs: 3_000 })];

  it('marks chase and stale-quote unreachable when the submission delay is inside one bar', () => {
    const l = latencyCost(rows, AI, RAW, 1e6, { dataResolutionMs: 60_000, submissionDelayMs: 1_500, latencyMatchedMs: null });
    expect(l.structurallyUnreachable).toEqual(expect.arrayContaining(['CHASE_EXCEEDED', 'QUOTE_STALE']));
  });

  it('refuses to report edge lost to latency when the latency difference is smaller than one bar', () => {
    const matched = [{ ...rows[0]!, variant: 'LATENCY_MATCHED' as const }];
    const l = latencyCost([...rows, ...matched], AI, RAW, 1e6, { dataResolutionMs: 60_000, submissionDelayMs: 1_500, latencyMatchedMs: 4_000 });
    expect(l.structurallyUnreachable).toContain('EDGE_LOST_TO_LATENCY');
    expect(l.edgeLostToLatency).toBeNull();
  });

  it('reports it once the difference exceeds one bar', () => {
    const matched = [{ ...rows[0]!, variant: 'LATENCY_MATCHED' as const }];
    const l = latencyCost([...rows, ...matched], AI, RAW, 1e6, { dataResolutionMs: 60_000, submissionDelayMs: 1_500, latencyMatchedMs: 300_000 });
    expect(l.structurallyUnreachable).not.toContain('EDGE_LOST_TO_LATENCY');
    expect(l.edgeLostToLatency).toBe(0);
  });

  it('says nothing about reachability when the run did not supply its cost model', () => {
    expect(latencyCost(rows, AI, RAW, 1e6).structurallyUnreachable).toEqual([]);
  });
});

// --- SOL-denominated fees ---------------------------------------------------------------------------

describe('network and priority fees reach the reported numbers (review M-14)', () => {
  const t: ClosedTrade = {
    id: 't1',
    strategyVersionId: RAW,
    assetId: 'a',
    candidateId: 'c',
    openedAt: T0,
    closedAt: addMs(T0, 60_000),
    cost: 100,
    proceeds: 110,
    fees: 0,
    feesLamports: 50_000,
    slippageCost: 0,
    executionShortfallBps: null,
    executionPath: 'JUPITER_ORDER',
    exitReason: 'TARGET_REACHED',
    decisionToFillMs: 2_000,
    attributes: { candidateFamily: null, regime: null, sessions: [], tokenAgeBand: null, liquidityBand: null, marketCapBand: null, relativeVolumeBand: null, smartMoneyPresent: null, newsCatalystPresent: null, socialAccelerationPresent: null, proposerConfidence: null, adversaryVerdict: null },
  };
  const window = { from: T0, to: addMs(T0, 3_600_000) };

  it('charges them into net P&L at the supplied SOL price and says it did', () => {
    const m = coreMetrics({ trades: [t], failedExecutions: 0, startingEquity: 1_000, window, solPriceSettlement: 200 });
    expect(m.grossPnl).toBe(10);
    expect(m.feesLamports).toBe(50_000);
    expect(m.feesLamportsAsSettlement).toBeCloseTo(0.01, 9);
    expect(m.netPnl).toBeCloseTo(9.99, 9);
    expect(m.netIncludesSolFees).toBe(true);
  });

  it('reports them separately, and says net excludes them, when no SOL price was available', () => {
    const m = coreMetrics({ trades: [t], failedExecutions: 0, startingEquity: 1_000, window });
    expect(m.feesLamports).toBe(50_000);
    expect(m.feesLamportsAsSettlement).toBeNull();
    expect(m.netIncludesSolFees).toBe(false);
    expect(m.netPnl).toBe(10);
  });

  it('a failed-execution rate over a stream with no attempt at all is unknown, not zero', () => {
    expect(coreMetrics({ trades: [], failedExecutions: 0, startingEquity: 1_000, window }).failedExecutionRate).toBeNull();
    expect(coreMetrics({ trades: [t], failedExecutions: 1, startingEquity: 1_000, window }).failedExecutionRate).toBeCloseTo(0.5, 9);
  });
});
