import { addMs, CONFIDENCE_BINS, confidenceBin, fixtures, type Instant, type ReplayDecision, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { attributeBy, calibration, compareStrategies, coreMetrics, disagreementAttribution, economicPnl, incrementalValue, latencyCost, unionDurationMs, type ClosedTrade } from '../index.js';

const T0 = fixtures.T0 as Instant;
const RAW = 'S0_RAW@1.0.0' as VersionId;
const S1 = 'S1@1.0.0' as VersionId;
const window = { from: T0, to: addMs(T0, 24 * 3_600_000) };

function trade(i: number, over: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: `t${i}`,
    strategyVersionId: RAW,
    assetId: 'asset',
    candidateId: `c${i}`,
    openedAt: addMs(T0, i * 3_600_000),
    closedAt: addMs(T0, i * 3_600_000 + 1_800_000),
    cost: 100,
    proceeds: 110,
    fees: 1,
    slippageCost: 0.5,
    executionShortfallBps: 20,
    executionPath: 'JUPITER_ORDER',
    exitReason: 'TARGET_REACHED',
    decisionToFillMs: 4_000,
    attributes: { candidateFamily: 'MOMENTUM_CONTINUATION', regime: 'RISK_ON_TREND', sessions: ['US'], tokenAgeBand: '1d–7d', liquidityBand: '100k–500k', marketCapBand: null, relativeVolumeBand: '3x+', smartMoneyPresent: false, newsCatalystPresent: null, socialAccelerationPresent: false, proposerConfidence: null, adversaryVerdict: null },
    ...over,
  };
}

function decision(i: number, strategy: VersionId, over: Partial<ReplayDecision> = {}): ReplayDecision {
  return {
    id: `1000000${i}-0000-4000-8000-00000000000${strategy === RAW ? 1 : 2}` as Uuid,
    runId: '10000000-0000-4000-8000-000000000000' as Uuid,
    strategyVersionId: strategy,
    variant: 'FULL',
    at: addMs(T0, i * 60_000),
    candidateId: `c000000${i}-0000-4000-8000-000000000000` as Uuid,
    assetId: 'a0000000-0000-4000-8000-000000000000' as Uuid,
    sample: 'IN_SAMPLE',
    cycleState: 'CLEARED',
    action: 'ENTER',
    proposerConfidence: null,
    adversaryVerdict: null,
    reasonCodes: [],
    decisionLatencyMs: strategy === RAW ? 5 : 2_500,
    rejection: null,
    fill: { inputAmount: '100000000', outputAmount: '1', executionShortfallBps: 10, feesBaseUnits: '1000000', executedAt: addMs(T0, i * 60_000 + 2_000) },
    outcome: { closedAt: addMs(T0, i * 60_000 + 600_000), realizedPnlBaseUnits: '10000000', holdMs: 600_000, exitReason: 'TARGET_REACHED', targetHit: true },
    ...over,
  };
}
const rejected = (i: number, strategy: VersionId, verdict: 'REJECT' | 'CHALLENGE' = 'REJECT', codes: string[] = ['THESIS_WEAK']) => decision(i, strategy, { cycleState: 'REJECTED', action: null, adversaryVerdict: verdict, reasonCodes: codes, fill: null, outcome: null });
const lost = (i: number, strategy: VersionId, rejection: string) => decision(i, strategy, { rejection, fill: null, outcome: null });

