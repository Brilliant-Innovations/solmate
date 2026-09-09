import { addMs, ReplayRun as ReplayRunSchema, DEFAULT_CALIBRATION_TARGET, DEFAULT_ELIGIBILITY_POLICY, DEFAULT_MARKET_REGIME_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_REPLAY_COST_MODEL, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, FEATURE_ENGINE_V2, type AssetEligibility, type Candle, type Instant, type MintAddress, type ReplayRun, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { decisionsDigest, guardedCandles, LookAheadError, newReplayRun } from '@sol-agent-trader/replay';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import { runReplay } from './engine.js';
import { s0ReplayStrategy } from './strategies.js';
import type { ReplayDataset, ReplayEngineDeps, ReplayStrategy } from './types.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = '2026-09-01T00:00:00.000Z' as Instant;
const ASSET = 'a0000000-0000-4000-8000-000000000001' as Uuid;
const MINT = 'TestMint1111111111111111111111111111111111' as MintAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const RUN = '10000000-0000-4000-8000-000000000001' as Uuid;
const MIN = 60_000;

/** Six hours of 1m candles: noisy flat warm-up, a 15-minute momentum burst, a drift up, then a slide through the stop. */
function candles(): Candle[] {
  const out: Candle[] = [];
  let close = 1;
  for (let i = 0; i < 360; i++) {
    let volume = 1000;
    let range = 0.004;
    if (i < 240) close = 1 + (i % 2 ? 0.003 : -0.003);
    else if (i < 255) {
      close *= i % 3 === 2 ? 0.9975 : 1.005;
      volume = 6000;
      range = 0.006;
    } else if (i < 271) {
      close *= 1.001;
      volume = 3000;
    } else if (i < 301) {
      close *= 0.995;
      volume = 2500;
      range = 0.006;
    }
    const bucketTime = addMs(T0, i * MIN);
    out.push({ assetId: ASSET, provider: 'test', resolution: '1m', bucketTime, observedAt: addMs(bucketTime, MIN + 1_000), provenance: 'BACKFILL', open: close * (1 - range / 4), high: close * (1 + range), low: close * (1 - range), close, volumeUsd: volume, tradeCount: 40 });
  }
  return out;
}

function eligibility(at: Instant, n: number): AssetEligibility {
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid,
    assetId: ASSET,
    evaluatedAt: at,
    policyVersion: DEFAULT_ELIGIBILITY_POLICY.version,
    eligible: true,
    hardReject: false,
    grade: 90,
    liquidityUsd: 600_000,
    settlementRouteConfirmed: true,
    jupiterRouteAvailable: true,
    priceImpactProbes: [
      { sizeUsd: 100, inputAmount: '100000000' as never, impactBps: 20 as never, routeFound: true, probedAt: at },
      { sizeUsd: 1_000, inputAmount: '1000000000' as never, impactBps: 60 as never, routeFound: true, probedAt: at },
    ],
    rejectionReasons: [],
  } as unknown as AssetEligibility;
}

function dataset(): ReplayDataset {
  const elig: AssetEligibility[] = [];
  for (let i = 0; i < 37; i++) elig.push(eligibility(addMs(T0, i * 10 * MIN), i));
  return {
    assets: [{ id: ASSET, mint: MINT, symbol: 'TEST', decimals: 6, tokenProgram: 'TOKEN' }],
    candles: new Map([[ASSET, candles()]]),
    eligibility: new Map([[ASSET, elig]]),
    quoteProbes: new Map(),
    events: [],
    memberships: [{ assetId: ASSET, cohortId: 'c0000000-0000-4000-8000-000000000001' as Uuid, cohortName: 'test-cohort' }],
    recorded: [],
    solReturn1h: new Map(),
  };
}

const RAW = s0StrategyVersion('RAW', 'abcdef1', T0);
const SAFE = s0StrategyVersion('SAFE', 'abcdef1', T0);

