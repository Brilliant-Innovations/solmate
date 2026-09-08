import fc from 'fast-check';
import { addMs, DEFAULT_NORMALIZATION_POLICY, toInstant, type Instant, type MintAddress, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { EntityIndex } from './entities.js';
import { assignCluster, jaccard, shingles, type ClusterCandidate } from './dedupe.js';
import { catalystAgeMs, freshWindowVerdict } from './catalyst.js';
import { domainOf, normalizeEvent, sourceQualityFor, sourceTimeOf, type RawSourceEvent } from './normalize.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 12, 0, 0));
const policy = DEFAULT_NORMALIZATION_POLICY;
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress;
const entities = new EntityIndex([
  { id: id(1), mint: BONK, symbol: 'BONK', name: 'Bonk' },
  { id: id(2), mint: JUP, symbol: 'JUP', name: 'Jupiter' },
  { id: id(3), mint: 'So11111111111111111111111111111111111111112' as MintAddress, symbol: 'SOL', name: 'Wrapped SOL' },
  { id: id(4), mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as MintAddress, symbol: 'USDT', name: 'Tether USD' },
  { id: id(5), mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' as MintAddress, symbol: 'ORCA', name: 'Orca' },
  { id: id(6), mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' as MintAddress, symbol: 'W', name: 'Wormhole' },
  { id: id(7), mint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as MintAddress, symbol: 'JUP', name: 'Jupiter Copycat' }, // ambiguous symbol
]);
const raw = (over: Partial<RawSourceEvent> = {}): RawSourceEvent => ({ provider: 'CRYPTOPANIC', sourceId: 'p1', kind: 'NEWS', url: 'https://www.coindesk.com/markets/2026/09/08/jupiter-ships-swap-v3', publishedAt: '2026-09-08T10:30:00Z', title: 'Jupiter ships Swap V3 with lower fees', summary: 'The Solana aggregator $JUP released a new router.', mints: [], sentiment: { score: 0.4, confidence: 0.7 }, classification: 'PRODUCT', payload: { id: 'p1', t: 'Jupiter ships Swap V3 with lower fees' }, ...over });

describe('event normalization (§10.1, §10.3, §10.4, §6.6, D64)', () => {
  it('classifies source quality only from the pinned domain table, keeps two clocks apart, hashes payload and url, and matches entities without guessing', async () => {
    const n = await normalizeEvent(raw(), { firstSeenAt: NOW, policy, entities });
    expect(n.domain).toBe('coindesk.com');
    expect(n.event).toMatchObject({ sourceQuality: 'REPUTABLE_PUBLICATION', sourceTimeConfidence: 'HIGH', sourcePublishedAt: '2026-09-08T10:30:00.000Z', firstSeenAt: NOW, lastSeenAt: NOW, kind: 'NEWS', sourceProvider: 'CRYPTOPANIC', sourceId: 'p1' });
    expect(n.event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(n.event.sourceUrlHash).toMatch(/^[0-9a-f]{64}$/);
    // "Jupiter" name → cashtag $JUP is ambiguous (two assets share JUP) so only the name match survives... unless the name is unique
    expect(n.matches.map((m) => [m.assetId, m.by])).toEqual([[id(2), 'NAME']]);
    expect(sourceQualityFor('news.sec.gov', policy)).toBe('PRIMARY_GOVERNMENT_REGULATORY');
    expect(sourceQualityFor('blog.jup.ag', policy)).toBe('OFFICIAL_EXCHANGE_PROTOCOL');
    expect(sourceQualityFor('x.com', policy)).toBe('UNKNOWN_SOCIAL');
    expect(sourceQualityFor(null, policy)).toBe('UNKNOWN_SOCIAL');
    expect(domainOf('not a url')).toBeNull();
    // the text never sets quality: a tweet claiming to be the SEC is still unknown social
    const tweet = await normalizeEvent(raw({ url: 'https://x.com/someone/status/1', title: 'SEC official statement: approved' }), { firstSeenAt: NOW, policy, entities });
    expect(tweet.event.sourceQuality).toBe('UNKNOWN_SOCIAL');
  });

  it('source time confidence: provider precision, date-only, absent, unparsable and future-of-first-seen', () => {
    expect(sourceTimeOf(raw(), policy).confidence).toBe('HIGH');
    expect(sourceTimeOf(raw({ provider: 'RSS' }), policy).confidence).toBe('MEDIUM');
    expect(sourceTimeOf(raw({ publishedAtImprecise: true }), policy).confidence).toBe('LOW');
    expect(sourceTimeOf(raw({ publishedAt: null }), policy)).toEqual({ at: null, confidence: 'ABSENT' });
    expect(sourceTimeOf(raw({ publishedAt: 'yesterday' }), policy)).toEqual({ at: null, confidence: 'ABSENT' });
  });

  it('a source time far ahead of first-seen is kept but downgraded to LOW', async () => {
    const n = await normalizeEvent(raw({ publishedAt: '2026-09-09T12:00:00Z' }), { firstSeenAt: NOW, policy, entities });
    expect(n.event.sourceTimeConfidence).toBe('LOW');
    expect(n.event.sourcePublishedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('entity matching: mint beats everything, unique cashtag and bare symbol match, ambiguous symbols and short names do not', () => {
    const m = (text: string, mints: string[] = []) => entities.match(text, mints, policy).map((x) => `${x.assetId.slice(0, 8)}:${x.by}`);
    expect(m('anything', [BONK])).toEqual(['00000001:MINT']);
    expect(m('$BONK is ripping')).toEqual(['00000001:CASHTAG']);
    expect(m('BONK volume up')).toEqual(['00000001:SYMBOL']);
    expect(m('$JUP and JUP')).toEqual([]); // two assets carry JUP
    expect(m('$JUP', [JUP])).toEqual(['00000002:MINT']);
    expect(m('W is a letter and w is a word')).toEqual([]); // too short for a bare symbol
    expect(m('Orca is a whale')).toEqual([]); // short single-word name is not matched; ORCA symbol would need upper case
    expect(m('Wormhole bridge volume')).toEqual(['00000006:NAME']);
    expect(m('tether usd depegs briefly')).toEqual(['00000004:NAME']);
  });
});

describe('deduplication into catalyst clusters (§10.2)', () => {
  const recent: ClusterCandidate[] = [
    { id: id(10), clusterId: null, sourceUrlHash: 'ab'.repeat(32) as Sha256Hex, title: 'Jupiter ships Swap V3 with lower fees', assetIds: [id(2)], firstSeenAt: addMs(NOW, -3_600_000) },
    { id: id(11), clusterId: id(10), sourceUrlHash: 'cd'.repeat(32) as Sha256Hex, title: 'Jupiter releases Swap V3, cuts fees', assetIds: [id(2)], firstSeenAt: addMs(NOW, -1_800_000) },
    { id: id(12), clusterId: null, sourceUrlHash: null, title: 'Bonk burns 1 trillion tokens', assetIds: [id(1)], firstSeenAt: addMs(NOW, -600_000) },
  ];

  it('same url, similar title and same-entity loose similarity join the cluster of the first event; unrelated and out-of-window stories are new', () => {
    const sameUrl = assignCluster({ sourceUrlHash: 'ab'.repeat(32) as Sha256Hex, title: 'Completely different words here', assetIds: [], firstSeenAt: NOW }, recent, policy);
    expect(sameUrl).toMatchObject({ relation: 'DUPLICATE', clusterId: id(10), corroboratesEventId: id(10), noveltyScore: 0 });
    const similar = assignCluster({ sourceUrlHash: 'ef'.repeat(32) as Sha256Hex, title: 'Jupiter ships Swap V3 with lower fees for traders', assetIds: [id(2)], firstSeenAt: NOW }, recent, policy);
    expect(similar.relation).toBe('DUPLICATE');
    expect(similar.clusterId).toBe(id(10));
    expect(similar.noveltyScore).toBeLessThan(0.5);
    const corroborating = assignCluster({ sourceUrlHash: null, title: 'Swap V3 lower fees explained by Jupiter team', assetIds: [id(2)], firstSeenAt: NOW }, recent, policy);
    expect(corroborating.relation).toBe('CORROBORATION');
    expect(corroborating.clusterId).toBe(id(10));
    const unrelated = assignCluster({ sourceUrlHash: null, title: 'Federal Reserve holds rates', assetIds: [], firstSeenAt: NOW }, recent, policy);
    expect(unrelated).toEqual({ relation: 'NEW', clusterId: null, corroboratesEventId: null, noveltyScore: 1, similarity: 0 });
    const stale = assignCluster({ sourceUrlHash: 'ab'.repeat(32) as Sha256Hex, title: 'x', assetIds: [], firstSeenAt: addMs(NOW, 3 * 86_400_000) }, recent, policy);
    expect(stale.relation).toBe('NEW');
    expect(jaccard(shingles('a b c', 2), shingles('a b c', 2))).toBe(1);
    expect(shingles('one', 2)).toEqual(new Set(['one']));
  });

  it('property: assignment is deterministic, independent of candidate order, and novelty is 1 minus the best similarity', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('jupiter', 'ships', 'swap', 'v3', 'fees', 'bonk', 'burn', 'tokens', 'solana', 'rates'), { minLength: 1, maxLength: 8 }), fc.boolean(), (words, share) => {
        const draft = { sourceUrlHash: null, title: words.join(' '), assetIds: share ? [id(2)] : [], firstSeenAt: NOW };
        const a = assignCluster(draft, recent, policy);
        const b = assignCluster(draft, [...recent].reverse(), policy);
        expect(b).toEqual(a);
        expect(a.noveltyScore).toBeCloseTo(a.relation === 'NEW' ? 1 : 1 - a.similarity, 12);
      }),
    );
  });
});

describe('catalyst age and fresh windows (D64)', () => {
  it('age comes from trustworthy source time only; recycled or old content cannot open a fresh window; a new first-seen never resets age', () => {
    const t = { sourcePublishedAt: addMs(NOW, -3_600_000) as Instant, sourceTimeConfidence: 'HIGH' as const, firstSeenAt: NOW };
    expect(catalystAgeMs(t, NOW)).toBe(3_600_000);
    expect(catalystAgeMs({ ...t, sourceTimeConfidence: 'LOW' }, NOW)).toBeNull();
    expect(catalystAgeMs({ ...t, sourcePublishedAt: null, sourceTimeConfidence: 'ABSENT' }, NOW)).toBeNull();
    expect(freshWindowVerdict(t, 'NEW', NOW, policy)).toEqual({ allowed: true, ageMs: 3_600_000 });
    expect(freshWindowVerdict(t, 'DUPLICATE', NOW, policy)).toMatchObject({ allowed: false, reason: 'RECYCLED' });
    expect(freshWindowVerdict({ ...t, sourceTimeConfidence: 'ABSENT', sourcePublishedAt: null }, 'NEW', NOW, policy)).toMatchObject({ allowed: false, reason: 'SOURCE_TIME_UNTRUSTED' });
    // ingesting a six-hour-old article at session start does not make it a fresh catalyst
    const old = { ...t, sourcePublishedAt: addMs(NOW, -7 * 3_600_000) as Instant, firstSeenAt: NOW };
    expect(freshWindowVerdict(old, 'NEW', NOW, policy)).toMatchObject({ allowed: false, reason: 'CATALYST_TOO_OLD', ageMs: 7 * 3_600_000 });
  });
});