describe('§19.1 core metrics', () => {
  it('computes P&L, ratios, drawdown, time in market and execution stats from the trade rows', () => {
    const trades = [trade(0), trade(1, { proceeds: 90, executionShortfallBps: 80, executionPath: 'DIRECT_POOL_RPC' }), trade(2, { proceeds: 120, executionShortfallBps: null }), trade(3, { proceeds: 95, decisionToFillMs: null })];
    const m = coreMetrics({ trades, failedExecutions: 1, startingEquity: 1_000, window, minSampleForRatios: 4 });
    expect(m.trades).toBe(4);
    expect(m.grossPnl).toBeCloseTo(15);
    expect(m.fees).toBe(4);
    expect(m.netPnl).toBeCloseTo(11);
    expect(m.winRate).toBe(0.5);
    expect(m.averageWinner).toBeCloseTo(14);
    expect(m.averageLoser).toBeCloseTo(-8.5);
    expect(m.expectancy).toBeCloseTo(2.75);
    expect(m.profitFactor).toBeCloseTo(28 / 17);
    expect(m.maxDrawdown).toBeCloseTo(11);
    expect(m.maxDrawdownFraction).toBeCloseTo(11 / 1_009);
    expect(m.timeInMarketMs).toBe(4 * 1_800_000);
    expect(m.timeInMarketFraction).toBeCloseTo((4 * 1_800_000) / (24 * 3_600_000));
    expect(m.turnover).toBeCloseTo(815);
    expect(m.executionShortfallBps).toBeCloseTo(40);
    expect(m.executionShortfallByPath).toEqual({ JUPITER_ORDER: { trades: 2, meanBps: 20 }, DIRECT_POOL_RPC: { trades: 1, meanBps: 80 } });
    expect(m.failedExecutionRate).toBeCloseTo(0.2);
    expect(m.averageDecisionToFillMs).toBe(4_000);
    expect(m.sharpe).not.toBeNull();
    expect(m.sortino).not.toBeNull();
    expect(m.tailLoss).toBeCloseTo(-11);
    const small = coreMetrics({ trades: trades.slice(0, 2), failedExecutions: 0, startingEquity: 0, window });
    expect(small.sharpe).toBeNull();
    expect(small.maxDrawdownFraction).toBeCloseTo(11 / 9);
    expect(coreMetrics({ trades: [], failedExecutions: 0, startingEquity: 100, window }).winRate).toBeNull();
  });

  it('time in market does not double count overlapping positions', () => {
    expect(unionDurationMs([[0, 10], [5, 15], [20, 25], [24, 30]])).toBe(15 + 10);
  });

  it('§19.2 attribution groups by every dimension and flags under-sampled groups', () => {
    const trades = [trade(0), trade(1, { attributes: { ...trade(1).attributes, sessions: ['ASIA', 'ASIA_EUROPE_OVERLAP'], proposerConfidence: 0.72 } })];
    const bySession = attributeBy({ trades, failedExecutions: 0, startingEquity: 100, window }, 'session', confidenceBin, 1);
    expect(bySession.map((g) => g.key)).toEqual(['ASIA', 'ASIA_EUROPE_OVERLAP', 'US']);
    const byConf = attributeBy({ trades, failedExecutions: 0, startingEquity: 100, window }, 'confidenceBin', confidenceBin);
    expect(byConf.map((g) => [g.key, g.metrics.trades, g.sampleSupported])).toEqual([['0.70–0.79', 1, false], ['unknown', 1, false]]);
    expect(attributeBy({ trades, failedExecutions: 0, startingEquity: 100, window }, 'durationBand', confidenceBin)[0]!.key).toBe("30m–2h");
  });
});