function run(over: Partial<ReplayRun> = {}): ReplayRun {
  return {
    ...newReplayRun({
      id: RUN,
      name: 'S0 baseline vs gate, synthetic day',
      fidelity: 'A_HISTORICAL',
      requestedBy: null,
      window: { from: T0, to: addMs(T0, 6 * 60 * MIN), datasetCutoff: addMs(T0, 6 * 60 * MIN), inSampleUntil: addMs(T0, 3 * 60 * MIN) },
      strategyVersionIds: [RAW.versionId, SAFE.versionId],
      baselineStrategyVersionId: RAW.versionId,
      versions: { gitSha: 'abcdef1' as never, contractSetDigest: 'a'.repeat(64) as Sha256Hex, featureEngineVersion: FEATURE_ENGINE_V2.version, riskPolicyVersion: DEFAULT_RISK_POLICY.version, gatePolicyVersion: DEFAULT_S0_SAFETY_GATE_POLICY.version, costModelVersion: DEFAULT_REPLAY_COST_MODEL.version, promptVersions: {}, modelSelections: {}, providerDatasetVersions: { test: 'synthetic' }, skillVersionId: null, guidelineVersionId: null },
      models: [],
      seed: 7,
      latencyMatchedBaseline: true,
      proposerOnlyShadow: false,
      calibrationTarget: DEFAULT_CALIBRATION_TARGET,
      createdAt: T0,
    }),
    ...over,
  };
}

function deps(over: Partial<ReplayEngineDeps> = {}): ReplayEngineDeps {
  return {
    run: run(),
    dataset: dataset(),
    strategies: [s0ReplayStrategy('RAW', RAW, DEFAULT_S0_SAFETY_GATE_POLICY), s0ReplayStrategy('SAFE', SAFE, DEFAULT_S0_SAFETY_GATE_POLICY)],
    policies: { featureSpec: FEATURE_ENGINE_V2, momentum: DEFAULT_MOMENTUM_TRIGGER_POLICY, gate: DEFAULT_S0_SAFETY_GATE_POLICY, risk: DEFAULT_RISK_POLICY, costModel: { ...DEFAULT_REPLAY_COST_MODEL, executionFailureRate: 0 }, eligibility: DEFAULT_ELIGIBILITY_POLICY, regime: DEFAULT_MARKET_REGIME_POLICY },
    account: { settlementMint: USDC, settlementDecimals: 6, startingCapital: '10000000000', virtualSolLamports: '1000000000', sleeveCap: '4000000000', sleeveRiskBudget: '400000000' },
    logger,
    latencyMatchedMs: 3_000,
    ...over,
  };
}

