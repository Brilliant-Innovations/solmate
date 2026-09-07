import { addMs, fixedClock, toInstant, type Candle, type DiscoveredToken, type FeedHealth, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { BIRDEYE_TIERS, BirdeyeClient, bucketsBetween, defaultFreshnessContracts, lastClosedBucket, type HttpResponse, type HttpTransport } from '@sol-agent-trader/market';
import { initialIngestState, runMarketIngestCycle, type MarketRepo } from './market-ingest.js';

/** The role against an in-memory repository and a scripted Birdeye. */
const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 30));
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NEW_MINT = 'So11111111111111111111111111111111111111112';

class MemoryRepo implements MarketRepo {
  assets = new Map<string, { id: Uuid; mintAddress: string }>();
  candles: Candle[] = [];
  snapshots = 0;
  health = new Map<string, FeedHealth>();
  async listTrackedAssets(limit: number) {
    return [...this.assets.values()].slice(0, limit);
  }
  async heldBucketTimes(assetId: Uuid, resolution: Candle['resolution'], from: Instant, to: Instant) {
    return this.candles.filter((c) => c.assetId === assetId && c.resolution === resolution && c.bucketTime >= from && c.bucketTime <= to).map((c) => c.bucketTime);
  }
  async writeCandles(candles: readonly Candle[]) {
    let inserted = 0;
    for (const c of candles) {
      if (!this.candles.some((x) => x.assetId === c.assetId && x.resolution === c.resolution && x.bucketTime === c.bucketTime)) {
        this.candles.push(c);
        inserted++;
      }
    }
    return { inserted, replacedOpen: 0, ignored: candles.length - inserted };
  }
  async loadCandles(assetId: Uuid, resolution: Candle['resolution'], from: Instant, to: Instant) {
    return this.candles.filter((c) => c.assetId === assetId && c.resolution === resolution && c.bucketTime >= from && c.bucketTime <= to);
  }
  async upsertDiscoveredAssets(tokens: readonly DiscoveredToken[]) {
    return tokens.map((t) => {
      const existing = this.assets.get(t.mintAddress);
      if (existing) return existing;
      const created = { id: `${t.mintAddress.slice(0, 8).toLowerCase().replace(/[^0-9a-f]/g, '0')}-0000-4000-8000-000000000000` as Uuid, mintAddress: t.mintAddress };
      this.assets.set(t.mintAddress, created);
      return created;
    });
  }
  async insertSnapshot() {
    this.snapshots++;
  }
  async upsertFeedHealth(h: FeedHealth) {
    this.health.set(h.provider, h);
  }
}

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(json) });
function scriptedByPath(routes: Record<string, () => HttpResponse | Error>): { transport: HttpTransport; hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    transport: async (req) => {
      const path = new URL(req.url).pathname;
      hits.push(path);
      const r = routes[path];
      if (!r) throw new Error(`unscripted ${path}`);
      const out = r();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

function candlesFor(from: Instant, to: Instant): unknown[] {
  return bucketsBetween(from, addMs(to, -60_000), '1m').map((b, i) => ({ o: 1 + i, h: 2 + i, l: 0.5, c: 1.5 + i, v: 1, v_usd: 10, unix_time: Date.parse(b) / 1000, address: MINT, type: '1m', currency: 'usd' }));
}

function deps(repo: MemoryRepo, transport: HttpTransport) {
  const clock = fixedClock(NOW);
  const birdeye = new BirdeyeClient({ apiKey: 'k', tier: BIRDEYE_TIERS.LITE, transport, clock, sleep: async () => undefined });
  return {
    birdeye,
    jupiter: null,
    repo,
    clock,
    logger: createLogger({ service: 'worker', sink: () => undefined }),
    contracts: defaultFreshnessContracts(),
    config: { trackedLimit: 10, lookbackBuckets: { '15s': 240, '1m': 60, '5m': 48, '15m': 32, '1h': 48, '4h': 42 }, discoveryIntervalMs: 300_000, cuBudgetPerCycle: 5000, requestBudgetPerCycle: 50 },
  };
}

describe('market-ingest role (M4 P1: universe populates, candles continuous, stale feed reported)', () => {
  it('first cycle: discovers, backfills the tracked asset, snapshots it and reports HEALTHY feeds', async () => {
    const repo = new MemoryRepo();
    repo.assets.set(MINT, { id: ASSET, mintAddress: MINT });
    const { transport, hits } = scriptedByPath({
      '/defi/v3/ohlcv': () => {
        const to = addMs(lastClosedBucket(NOW, '1m'), 60_000);
        return ok({ success: true, data: { items: candlesFor(addMs(to, -60 * 60_000), to) } });
      },
      '/defi/token_trending': () => ok({ success: true, data: { updateUnixTime: 1_788_000_000, tokens: [{ address: NEW_MINT, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, liquidity: 1e9, price: 150, rank: 1 }] } }),
      '/defi/v2/tokens/new_listing': () => ok({ success: true, data: { items: [] } }),
    });
    const state = initialIngestState();
    const report = await runMarketIngestCycle(deps(repo, transport), state);
    expect(hits).toEqual(['/defi/v3/ohlcv', '/defi/token_trending', '/defi/v2/tokens/new_listing']);
    expect(report.candlesWritten).toBe(60);
    expect(report.assetsDiscovered).toBe(1);
    expect(repo.assets.has(NEW_MINT)).toBe(true);
    expect(report.snapshots).toBe(1);
    expect(repo.health.get('BIRDEYE:CANDLES')?.state).toBe('HEALTHY');
    expect(repo.health.get('BIRDEYE:DISCOVERY_LIST')?.state).toBe('HEALTHY');
    // Security and overview belong to the eligibility role: ingestion publishes nothing for them.
    expect(repo.health.get('BIRDEYE:TOKEN_SECURITY')).toBeUndefined();
    expect(repo.health.get('BIRDEYE:TOKEN_OVERVIEW')).toBeUndefined();
    // No positions and no candidates: the price feeds were never fetched (FAILED, never silently healthy) but carry no effect.
    expect(repo.health.get('BIRDEYE:ACTIVE_POSITION_PRICE')).toMatchObject({ state: 'FAILED', effectOnEntries: 'NONE', effectOnExits: 'NONE', lastError: expect.stringContaining('NO_DEMAND') });
    expect(repo.health.get('JUPITER_PRICE_V3:ACTIVE_POSITION_PRICE')).toMatchObject({ state: 'FAILED', effectOnExits: 'NONE' });
    expect(repo.health.get('BIRDEYE:CANDIDATE_PRICE')).toMatchObject({ state: 'FAILED', effectOnEntries: 'NONE' });
    expect(repo.health.get('BIRDEYE:HOLDER_DISTRIBUTION')).toMatchObject({ state: 'FAILED', effectOnEntries: 'NONE', lastError: expect.stringContaining('NO_DEMAND') });
    expect(state.lastDiscoveryAt).toBe(NOW);
  });

  it('second cycle with everything held: no candle requests, discovery not yet due, health stays fresh', async () => {
    const repo = new MemoryRepo();
    repo.assets.set(MINT, { id: ASSET, mintAddress: MINT });
    const to = addMs(lastClosedBucket(NOW, '1m'), 60_000);
    for (const item of candlesFor(addMs(to, -60 * 60_000), to) as { unix_time: number; c: number }[]) {
      repo.candles.push({ assetId: ASSET, provider: 'BIRDEYE', resolution: '1m', bucketTime: toInstant(item.unix_time * 1000), observedAt: NOW, provenance: 'LIVE', open: 1, high: 2, low: 0.5, close: item.c, volumeUsd: 10, tradeCount: null });
    }
    const { transport, hits } = scriptedByPath({});
    const state = initialIngestState();
    state.lastDiscoveryAt = addMs(NOW, -60_000);
    state.lastSuccess['CANDLES'] = addMs(NOW, -30_000);
    const report = await runMarketIngestCycle(deps(repo, transport), state);
    expect(hits).toEqual([]);
    expect(report.actions).toBe(0);
    expect(repo.health.get('BIRDEYE:CANDLES')?.state).toBe('HEALTHY');
  });

  it('a failing provider turns the feed FAILED with the error recorded and blocks entries; other classes are unaffected', async () => {
    const repo = new MemoryRepo();
    repo.assets.set(MINT, { id: ASSET, mintAddress: MINT });
    const { transport } = scriptedByPath({
      '/defi/v3/ohlcv': () => ({ status: 500, headers: {}, body: 'boom' }),
      '/defi/token_trending': () => ok({ success: true, data: { tokens: [] } }),
      '/defi/v2/tokens/new_listing': () => ok({ success: true, data: { items: [] } }),
    });
    const report = await runMarketIngestCycle(deps(repo, transport), initialIngestState());
    expect(report.errors.map((e) => e.action)).toEqual(['CANDLES']);
    expect(repo.health.get('BIRDEYE:CANDLES')).toMatchObject({ state: 'FAILED', effectOnEntries: 'BLOCK', lastError: expect.stringContaining('HTTP 500') });
    expect(repo.health.get('BIRDEYE:DISCOVERY_LIST')?.state).toBe('HEALTHY');
    expect(report.snapshots).toBe(0);
  });
});
