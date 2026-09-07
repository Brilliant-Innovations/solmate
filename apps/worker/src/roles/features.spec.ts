import { addMs, FEATURE_ENGINE_V1, fixedClock, toInstant, type AssetEligibility, type Candle, type FeatureSnapshot, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { featureAsOf, runFeaturesCycle, type FeaturesRepo } from './features.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 12, 0, 37));
const ASOF = toInstant(Date.UTC(2026, 8, 8, 12, 0, 0));
const A = '22222222-2222-4222-8222-222222222222' as Uuid;
const B = '33333333-3333-4333-8333-333333333333' as Uuid;

function candles(assetId: Uuid, n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const bucketTime = addMs(ASOF, -(n - i) * 60_000);
    const close = 1 + i * 0.001;
    return { assetId, provider: 'BIRDEYE', resolution: '1m' as const, bucketTime, observedAt: bucketTime, provenance: 'LIVE' as const, open: close, high: close * 1.001, low: close * 0.999, close, volumeUsd: 500, tradeCount: 5 };
  });
}

class MemoryRepo implements FeaturesRepo {
  snapshots: FeatureSnapshot[] = [];
  constructor(
    private readonly assets: { id: Uuid; mintAddress: string; lastFeatureAsOf: Instant | null }[],
    private readonly bars: Record<string, Candle[]>,
    private readonly eligibility: Record<string, Pick<AssetEligibility, 'liquidityUsd' | 'priceImpactProbes' | 'settlementRouteConfirmed'>> = {},
  ) {}
  async listAssetsForFeatures() {
    return this.assets;
  }
  async loadCandles(assetId: Uuid, _r: '1m', from: Instant, to: Instant) {
    return (this.bars[assetId] ?? []).filter((c) => c.bucketTime >= from && c.bucketTime <= to);
  }
  async latestEligibility(assetId: Uuid) {
    return this.eligibility[assetId] ?? null;
  }
  async latestMarketSnapshotId() {
    return '44444444-4444-4444-8444-444444444444' as Uuid;
  }
  async insertFeatureSnapshot(s: FeatureSnapshot) {
    this.snapshots.push(s);
  }
}
const deps = (repo: MemoryRepo) => ({ repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), spec: FEATURE_ENGINE_V1, config: { batchSize: 100 } });

describe('features role (§6.8, D62, D63)', () => {
  it('computes one point-in-time vector per asset at the closed-minute boundary, links the market snapshot and labels sessions; warm and cold are counted', async () => {
    const repo = new MemoryRepo([{ id: A, mintAddress: 'a', lastFeatureAsOf: null }, { id: B, mintAddress: 'b', lastFeatureAsOf: null }], { [A]: candles(A, 300), [B]: candles(B, 20) }, { [A]: { liquidityUsd: 1_000_000, priceImpactProbes: [], settlementRouteConfirmed: true } });
    expect(featureAsOf(NOW)).toBe(ASOF);
    const r = await runFeaturesCycle(deps(repo));
    expect(r).toMatchObject({ assets: 2, computed: 2, warm: 1, cold: 1, skippedCurrent: 0, errors: [] });
    const a = repo.snapshots.find((s) => s.assetId === A)!;
    expect(a.asOf).toBe(ASOF);
    expect(a.featureEngineVersion).toBe('features-v1');
    expect(a.marketSnapshotId).toBe('44444444-4444-4444-8444-444444444444');
    expect(a.marketSessions).toEqual(['EUROPE']); // 12:00 UTC is Europe only (US opens 13:00 UTC)
    expect(a.features['liquidity_usd']).toBe(1_000_000);
    expect(a.features['ret_1h']).not.toBeNull();
    const b = repo.snapshots.find((s) => s.assetId === B)!;
    expect(b.features['ret_1h']).toBeNull();
    expect(b.features['liquidity_usd']).toBeNull();
  });

  it('an asset already current for this minute is skipped; an asset without candles is cold and gets no snapshot; one failure does not stop the cycle', async () => {
    const repo = new MemoryRepo([{ id: A, mintAddress: 'a', lastFeatureAsOf: ASOF }, { id: B, mintAddress: 'b', lastFeatureAsOf: null }], { [A]: candles(A, 300) });
    const r = await runFeaturesCycle(deps(repo));
    expect(r).toMatchObject({ assets: 2, computed: 0, skippedCurrent: 1, cold: 1, errors: [] });
    expect(repo.snapshots).toHaveLength(0);
    const failing = new MemoryRepo([{ id: A, mintAddress: 'a', lastFeatureAsOf: null }, { id: B, mintAddress: 'b', lastFeatureAsOf: null }], { [A]: candles(A, 300), [B]: candles(B, 300) });
    failing.loadCandles = async (assetId: Uuid) => {
      if (assetId === A) throw new Error('boom');
      return candles(B, 300);
    };
    const r2 = await runFeaturesCycle(deps(failing));
    expect(r2.errors).toEqual([{ assetId: A, error: 'boom' }]);
    expect(r2.computed).toBe(1);
  });
});
