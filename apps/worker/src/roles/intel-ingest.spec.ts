import { DEFAULT_NORMALIZATION_POLICY, addMs, fixedClock, fixtures, type Instant, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import type { ClusterCandidateRow, EventInsert } from '@sol-agent-trader/db/server';
import type { RawSourceEvent } from '@sol-agent-trader/intelligence';
import { createLogger } from '@sol-agent-trader/observability';
import { runIntelIngestCycle, type IntelIngestDeps, type IntelRepo } from './intel-ingest.js';

const T0 = fixtures.T0 as Instant;
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;
const JUP = { id: uuid(1), mint: fixtures.MINTS.RISK as MintAddress, symbol: 'JUP', name: 'Jupiter' };
const BONK = { id: uuid(2), mint: fixtures.MINTS.SOL as MintAddress, symbol: 'BONK', name: 'Bonk' };

function fakeRepo(existing: ClusterCandidateRow[] = []) {
  const stored: EventInsert[] = [];
  const seen = new Set<string>();
  const repo: IntelRepo = {
    async listAssetEntities() { return [JUP, BONK]; },
    async listTrackedSymbols() { return [{ assetId: JUP.id, symbol: 'JUP' }, { assetId: BONK.id, symbol: 'BONK' }]; },
    async listEventsForClustering() { return existing; },
    async upsertEvent(e) {
      const key = `${e.sourceProvider}:${e.sourceId}`;
      if (seen.has(key)) return { id: uuid(99), outcome: 'SEEN_AGAIN' };
      seen.add(key);
      stored.push(e);
      return { id: uuid(100 + stored.length), outcome: 'INSERTED' };
    },
  };
  return { repo, stored };
}
const news = (id: string, title: string, url: string, symbols: string[], publishedAt = '2026-09-05T11:30:00Z'): RawSourceEvent => ({ provider: 'CRYPTOPANIC', sourceId: id, kind: 'NEWS', url, publishedAt, title, summary: null, mints: [], symbols, sentiment: null, classification: 'news', payload: { id, title } });
const social = (symbol: string): RawSourceEvent => ({ provider: 'LUNARCRUSH', sourceId: `${symbol}:2026-09-05T11:00Z`, kind: 'SOCIAL', url: null, publishedAt: '2026-09-05T11:45:00Z', title: `$${symbol} social metrics`, summary: 'galaxy_score=70', mints: [], symbols: [symbol], sentiment: { score: 0.4, confidence: 0.8 }, classification: 'SOCIAL_METRICS', payload: { symbol } });

function deps(repo: IntelRepo, sources: IntelIngestDeps['sources']): IntelIngestDeps {
  return { sources, repo, policy: DEFAULT_NORMALIZATION_POLICY, clock: fixedClock(T0), logger: createLogger({ service: 'worker', minLevel: 'error' }), config: { symbolsPerTick: 10, newsBatch: 50, socialPerTick: 10 } };
}

describe('worker role intel-ingest (§3.4–3.5, §10, D64)', () => {
  it('normalizes news and social items, resolves entities, clusters syndicated copies, and stores only what names our assets', async () => {
    const { repo, stored } = fakeRepo();
    const calls: string[] = [];
    const report = await runIntelIngestCycle(deps(repo, {
      news: async (symbols) => { calls.push(`news:${symbols.join(',')}`); return [news('1', 'Jupiter ships Swap V3 with lower fees', 'https://www.coindesk.com/a', ['JUP']), news('2', 'Jupiter ships Swap V3 with lower fees', 'https://www.theblock.co/b', ['JUP'], '2026-09-05T11:40:00Z'), news('3', 'Bitcoin ETF flows hit a record', 'https://www.coindesk.com/c', ['BTC'])]; },
      social: async (symbol) => { calls.push(`social:${symbol}`); return social(symbol); },
    }));
    expect(calls).toEqual(['news:JUP,BONK', 'social:JUP', 'social:BONK']);
    expect(report).toMatchObject({ symbols: 2, fetched: { news: 3, social: 2 }, inserted: 4, seenAgain: 0, unmatched: 1, clusters: { NEW: 3, DUPLICATE: 1, CORROBORATION: 0 }, errors: [] });
    const first = stored.find((e) => e.sourceId === '1')!;
    const copy = stored.find((e) => e.sourceId === '2')!;
    expect(first).toMatchObject({ sourceProvider: 'CRYPTOPANIC', assetIds: [JUP.id], sourceQuality: 'REPUTABLE_PUBLICATION', sourceTimeConfidence: 'HIGH', firstSeenAt: T0, lastSeenAt: T0, clusterId: null, noveltyScore: 1 });
    expect(copy).toMatchObject({ clusterId: uuid(101), corroboratesEventId: uuid(101) });
    expect(copy.noveltyScore).toBeLessThan(0.2);
    expect(stored.find((e) => e.sourceProvider === 'LUNARCRUSH' && e.sourceId.startsWith('JUP:'))).toMatchObject({ kind: 'SOCIAL', assetIds: [JUP.id], sourcePublishedAt: '2026-09-05T11:45:00.000Z' });
    expect(stored.some((e) => e.title?.includes('Bitcoin'))).toBe(false);
  });

  it('a repeated fetch only advances last_seen_at; a provider failure is reported and does not stop the other provider', async () => {
    const { repo, stored } = fakeRepo();
    const d = deps(repo, { news: async () => [news('1', 'Jupiter ships Swap V3', 'https://www.coindesk.com/a', ['JUP'])], social: async () => { throw new Error('lunarcrush 503'); } });
    const r1 = await runIntelIngestCycle(d);
    expect(r1).toMatchObject({ inserted: 1, errors: [{ provider: 'LUNARCRUSH', error: 'lunarcrush 503' }] });
    const r2 = await runIntelIngestCycle({ ...d, clock: fixedClock(addMs(T0, 600_000)) });
    expect(r2).toMatchObject({ inserted: 0, seenAgain: 1 });
    expect(stored).toHaveLength(1);
  });

  it('with no provider configured the tick does nothing but report', async () => {
    const { repo, stored } = fakeRepo();
    const report = await runIntelIngestCycle(deps(repo, { news: null, social: null }));
    expect(report).toMatchObject({ symbols: 2, fetched: { news: 0, social: 0 }, inserted: 0 });
    expect(stored).toEqual([]);
  });
});
