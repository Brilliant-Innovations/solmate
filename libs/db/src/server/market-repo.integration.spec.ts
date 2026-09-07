import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Candle, type DiscoveredToken, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { heldBucketTimes, insertSnapshot, loadCandles, upsertDiscoveredAssets, upsertFeedHealth, writeCandles } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

/** Integration tests against a local Supabase; skipped without SUPABASE_DB_URL (CI database job runs them). */
const url = databaseUrlFromEnv();

describe.skipIf(!url)('market repository (§6.1, §6.4, §6.5; point-in-time and immutability)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 9, 1, 12, 0, 0));
  const mint = () => {
    // 44-char base58-looking unique mint per test run
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < 44; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s as DiscoveredToken['mintAddress'];
  };
  const token = (m: DiscoveredToken['mintAddress'], over: Partial<DiscoveredToken> = {}): DiscoveredToken => ({
    mintAddress: m, symbol: 'TST', name: 'Test', decimals: 6, source: 'BIRDEYE_TRENDING', rank: 1, liquidityUsd: 1000, volume24hUsd: 500, priceUsd: 1, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW, ...over,
  });

  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'market-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('re-discovery never moves first_observed_at and never resets status', async () => {
    const m = mint();
    const [a] = await upsertDiscoveredAssets(sql, [token(m)], NOW);
    await sql`update core.assets set status = 'ELIGIBLE' where id = ${a!.id}`;
    const later = addMs(NOW, 3_600_000);
    const [b] = await upsertDiscoveredAssets(sql, [token(m, { symbol: 'NEW', listedAt: addMs(NOW, -86_400_000) })], later);
    expect(b!.id).toBe(a!.id);
    const [row] = await sql<{ first_observed_at: string; status: string; symbol: string; estimated_created_at: string | null }[]>`select first_observed_at, status, symbol, estimated_created_at from core.assets where id = ${a!.id}`;
    expect(new Date(row!.first_observed_at).toISOString()).toBe(NOW);
    expect(row!.status).toBe('ELIGIBLE');
    expect(row!.symbol).toBe('NEW');
    expect(row!.estimated_created_at).not.toBeNull();
  });

  it('closed candles are immutable, an open bucket may be replaced by a newer observation, and BACKFILL never overwrites LIVE', async () => {
    const [a] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const assetId = a!.id as Uuid;
    const bucket = toInstant(Date.UTC(2026, 9, 1, 11, 0, 0));
    const candle = (over: Partial<Candle>): Candle => ({ assetId, provider: 'BIRDEYE', resolution: '1m', bucketTime: bucket, observedAt: addMs(bucket, 120_000), provenance: 'LIVE', open: 1, high: 2, low: 0.5, close: 1.5, volumeUsd: 10, tradeCount: null, ...over });

    // Closed candle observed after its bucket ended: immutable.
    expect(await writeCandles(sql, [candle({})])).toEqual({ inserted: 1, replacedOpen: 0, ignored: 0 });
    expect(await writeCandles(sql, [candle({ close: 9, observedAt: addMs(bucket, 600_000) })])).toEqual({ inserted: 0, replacedOpen: 0, ignored: 1 });
    expect((await loadCandles(sql, assetId, '1m', bucket, bucket))[0]?.close).toBe(1.5);

    // Open bucket (observed 20s into a 1m bucket) may be replaced by a later observation.
    const open = addMs(bucket, 60_000);
    expect(await writeCandles(sql, [candle({ bucketTime: open, observedAt: addMs(open, 20_000), close: 1.1 })])).toEqual({ inserted: 1, replacedOpen: 0, ignored: 0 });
    expect(await writeCandles(sql, [candle({ bucketTime: open, observedAt: addMs(open, 70_000), close: 1.3 })])).toEqual({ inserted: 0, replacedOpen: 1, ignored: 0 });
    expect((await loadCandles(sql, assetId, '1m', open, open))[0]?.close).toBe(1.3);
    // …but not by an older observation
    expect(await writeCandles(sql, [candle({ bucketTime: open, observedAt: addMs(open, 30_000), close: 7 })])).toEqual({ inserted: 0, replacedOpen: 0, ignored: 1 });

    // BACKFILL never overwrites LIVE, even for a bucket that was open.
    const open2 = addMs(bucket, 120_000);
    await writeCandles(sql, [candle({ bucketTime: open2, observedAt: addMs(open2, 10_000), close: 2 })]);
    expect(await writeCandles(sql, [candle({ bucketTime: open2, observedAt: addMs(open2, 500_000), close: 3, provenance: 'BACKFILL' })])).toEqual({ inserted: 0, replacedOpen: 0, ignored: 1 });

    expect(await heldBucketTimes(sql, assetId, '1m', bucket, open2)).toEqual([bucket, open, open2]);
  });

  it('snapshots and feed health round-trip; nulls stay null', async () => {
    const [a] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const id = randomUUID() as Uuid;
    const nulls = { m5: null, m15: null, h1: null, h4: null, h24: null };
    await insertSnapshot(sql, {
      id, assetId: a!.id, asOf: NOW, observedAt: NOW, provenance: 'LIVE', priceUsd: null, liquidityUsd: null,
      volumeUsd: nulls, buyVolumeUsd: nulls, sellVolumeUsd: nulls, buyCount: nulls, sellCount: nulls,
      relativeVolume: null, atr: null, realizedVolatility: null,
      returns: { s15: null, m1: null, m3: null, m5: null, m15: null, m30: null, h1: null, h4: null },
      marketCapUsd: null, fdvUsd: null, solRelativeReturn: null, universeRelativeStrength: null, routeProbes: [],
    });
    const [row] = await sql<{ price_usd: number | null; volume_usd: Record<string, unknown> }[]>`select price_usd, volume_usd from market.snapshots where id = ${id}`;
    expect(row!.price_usd).toBeNull();
    expect(row!.volume_usd).toEqual(nulls);

    const key = `BIRDEYE:CANDLES:${randomUUID()}`;
    await upsertFeedHealth(sql, { provider: key, state: 'FAILED', lastSuccessAt: null, freshnessAgeMs: null, latencyMs: null, rateLimitState: null, effectOnEntries: 'BLOCK', effectOnExits: 'NONE', lastError: 'never succeeded', updatedAt: NOW });
    await upsertFeedHealth(sql, { provider: key, state: 'HEALTHY', lastSuccessAt: NOW, freshnessAgeMs: 0, latencyMs: 120, rateLimitState: 'OK', effectOnEntries: 'NONE', effectOnExits: 'NONE', lastError: null, updatedAt: NOW });
    const [h] = await sql<{ state: string; latency_ms: number; last_error: string | null }[]>`select state, latency_ms, last_error from ops.provider_health where provider = ${key}`;
    expect(h).toEqual({ state: 'HEALTHY', latency_ms: 120, last_error: null });
    await sql`delete from ops.provider_health where provider = ${key}`;
  });
});

export type { Instant };
