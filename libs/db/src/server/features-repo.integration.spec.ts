import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type DiscoveredToken, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { insertFeatureSnapshot, latestFeatureSnapshot, latestMarketSnapshotId, listAssetsForFeatures } from './features-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('feature snapshots repository (§6.8, immutable)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 12, 0, 0));
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mint = () => Array.from({ length: 44 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('') as DiscoveredToken['mintAddress'];
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'features-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('lists evaluating/eligible assets by staleness, stores an immutable snapshot and reads it back', async () => {
    const m = mint();
    const [a] = await upsertDiscoveredAssets(sql, [{ mintAddress: m, symbol: 'F', name: 'F', decimals: 6, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    await sql`update core.assets set status = 'EVALUATING' where id = ${a!.id}`;
    const before = await listAssetsForFeatures(sql, 10_000);
    expect(before.find((x) => x.id === a!.id)).toMatchObject({ status: 'EVALUATING', lastFeatureAsOf: null });
    expect(await latestFeatureSnapshot(sql, a!.id)).toBeNull();
    expect(await latestMarketSnapshotId(sql, a!.id, NOW)).toBeNull();

    const snapshot: FeatureSnapshot = { id: randomUUID() as Uuid, assetId: a!.id, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_5m: 0.01, rsi_14: null }, regime: null, marketSessions: ['EUROPE', 'US', 'EUROPE_US_OVERLAP'], selfInfluenceSuppressed: false };
    await insertFeatureSnapshot(sql, snapshot);
    await insertFeatureSnapshot(sql, { ...snapshot, id: randomUUID() as Uuid, asOf: addMs(NOW, 60_000), features: { ret_5m: 0.02, rsi_14: 61 } });
    const latest = await latestFeatureSnapshot(sql, a!.id);
    expect(latest?.asOf).toBe(addMs(NOW, 60_000));
    expect(latest?.features).toEqual({ ret_5m: 0.02, rsi_14: 61 });
    expect(latest?.marketSessions).toEqual(['EUROPE', 'US', 'EUROPE_US_OVERLAP']);
    const after = await listAssetsForFeatures(sql, 10_000);
    expect(after.find((x) => x.id === a!.id)?.lastFeatureAsOf).toBe(addMs(NOW, 60_000));
    await expect(sql`update signals.feature_snapshots set features = '{}'::jsonb where id = ${snapshot.id}`).rejects.toThrow();
  });
});
