import { addMs, DEFAULT_CALIBRATION_TARGET, DEFAULT_ELIGIBILITY_POLICY, DEFAULT_MARKET_REGIME_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_REPLAY_COST_MODEL, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, FEATURE_ENGINE_V2, type AssetEligibility, type Candle, type Instant, type MintAddress, type ReplayRun, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { newReplayRun } from '@sol-agent-trader/replay';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import { runReplay } from './engine.js';
import { s0ReplayStrategy } from './strategies.js';
import type { ReplayDataset, ReplayEngineDeps } from './types.js';

/**
 * Engine regressions from the adversarial review of 2026-09-09.
 *
 *   H-8 — a position that becomes unquotable used to be skipped: no closed trade, no outcome, no
 *   loss, while equity kept carrying it at its last pre-rug mark. The single worst outcome the
 *   system exists to survive scored as neither a loss nor a trade.
 *   M-13 — a `WINDOW_END` close bypassed the adapter, so every position still open at window end
 *   was liquidated at the last mark with no adverse allowance, no fees and no failure draw.
 *   E1 — the reported cost basis was reconstructed by rescaling the remaining basis, which drifts
 *   once a partial reduction floors its share.
 */

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = '2026-09-01T00:00:00.000Z' as Instant;
const ASSET = 'a0000000-0000-4000-8000-000000000001' as Uuid;
const MINT = 'TestMint1111111111111111111111111111111111' as MintAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const RUN = '10000000-0000-4000-8000-000000000002' as Uuid;
const MIN = 60_000;
const RAW = s0StrategyVersion('RAW', 'abcdef1', T0);

/**
 * Flat warm-up, a momentum burst that triggers an entry, then `after` decides what the rest of the
 * window looks like: a gentle drift that keeps the position open to the end, or a collapse to a
 * price so small that no size has an executable output — a token that stops trading.
 */
function candles(after: 'DRIFT_UP' | 'UNQUOTABLE'): Candle[] {
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
    } else if (after === 'DRIFT_UP') {
      close *= 1.0002;
      volume = 3000;
    } else if (i < 271) {
      close *= 1.001;
      volume = 3000;
    } else {
      // Below 5e-13 the settlement output floors to zero at any size: no route, at any price.
      close = 1e-13;
      volume = 1;
      range = 0;
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

function dataset(after: 'DRIFT_UP' | 'UNQUOTABLE'): ReplayDataset {
  const elig: AssetEligibility[] = [];
  for (let i = 0; i < 37; i++) elig.push(eligibility(addMs(T0, i * 10 * MIN), i));
  return {
    assets: [{ id: ASSET, mint: MINT, symbol: 'TEST', decimals: 6, tokenProgram: 'TOKEN' }],
    candles: new Map([[ASSET, candles(after)]]),
    eligibility: new Map([[ASSET, elig]]),
    quoteProbes: new Map(),
    events: [],
    memberships: [{ assetId: ASSET, cohortId: 'c0000000-0000-4000-8000-000000000001' as Uuid, cohortName: 'test-cohort' }],
    recorded: [],
    solReturn1h: new Map(),
    universe: { requested: null, selected: 1, available: 1, truncated: false, selectionRule: 'test' },
    solPriceSettlement: 200,
  };
}

function run(): ReplayRun {
  return newReplayRun({
    id: RUN,
    name: 'fidelity regressions',
    fidelity: 'A_HISTORICAL',
    requestedBy: null,
    window: { from: T0, to: addMs(T0, 6 * 60 * MIN), datasetCutoff: addMs(T0, 6 * 60 * MIN), inSampleUntil: null },
    strategyVersionIds: [RAW.versionId],
    baselineStrategyVersionId: RAW.versionId,
    versions: { gitSha: 'abcdef1' as never, contractSetDigest: 'a'.repeat(64) as Sha256Hex, featureEngineVersion: FEATURE_ENGINE_V2.version, riskPolicyVersion: DEFAULT_RISK_POLICY.version, gatePolicyVersion: DEFAULT_S0_SAFETY_GATE_POLICY.version, costModelVersion: DEFAULT_REPLAY_COST_MODEL.version, promptVersions: {}, modelSelections: {}, providerDatasetVersions: { test: 'synthetic' }, skillVersionId: null, guidelineVersionId: null },
    models: [],
    seed: 7,
    latencyMatchedBaseline: false,
    proposerOnlyShadow: false,
    calibrationTarget: DEFAULT_CALIBRATION_TARGET,
    createdAt: T0,
  });
}

function deps(after: 'DRIFT_UP' | 'UNQUOTABLE'): ReplayEngineDeps {
  return {
    run: run(),
    dataset: dataset(after),
    strategies: [s0ReplayStrategy('RAW', RAW, DEFAULT_S0_SAFETY_GATE_POLICY)],
    policies: { featureSpec: FEATURE_ENGINE_V2, momentum: DEFAULT_MOMENTUM_TRIGGER_POLICY, gate: DEFAULT_S0_SAFETY_GATE_POLICY, risk: DEFAULT_RISK_POLICY, costModel: { ...DEFAULT_REPLAY_COST_MODEL, executionFailureRate: 0 }, eligibility: DEFAULT_ELIGIBILITY_POLICY, regime: DEFAULT_MARKET_REGIME_POLICY },
    account: { settlementMint: USDC, settlementDecimals: 6, startingCapital: '10000000000', virtualSolLamports: '1000000000', sleeveCap: '4000000000', sleeveRiskBudget: '400000000' },
    logger,
  };
}

describe('replay engine fidelity regressions (review 2026-09-09)', () => {
  it('books a position that becomes unquotable as a total loss instead of dropping it (H-8)', async () => {
    const out = await runReplay(deps('UNQUOTABLE'));
    const trades = out.trades;
    expect(trades.length).toBeGreaterThanOrEqual(1);
    const stranded = trades.filter((t) => t.exitReason === 'UNQUOTABLE');
    expect(stranded.length).toBeGreaterThanOrEqual(1);
    // Nothing could be sold, so proceeds are zero and the whole cost basis is the loss.
    for (const t of stranded) {
      expect(t.proceeds).toBe(0);
      expect(t.cost).toBeGreaterThan(0);
    }
    // Every filled decision carries an outcome: no position vanishes from the metrics.
    const filled = out.decisions.filter((d) => d.fill !== null);
    expect(filled.length).toBeGreaterThanOrEqual(1);
    expect(filled.every((d) => d.outcome !== null)).toBe(true);
    // The book no longer carries it at a stale mark: final equity is the settlement balance alone.
    const per = out.perStrategy.find((p) => p.variant === 'FULL')!;
    expect(Number(per.finalEquity)).toBeLessThan(10_000_000_000);
  });

  it('charges a window-end close through the adapter like any other exit (M-13)', async () => {
    const out = await runReplay(deps('DRIFT_UP'));
    const atEnd = out.trades.filter((t) => t.exitReason === 'WINDOW_END' || t.exitReason === 'WINDOW_END_UNFILLED');
    expect(atEnd.length).toBeGreaterThanOrEqual(1);
    // A free liquidation charged no network or priority fee at all; a modelled one always does.
    for (const t of atEnd.filter((x) => x.exitReason === 'WINDOW_END')) expect(t.feesLamports ?? 0).toBeGreaterThan(0);
  });

  it('reports the cost basis recorded at entry, not one reconstructed from what is left (E1)', async () => {
    for (const after of ['DRIFT_UP', 'UNQUOTABLE'] as const) {
      const out = await runReplay(deps(after));
      const byDecision = new Map(out.decisions.filter((d) => d.fill !== null).map((d) => [d.candidateId, d]));
      for (const t of out.trades) {
        const d = byDecision.get((t.candidateId ?? '') as Uuid);
        expect(d, `no filled decision for trade ${t.id}`).toBeDefined();
        // Exact, not approximate: the entry fill's input amount is the cost basis, to the base unit.
        expect(Math.round(t.cost * 1e6)).toBe(Number(d!.fill!.inputAmount));
      }
    }
  });

  it('reports what the dataset could support beside the results (H-1, M-10)', async () => {
    const out = await runReplay(deps('DRIFT_UP'));
    expect(out.dataset.observationDiscipline).toBe('SOURCE_TIME'); // the run declared Level A
    // 359, not 360: the last bucket was observed a second after the dataset cutoff, so the run
    // never held it. That is the cutoff doing its job, and the report counts what was readable.
    expect(out.dataset.candles.total).toBe(359);
    expect(out.dataset.universe).toMatchObject({ selected: 1, available: 1, truncated: false });
    expect(out.dataset.solPriceSettlement).toBe(200);
  });
});