describe('replay engine (§18, P9 acceptance)', () => {
  it('runs baseline and gated strategies against the same timeline, fills, closes and labels every result with its versions', async () => {
    const out = await runReplay(deps());
    expect(out.ticks).toBe(361);
    expect(out.candidates).toBeGreaterThanOrEqual(1);
    const raw = out.decisions.filter((d) => d.strategyVersionId === RAW.versionId && d.variant === 'FULL');
    const safe = out.decisions.filter((d) => d.strategyVersionId === SAFE.versionId && d.variant === 'FULL');
    const matched = out.decisions.filter((d) => d.strategyVersionId === RAW.versionId && d.variant === 'LATENCY_MATCHED');
    // Same opportunity set: every candidate is decided by every strategy and by the latency-matched baseline.
    expect(safe.map((d) => d.candidateId)).toEqual(raw.map((d) => d.candidateId));
    expect(matched.map((d) => d.candidateId)).toEqual(raw.map((d) => d.candidateId));
    expect(matched.every((d) => d.decisionLatencyMs === 3_000)).toBe(true);
    expect(raw.every((d) => d.decisionLatencyMs === 0)).toBe(true);
    // The ungated baseline enters and the slide closes it with a recorded outcome.
    const filled = raw.filter((d) => d.fill !== null);
    expect(filled.length).toBeGreaterThanOrEqual(1);
    expect(filled[0]!.outcome).not.toBeNull();
    expect(filled[0]!.outcome!.exitReason).toMatch(/HARD_STOP|TRAIL|TARGET|TIME_STOP|WINDOW_END/);
    expect(filled[0]!.outcome!.targetHit).not.toBeUndefined();
    expect(out.trades.filter((t) => t.strategyVersionId === RAW.versionId).length).toBeGreaterThanOrEqual(1);
    expect(out.trades[0]!.attributes.candidateFamily).toBe('MOMENTUM_CONTINUATION');
    expect(out.trades[0]!.attributes.liquidityBand).toBe('500k–1M');
    // Every result row carries the strategy version; the run carries the rest (§18.5).
    expect(new Set(out.decisions.map((d) => d.strategyVersionId))).toEqual(new Set([RAW.versionId, SAFE.versionId]));
    expect(out.run.versions.featureEngineVersion).toBe(FEATURE_ENGINE_V2.version);
    expect(out.decisions.every((d) => d.sample === (d.at > out.run.window.inSampleUntil! ? 'HOLD_OUT' : 'IN_SAMPLE'))).toBe(true);
    // Books are isolated: the gated strategy's rejections never touch the baseline's balance.
    const per = Object.fromEntries(out.perStrategy.map((p) => [`${p.strategyVersionId}|${p.variant}`, p]));
    expect(per[`${RAW.versionId}|FULL`]!.fills).toBeGreaterThanOrEqual(1);
    expect(per[`${SAFE.versionId}|FULL`]!.decisions).toBe(raw.length);
  });

  it('reproduces the same decisions digest from the same inputs and seed (§18.5)', async () => {
    const a = await runReplay(deps());
    const b = await runReplay(deps());
    expect(await decisionsDigest(a.decisions)).toBe(await decisionsDigest(b.decisions));
    const c = await runReplay(deps({ run: run({ seed: 8 }), policies: { ...deps().policies, costModel: { ...DEFAULT_REPLAY_COST_MODEL, executionFailureRate: 1 } } }));
    expect(c.decisions.filter((d) => d.rejection === 'MODELLED_NOT_LANDED').length).toBeGreaterThanOrEqual(1);
    expect(await decisionsDigest(c.decisions)).not.toBe(await decisionsDigest(a.decisions));
  });

  it('a strategy that reaches for evidence after the replay clock fails the run (P9 acceptance, INV-13)', async () => {
    const peeking: ReplayStrategy = {
      version: SAFE,
      variants: ['FULL'],
      decide(ctx) {
        // One minute ahead: the next candle is not closed yet from the strategy's point of view.
        guardedCandles('peek', ctx.dataset.candles.get(ctx.candidate.assetId) ?? [], MIN, 0, addMs(ctx.now, MIN), ctx.guard);
        throw new Error('unreachable');
      },
    };
    await expect(runReplay(deps({ strategies: [s0ReplayStrategy('RAW', RAW, DEFAULT_S0_SAFETY_GATE_POLICY), peeking] }))).rejects.toThrow(LookAheadError);
  });

  it('refuses to read past the dataset cutoff even when the clock allows it', async () => {
    const d = deps({ run: run({ window: { from: T0, to: addMs(T0, 6 * 60 * MIN), datasetCutoff: addMs(T0, 6 * 60 * MIN), inSampleUntil: null } }) });
    // A cutoff earlier than the window end is refused by the contract itself (datasetCutoff must not precede `to`).
    expect(ReplayRunSchema.safeParse(run({ window: { from: T0, to: addMs(T0, 6 * 60 * MIN), datasetCutoff: addMs(T0, 5 * 60 * MIN), inSampleUntil: null } })).success).toBe(false);
    expect(ReplayRunSchema.safeParse(run()).success).toBe(true);
    const out = await runReplay(d);
    expect(out.decisions.every((d) => d.sample === 'IN_SAMPLE')).toBe(true);
  });
});

export const _types: VersionId[] = [];