describe('§19.3 / §11.14 / §14.2 attribution over replay decisions', () => {
  const scale = 1_000_000;
  const decisions: ReplayDecision[] = [
    decision(1, RAW), decision(1, S1, { adversaryVerdict: 'CONFIRM', proposerConfidence: 0.8 }),
    decision(2, RAW, { outcome: { ...decision(2, RAW).outcome!, realizedPnlBaseUnits: '-5000000', targetHit: false } }), rejected(2, S1),
    decision(3, RAW), rejected(3, S1, 'REJECT', ['LIQUIDITY_THIN']),
    rejected(4, RAW), decision(4, S1, { adversaryVerdict: 'CHALLENGE', proposerConfidence: 0.55, outcome: { ...decision(4, S1).outcome!, realizedPnlBaseUnits: '2000000', targetHit: false } }),
    rejected(5, RAW), rejected(5, S1),
    decision(6, RAW), lost(6, S1, 'CHASE_EXCEEDED'),
    decision(7, RAW), decision(7, S1, { cycleState: 'EXPIRED', action: null, fill: null, outcome: null }),
    decision(8, S1, { variant: 'LATENCY_MATCHED' }), decision(8, RAW, { variant: 'LATENCY_MATCHED', outcome: { ...decision(8, RAW).outcome!, realizedPnlBaseUnits: '4000000' } }), decision(8, RAW),
    decision(9, S1, { variant: 'PROPOSER_ONLY', outcome: { ...decision(9, S1).outcome!, realizedPnlBaseUnits: '-3000000' } }),
  ];

  it('incremental value pairs baseline and AI decisions on the same candidates', () => {
    const v = incrementalValue(decisions, RAW, S1, 1.5, scale);
    expect(v.candidates).toBe(8);
    expect(v.byCategory.BOTH_TRADED.count).toBe(1);
    expect(v.byCategory.AI_FILTERED_LOSER).toEqual({ count: 1, baselineNet: -5, aiNet: 0 });
    expect(v.byCategory.AI_REJECTED_WINNER.count).toBe(4);
    expect(v.byCategory.AI_ADMITTED_NOT_BASELINE).toEqual({ count: 1, baselineNet: 0, aiNet: 2 });
    expect(v.byCategory.BOTH_PASSED.count).toBe(1);
    expect(v.baselineNetTotal).toBeCloseTo(10 - 5 + 10 + 10 + 10 + 10);
    expect(v.aiNetTotal).toBeCloseTo(12);
    expect(v.incrementalNetExpectancy).toBeCloseTo((12 - 45 - 1.5) / 8);
  });

  it('disagreement attribution reports verdict mix, expectancy by verdict, rejected counterfactuals and the proposer-only shadow', () => {
    const d = disagreementAttribution(decisions, S1, RAW, scale);
    expect([d.reviewed, d.confirmed, d.challenged, d.rejected]).toEqual([5, 1, 1, 3]);
    expect(d.disagreementRate).toBeCloseTo(0.8);
    expect(d.expectancyAfterConfirm).toBe(10);
    expect(d.expectancyAfterChallenge).toBe(2);
    expect(d.rejectedWithCounterfactual).toBe(2);
    expect(d.rejectedCounterfactualNet).toBeCloseTo(-5 + 10);
    expect(d.topObjections).toEqual([{ code: "THESIS_WEAK", count: 2 }, { code: 'LIQUIDITY_THIN', count: 1 }]);
    expect(d.proposerOnlyNet).toBe(-3);
    expect(d.fullNet).toBe(12);
  });

  it('latency cost counts expiry and chase losses, what the baseline made on them, and the latency-matched gap', () => {
    const l = latencyCost(decisions, S1, RAW, scale);
    expect([l.expiredByLatency, l.chaseRejected, l.staleQuoteRejected]).toEqual([1, 1, 0]);
    expect(l.missedBaselineNet).toBe(20);
    expect(l.averageDecisionLatencyMs).toBe(2_500);
    expect(l.edgeLostToLatency).toBeCloseTo(12 - 10);
    const b = latencyCost(decisions, RAW, RAW, scale);
    expect(b.edgeLostToLatency).toBeCloseTo(45 - 4);
  });

  it('calibration bins confidence against the defined target and scores it', () => {
    const c = calibration(decisions, S1, 'NET_PNL_POSITIVE_AT_CLOSE', confidenceBin, CONFIDENCE_BINS.map((b) => b.label), scale);
    expect(c.scored).toBe(2);
    expect(c.bins.find((b) => b.label === '0.80–0.89')).toEqual({ label: '0.80–0.89', count: 1, meanConfidence: 0.8, hitRate: 1, realizedExpectancy: 10 });
    expect(c.bins.find((b) => b.label === '0.50–0.59')).toEqual({ label: '0.50–0.59', count: 1, meanConfidence: 0.55, hitRate: 0, realizedExpectancy: 2 });
    expect(c.brierScore).toBeCloseTo((0.2 ** 2 + 0.55 ** 2) / 2);
    expect(confidenceBin(0.95)).toBe('0.90+');
    expect(confidenceBin(0.1)).toBe('<0.50');
  });

  it('strategy comparison keeps S0_RAW and S0_SAFE as separate rows and splits by holdout', () => {
    const SAFE = 'S0_SAFE@1.0.0' as VersionId;
    const trades = [{ ...trade(0), sample: 'IN_SAMPLE' as const }, { ...trade(1, { strategyVersionId: SAFE }), sample: 'HOLD_OUT' as const }];
    const rows = compareStrategies(trades, { [RAW]: 2 }, 1_000, window, true);
    expect(rows.map((r) => `${r.strategyVersionId}:${r.sample}:${r.metrics.trades}`)).toEqual(['S0_RAW@1.0.0:ALL:1', 'S0_RAW@1.0.0:IN_SAMPLE:1', 'S0_RAW@1.0.0:HOLD_OUT:0', 'S0_SAFE@1.0.0:ALL:1', 'S0_SAFE@1.0.0:IN_SAMPLE:0', 'S0_SAFE@1.0.0:HOLD_OUT:1']);
    expect(rows[0]!.metrics.failedExecutionRate).toBeCloseTo(2 / 3);
  });
});

describe('§19.4 / D37 three-layer economic P&L', () => {
  it('subtracts direct strategy costs, then the allocated platform run-rate', () => {
    const p = economicPnl({
      window: { from: T0, to: addMs(T0, 15 * 86_400_000) },
      strategies: [
        { strategyVersionId: RAW, tradingNetUsd: 100, turnoverUsd: 3_000, direct: { modelUsd: 0, dataUsd: 4, rpcUsd: 1 } },
        { strategyVersionId: S1, tradingNetUsd: 60, turnoverUsd: 1_000, direct: { modelUsd: 30, dataUsd: 4, rpcUsd: 1 } },
      ],
      platformMonthlyUsd: 84,
      allocation: 'BY_TURNOVER',
    });
    expect(p.windowDays).toBe(15);
    expect(p.platformCostForWindowUsd).toBe(42);
    expect(p.rows[0]).toMatchObject({ tradingNetUsd: 100, directCostUsd: 5, strategyEconomicUsd: 95, platformShareUsd: 31.5, platformEconomicUsd: 63.5, costToEdgeRatio: 0.05 });
    expect(p.rows[1]).toMatchObject({ directCostUsd: 35, strategyEconomicUsd: 25, platformShareUsd: 10.5, platformEconomicUsd: 14.5 });
    expect(p.totals.platformEconomicUsd).toBeCloseTo(78);
    const equal = economicPnl({ window: { from: T0, to: addMs(T0, 30 * 86_400_000) }, strategies: [{ strategyVersionId: RAW, tradingNetUsd: -10, turnoverUsd: 0, direct: { modelUsd: 0, dataUsd: 0, rpcUsd: 0 } }], platformMonthlyUsd: 84, allocation: 'EQUAL' });
    expect(equal.rows[0]).toMatchObject({ platformShareUsd: 84, platformEconomicUsd: -94, costToEdgeRatio: null });
  });
});
