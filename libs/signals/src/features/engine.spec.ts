import fc from 'fast-check';
import { addMs, FEATURE_ENGINE_V1, toInstant, type Candle, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { computeFeatures, contiguousClosedBars, warmupStatus } from './engine.js';
import { ema, rsi, simpleReturn } from './indicators.js';

const ASOF = toInstant(Date.UTC(2026, 8, 8, 12, 0, 0));
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const ID = '11111111-1111-4111-8111-111111111111' as Uuid;

/** `n` contiguous closed 1m candles ending just before asOf; price follows `priceAt(i)` for i = 0..n-1 (oldest first). */
function candles(n: number, priceAt: (i: number) => number, volumeAt: (i: number) => number = () => 1000, endAt: Instant = ASOF): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const bucketTime = addMs(endAt, -(n - i) * 60_000);
    const close = priceAt(i);
    const open = i === 0 ? close : priceAt(i - 1);
    out.push({ assetId: ASSET, provider: 'BIRDEYE', resolution: '1m', bucketTime, observedAt: bucketTime, provenance: 'LIVE', open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volumeUsd: volumeAt(i), tradeCount: 10 });
  }
  return out;
}

const base = (c: Candle[], over: Partial<Parameters<typeof computeFeatures>[0]> = {}) => ({
  id: ID, assetId: ASSET, asOf: ASOF, provenance: 'LIVE' as const, candles1m: c, overview: null,
  eligibility: { liquidityUsd: 250_000, priceImpactProbes: [{ sizeUsd: 100, inputAmount: '1' as never, impactBps: 12 as never, routeFound: true, probedAt: ASOF }, { sizeUsd: 1000, inputAmount: '1' as never, impactBps: 80 as never, routeFound: true, probedAt: ASOF }, { sizeUsd: 5000, inputAmount: '1' as never, impactBps: null, routeFound: false, probedAt: ASOF }], settlementRouteConfirmed: true },
  marketSnapshotId: null, marketSessions: ['US' as const], selfInfluenceSuppressed: false, spec: FEATURE_ENGINE_V1, ...over,
});

describe('feature engine (§8.1–8.3, D63 warm-up, point-in-time)', () => {
  it('D63: with too little history every required indicator is null and the engine reports which are cold; nothing is coerced to zero', () => {
    const r = computeFeatures(base(candles(10, (i) => 1 + i * 0.01)));
    expect(r.warmup.ready).toBe(false);
    expect(r.warmup.cold).toEqual(expect.arrayContaining(['ret_1h', 'atr_14_pct', 'rsi_14', 'ema_9_over_21', 'rel_volume_60', 'breakout_20']));
    expect(r.warmup.contiguousBuckets).toBe(10);
    for (const f of r.warmup.cold) expect(r.snapshot.features[f]).toBeNull();
    // Short-lookback features are present; the liquidity block comes from eligibility, not candles.
    expect(r.snapshot.features['ret_5m']).not.toBeNull();
    expect(r.snapshot.features['liquidity_usd']).toBe(250_000);
    expect(r.snapshot.features['impact_bps_small']).toBe(12);
    expect(r.snapshot.features['impact_bps_large']).toBe(80);
    expect(r.snapshot.features['route_found_share']).toBeCloseTo(2 / 3);
    expect(r.snapshot.features['sell_route_confirmed']).toBe(1);
    expect(r.snapshot.featureEngineVersion).toBe('features-v1');
  });

  it('with the full lookback the engine is warm and a steady uptrend reads as one: positive returns, RSI above 50, fast EMA over slow, breakout, persistence', () => {
    const r = computeFeatures(base(candles(300, (i) => 1 + i * 0.002)));
    expect(r.warmup.ready).toBe(true);
    expect(r.warmup.cold).toEqual([]);
    const f = r.snapshot.features;
    expect(f['ret_1h']).toBeGreaterThan(0);
    expect(f['ret_4h']).toBeGreaterThan(0);
    expect(f['rsi_14']).toBeGreaterThan(50);
    expect(f['ema_9_over_21']).toBeGreaterThan(0);
    expect(f['ema_21_over_50']).toBeGreaterThan(0);
    expect(f['breakout_20']).toBe(1);
    expect(f['trend_persistence_20']).toBe(1);
    expect(f['drawdown_from_high_60']).toBeLessThanOrEqual(0);
    expect(f['bb_location_20']).toBeGreaterThan(0.5);
    expect(f['rel_volume_60']).toBeCloseTo(1);
    expect(Object.keys(f).length).toBe(FEATURE_ENGINE_V1.requiredForScoring.length + Object.keys(f).length - FEATURE_ENGINE_V1.requiredForScoring.length);
    for (const name of Object.keys(FEATURE_ENGINE_V1.lookbackBuckets)) expect(f).toHaveProperty(name);
  });

  it('point-in-time: candles that close after asOf are ignored, and a gap truncates the contiguous run so long-lookback indicators go cold again', () => {
    const c = candles(300, (i) => 1 + i * 0.002);
    const future = candles(5, () => 99, () => 1, addMs(ASOF, 5 * 60_000));
    const r = computeFeatures(base([...c, ...future]));
    expect(r.snapshot.features['ret_1m']).toBeLessThan(0.01);
    const withGap = c.filter((x) => x.bucketTime !== c[250]!.bucketTime);
    const g = computeFeatures(base(withGap));
    expect(g.warmup.contiguousBuckets).toBe(49);
    expect(g.warmup.ready).toBe(false);
    expect(g.snapshot.features['ret_1h']).toBeNull();
    expect(contiguousClosedBars(withGap, ASOF)).toHaveLength(49);
  });

  it('property: every feature is null or finite; warm-up is monotone in history length; null eligibility leaves the liquidity block null', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 320 }), fc.double({ min: 0.5, max: 200, noNaN: true }), (n, p0) => {
        const r = computeFeatures(base(candles(n, (i) => p0 * (1 + Math.sin(i / 7) * 0.02)), { eligibility: null }));
        for (const v of Object.values(r.snapshot.features)) expect(v === null || Number.isFinite(v)).toBe(true);
        expect(r.snapshot.features['liquidity_usd']).toBeNull();
        expect(r.snapshot.features['sell_route_confirmed']).toBeNull();
        const shorter = warmupStatus(contiguousClosedBars(candles(Math.max(0, n - 1), () => p0), ASOF), FEATURE_ENGINE_V1);
        expect(shorter.cold.length).toBeGreaterThanOrEqual(r.warmup.cold.length);
      }),
    );
  });

  it('indicator arithmetic: RSI is 100 on pure gains, 0 on pure losses, 50 when flat; EMA and returns need their full lookback', () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    expect(rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(0);
    expect(rsi(new Array(15).fill(3))).toBe(50);
    expect(rsi([1, 2, 3])).toBeNull();
    expect(ema([1, 2, 3], 5)).toBeNull();
    expect(ema([2, 2, 2, 2, 2], 5)).toBe(2);
    expect(simpleReturn([1, 2], 1)).toBe(1);
    expect(simpleReturn([1, 2], 2)).toBeNull();
    expect(simpleReturn([0, 2], 1)).toBeNull();
  });
});
