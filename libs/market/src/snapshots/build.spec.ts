import { addMs, toInstant, type Candle, type Uuid } from '@sol-agent-trader/contracts';
import { buildMarketSnapshot } from './build.js';

const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const ID = '33333333-3333-4333-8333-333333333333' as Uuid;
const AS_OF = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));

/** n closed 1m candles ending at asOf-1m with a linear close ramp. */
function ramp(n: number, startClose = 100, step = 1, volume = 10): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const bucketTime = addMs(AS_OF, -(n - i) * 60_000);
    const close = startClose + i * step;
    return { assetId: ASSET, provider: 'BIRDEYE', resolution: '1m', bucketTime, observedAt: AS_OF, provenance: 'LIVE', open: close - step, high: close + 1, low: close - step - 1, close, volumeUsd: volume, tradeCount: null };
  });
}

describe('market snapshot builder (§6.5, point-in-time)', () => {
  it('derives returns, volumes, ATR, volatility and relative volume from closed candles only', () => {
    const candles = ramp(300);
    const s = buildMarketSnapshot({ id: ID, assetId: ASSET, asOf: AS_OF, observedAt: AS_OF, provenance: 'LIVE', overview: null, candles1m: candles });
    const last = candles.at(-1)!;
    expect(s.priceUsd).toBe(last.close);
    expect(s.returns.m1).toBeCloseTo(last.close / candles.at(-2)!.close - 1, 12);
    expect(s.returns.h1).toBeCloseTo(last.close / candles.at(-61)!.close - 1, 12);
    expect(s.returns.h4).toBeCloseTo(last.close / candles.at(-241)!.close - 1, 12);
    expect(s.volumeUsd.m5).toBe(50);
    expect(s.volumeUsd.m15).toBe(150);
    expect(s.atr).toBeCloseTo(3, 12); // high-low = 3 on the ramp, exceeds the close gaps
    expect(s.realizedVolatility).toBeGreaterThan(0);
    expect(s.relativeVolume).toBe(1);
    expect(s.returns.s15).toBeNull();
    expect(s.volumeUsd.h24).toBeNull();
    expect(s.routeProbes).toEqual([]);
  });

  it('never sees the future: candles at or after asOf are ignored, and missing history is null, not zero', () => {
    const candles = [...ramp(3), { ...ramp(1)[0]!, bucketTime: AS_OF, close: 999 }, { ...ramp(1)[0]!, bucketTime: addMs(AS_OF, 60_000), close: 999 }];
    const s = buildMarketSnapshot({ id: ID, assetId: ASSET, asOf: AS_OF, observedAt: AS_OF, provenance: 'REPLAY', overview: null, candles1m: candles });
    expect(s.priceUsd).toBe(102);
    expect(s.returns.m5).toBeNull();
    expect(s.returns.h1).toBeNull();
    expect(s.volumeUsd.m5).toBeNull();
    expect(s.atr).toBeNull();
    expect(s.realizedVolatility).toBeNull();
    expect(s.relativeVolume).toBeNull();
  });

  it('a stale last candle yields no price rather than a stale one; a current overview price fills in', () => {
    const old = ramp(10).map((c) => ({ ...c, bucketTime: addMs(c.bucketTime, -60 * 60_000) }));
    const s = buildMarketSnapshot({ id: ID, assetId: ASSET, asOf: AS_OF, observedAt: AS_OF, provenance: 'LIVE', overview: null, candles1m: old });
    expect(s.priceUsd).toBeNull();
    const overview = {
      mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never,
      symbol: 'X', name: 'X', decimals: 6, priceUsd: 5, liquidityUsd: 1000, marketCapUsd: null, fdvUsd: null, holderCount: null, numberMarkets: null,
      lastTradeAt: AS_OF, providerUpdatedAt: addMs(AS_OF, -30_000), observedAt: AS_OF,
      windows: Object.fromEntries(['m30', 'h1', 'h2', 'h4', 'h8', 'h24'].map((w) => [w, { volumeUsd: w === 'h24' ? 777 : null, buyVolumeUsd: null, sellVolumeUsd: null, tradeCount: null, buyCount: null, sellCount: null, uniqueWallets: null, priceChangePct: null }])) as never,
    };
    const s2 = buildMarketSnapshot({ id: ID, assetId: ASSET, asOf: AS_OF, observedAt: AS_OF, provenance: 'LIVE', overview, candles1m: old });
    expect(s2.priceUsd).toBe(5);
    expect(s2.liquidityUsd).toBe(1000);
    expect(s2.volumeUsd.h24).toBe(777);
    expect(s2.volumeUsd.h1).toBeNull();
  });

  it('SOL-relative return is own 1h return minus SOL 1h return when both exist', () => {
    const own = ramp(61, 100, 1);
    const sol = ramp(61, 200, 0);
    const s = buildMarketSnapshot({ id: ID, assetId: ASSET, asOf: AS_OF, observedAt: AS_OF, provenance: 'LIVE', overview: null, candles1m: own, solCandles1m: sol });
    expect(s.solRelativeReturn).toBeCloseTo(160 / 100 - 1 - 0, 12);
  });
});
