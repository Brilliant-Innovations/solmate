import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type DiscoveredToken, type Sha256Hex } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { listAssetEntities, listEventsForClustering, listEventsVisibleAt, upsertEvent, type EventInsert } from './intelligence-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('intelligence events repository (§6.6, §10, §18.3; INV-13)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'intelligence-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('inserts once per (provider, sourceId), only advances last_seen_at on a repeat, clusters within the window, and never returns an event before its first_seen_at', async () => {
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'EVT', name: 'Event Asset', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const provider = `TEST-${randomUUID().slice(0, 8)}`;
    const base: EventInsert = {
      kind: 'NEWS', sourceProvider: provider, sourceId: 'story-1', sourceUrlHash: 'ab'.repeat(32) as Sha256Hex, sourcePublishedAt: addMs(NOW, -3_600_000), sourceTimeConfidence: 'HIGH', firstSeenAt: NOW, lastSeenAt: NOW, assetIds: [asset!.id],
      title: 'Event Asset ships upgrade', summary: null, sourceQuality: 'REPUTABLE_PUBLICATION', noveltyScore: 1, sentiment: { score: 0.2, confidence: 0.5 }, classification: null, clusterId: null, corroboratesEventId: null, payloadHash: 'cd'.repeat(32) as Sha256Hex, rawPayloadRef: null,
    };
    const first = await upsertEvent(sql, base);
    expect(first.outcome).toBe('INSERTED');
    // a repeated fetch with a "revised" title: only last_seen_at moves
    const again = await upsertEvent(sql, { ...base, title: 'Revised headline', firstSeenAt: addMs(NOW, 600_000), lastSeenAt: addMs(NOW, 600_000) });
    expect(again).toEqual({ id: first.id, outcome: 'SEEN_AGAIN' });
    const [row] = await sql<{ title: string; first_seen_at: string; last_seen_at: string }[]>`select title, first_seen_at, last_seen_at from intelligence.events where id = ${first.id}`;
    expect(row!.title).toBe('Event Asset ships upgrade');
    expect(new Date(row!.first_seen_at).toISOString()).toBe(NOW);
    expect(new Date(row!.last_seen_at).toISOString()).toBe(addMs(NOW, 600_000));
    // the guard refuses a rewrite of the clocks or the content
    await expect(sql`update intelligence.events set first_seen_at = ${addMs(NOW, -60_000)} where id = ${first.id}`).rejects.toThrow(/immutable/);
    // clustering window sees it; a second story joins the cluster explicitly
    const forClustering = await listEventsForClustering(sql, addMs(NOW, 1_000), 3_600_000 * 48);
    expect(forClustering.some((c) => c.id === first.id && c.assetIds.includes(asset!.id))).toBe(true);
    const second = await upsertEvent(sql, { ...base, sourceId: 'story-2', sourceUrlHash: 'ef'.repeat(32) as Sha256Hex, firstSeenAt: addMs(NOW, 1_800_000), lastSeenAt: addMs(NOW, 1_800_000), clusterId: first.id, corroboratesEventId: first.id, noveltyScore: 0.2 });
    expect(second.outcome).toBe('INSERTED');
    // INV-13: at NOW only the first is visible; at NOW+30min both; before NOW nothing
    expect((await listEventsVisibleAt(sql, asset!.id, NOW)).map((e) => e.id)).toEqual([first.id]);
    expect((await listEventsVisibleAt(sql, asset!.id, addMs(NOW, 1_800_000))).map((e) => e.id)).toEqual([second.id, first.id]);
    expect(await listEventsVisibleAt(sql, asset!.id, addMs(NOW, -1))).toEqual([]);
    const visible = await listEventsVisibleAt(sql, asset!.id, addMs(NOW, 1_800_000));
    expect(visible[0]).toMatchObject({ clusterId: first.id, corroboratesEventId: first.id, assetIds: [asset!.id], sourceTimeConfidence: 'HIGH' });
    expect((await listAssetEntities(sql)).some((a) => a.id === asset!.id && a.symbol === 'EVT')).toBe(true);
  });
});
