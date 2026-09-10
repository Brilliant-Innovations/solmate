import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type DiscoveredToken, type Uuid } from '@sol-agent-trader/contracts';
import { insertFeatureSnapshot, latestFeatureValueByMint, listAssetsForFeatures } from './features-repo.js';
import { listTrackedAssets, upsertDiscoveredAssets } from './market-repo.js';
import { listRecentOwnFills } from './candidates-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('reference series and own fills (§9.1 relative strength, §8.6 self-influence)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'reference-series-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('a BLOCKED reference mint is still tracked for candles and featured; its latest ret_1h is readable by mint within the age window', async () => {
    const mint = b58(44) as DiscoveredToken['mintAddress'];
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint, symbol: 'REF', name: 'Reference', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    await sql`update core.assets set status = 'BLOCKED' where id = ${asset!.id}`;
    expect((await listTrackedAssets(sql, 10_000)).some((a) => a.id === asset!.id)).toBe(false);
    expect((await listTrackedAssets(sql, 10_000, [mint])).some((a) => a.id === asset!.id)).toBe(true);
    expect((await listAssetsForFeatures(sql, 10_000)).some((a) => a.id === asset!.id)).toBe(false);
    expect((await listAssetsForFeatures(sql, 10_000, [mint])).some((a) => a.id === asset!.id)).toBe(true);
    await insertFeatureSnapshot(sql, { id: randomUUID() as Uuid, assetId: asset!.id, asOf: addMs(NOW, -3 * 60_000), newestInputAt: null, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_1h: 0.021 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    expect(await latestFeatureValueByMint(sql, mint, 'ret_1h', 10 * 60_000, NOW)).toBeCloseTo(0.021);
    expect(await latestFeatureValueByMint(sql, mint, 'ret_1h', 60_000, NOW)).toBeNull(); // too old for a one-minute window
    expect(await latestFeatureValueByMint(sql, mint, 'ret_4h', 10 * 60_000, NOW)).toBeNull(); // feature absent
    // no LIVE fills exist for a fresh asset; paper fills are never own fills
    expect(await listRecentOwnFills(sql, asset!.id, addMs(NOW, -3_600_000))).toEqual([]);
  });
});
