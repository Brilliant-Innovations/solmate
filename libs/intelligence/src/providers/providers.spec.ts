import { DEFAULT_NORMALIZATION_POLICY, fixedClock, fixtures, type Instant, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import { EntityIndex } from '../entities.js';
import { normalizeEvent } from '../normalize.js';
import { CryptoPanicClient, postToRawEvent, sentimentFromVotes } from './cryptopanic.js';
import { IntelProviderError, MinuteLimiter, redactIntelUrl, type IntelHttpRequest, type IntelHttpTransport } from './http.js';
import { LunarCrushClient, coinToRawEvent, hourBucket } from './lunarcrush.js';

const T0 = fixtures.T0 as Instant;
const clock = fixedClock(T0);

function recording(responder: (req: IntelHttpRequest) => { status: number; body: unknown }): { transport: IntelHttpTransport; requests: IntelHttpRequest[] } {
  const requests: IntelHttpRequest[] = [];
  const transport: IntelHttpTransport = async (req) => {
    requests.push(req);
    const r = responder(req);
    return { status: r.status, headers: {}, body: JSON.stringify(r.body) };
  };
  return { transport, requests };
}

const post = { id: 1234, kind: 'news', title: 'Jupiter ships Swap V3 with lower fees', url: 'https://www.coindesk.com/x', published_at: '2026-09-05T11:30:00Z', source: { domain: 'coindesk.com', title: 'CoinDesk' }, currencies: [{ code: 'JUP', title: 'Jupiter' }, { code: 'SOL', title: 'Solana' }], votes: { positive: 8, negative: 2, important: 3 } };

describe('CryptoPanic adapter (§3.5, §10)', () => {
  it('maps a post to a raw event with URL, source time, symbols and a bounded sentiment hint; the key never reaches logs', async () => {
    const rec = recording((req) => {
      expect(req.url).toContain('auth_token=cp-secret');
      expect(req.url).toContain('currencies=JUP%2CSOL');
      expect(req.url).toContain('public=true');
      return { status: 200, body: { count: 1, next: null, results: [post] } };
    });
    const client = new CryptoPanicClient({ apiKey: 'cp-secret', transport: rec.transport, clock, sleep: async () => undefined });
    const { events, next } = await client.recentPosts({ currencies: ['JUP', 'SOL'] });
    expect(next).toBeNull();
    expect(events[0]).toMatchObject({ provider: 'CRYPTOPANIC', sourceId: '1234', kind: 'NEWS', url: 'https://www.coindesk.com/x', publishedAt: '2026-09-05T11:30:00Z', title: post.title, symbols: ['JUP', 'SOL'], sentiment: { score: 0.6, confidence: 0.5 }, classification: 'news' });
    expect(redactIntelUrl(rec.requests[0]!.url)).not.toContain('cp-secret');
    expect(sentimentFromVotes(undefined)).toBeNull();
    expect(sentimentFromVotes({ positive: 0, negative: 0 })).toBeNull();
    expect(postToRawEvent({ ...post, kind: 'media', url: undefined }).kind).toBe('SOCIAL');
    expect(postToRawEvent({ ...post, url: undefined }).url).toBe('https://coindesk.com');
  });

  it('normalizes through the shared pipeline: reputable domain, HIGH source time, the symbol resolved to the asset', async () => {
    const jup = { id: fixtures.IDS.asset as Uuid, mint: fixtures.MINTS.RISK as MintAddress, symbol: 'JUP', name: 'Jupiter' };
    const entities = new EntityIndex([jup]);
    const raw = postToRawEvent(post);
    const n = await normalizeEvent(raw, { firstSeenAt: T0, policy: DEFAULT_NORMALIZATION_POLICY, entities });
    expect(n.event).toMatchObject({ sourceProvider: 'CRYPTOPANIC', sourceQuality: 'REPUTABLE_PUBLICATION', sourceTimeConfidence: 'HIGH', sourcePublishedAt: '2026-09-05T11:30:00.000Z', assetIds: [jup.id] });
  });

  it('a non-200 is a provider error and a malformed body is refused', async () => {
    const down = new CryptoPanicClient({ apiKey: 'k', transport: recording(() => ({ status: 429, body: { detail: 'slow down' } })).transport, clock, sleep: async () => undefined });
    await expect(down.recentPosts()).rejects.toThrow(IntelProviderError);
    const junk = new CryptoPanicClient({ apiKey: 'k', transport: recording(() => ({ status: 200, body: { results: 'nope' } })).transport, clock, sleep: async () => undefined });
    await expect(junk.recentPosts()).rejects.toThrow(/unexpected shape/);
  });
});

describe('LunarCrush adapter (§3.4, §10)', () => {
  const coin = { symbol: 'jup', name: 'Jupiter', galaxy_score: 72, alt_rank: 41, sentiment: 80, social_volume_24h: 1200, social_dominance: 0.4, interactions_24h: 250000, contributors_active: 900, posts_active: 3000, time: Math.floor(Date.parse('2026-09-05T11:45:00Z') / 1000) };

  it('turns coin metrics into an hour-bucketed SOCIAL event with provider time as source time and a sentiment in [-1, 1]', async () => {
    const rec = recording((req) => {
      expect(req.url).toBe('https://lunarcrush.com/api4/public/coins/jup/v1');
      expect(req.headers['authorization']).toBe('Bearer lc-secret');
      return { status: 200, body: { data: coin } };
    });
    const client = new LunarCrushClient({ apiKey: 'lc-secret', transport: rec.transport, clock, sleep: async () => undefined });
    const ev = await client.coinMetrics('JUP');
    expect(ev).toMatchObject({ provider: 'LUNARCRUSH', kind: 'SOCIAL', sourceId: 'JUP:2026-09-05T11:00Z', publishedAt: '2026-09-05T11:45:00.000Z', symbols: ['JUP'], sentiment: { score: 0.6, confidence: 1 }, classification: 'SOCIAL_METRICS' });
    expect(ev?.summary).toContain('galaxy_score=72');
    expect(hourBucket(T0)).toBe('2026-09-05T12:00Z');
    // no provider time: bucketed by the fetch time, and a coin the provider does not know is null
    expect(coinToRawEvent({ symbol: 'x', sentiment: null }, T0)).toMatchObject({ sourceId: 'X:2026-09-05T12:00Z', publishedAt: null, sentiment: null });
    const missing = new LunarCrushClient({ apiKey: 'k', transport: recording(() => ({ status: 404, body: {} })).transport, clock, sleep: async () => undefined });
    expect(await missing.coinMetrics('NOPE')).toBeNull();
  });

  it('repeated fetches inside an hour share one source id, so the store advances last_seen_at instead of inserting', () => {
    const a = coinToRawEvent({ ...coin, time: Math.floor(Date.parse('2026-09-05T11:05:00Z') / 1000) }, T0);
    const b = coinToRawEvent({ ...coin, time: Math.floor(Date.parse('2026-09-05T11:55:00Z') / 1000), galaxy_score: 75 }, T0);
    const c = coinToRawEvent({ ...coin, time: Math.floor(Date.parse('2026-09-05T12:01:00Z') / 1000) }, T0);
    expect(a.sourceId).toBe(b.sourceId);
    expect(c.sourceId).not.toBe(a.sourceId);
  });
});

describe('minute limiter', () => {
  it('lets n requests through per minute and waits for the oldest to age out', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new MinuteLimiter(2, () => now, async (ms) => { waits.push(ms); now += ms; });
    await limiter.take();
    await limiter.take();
    await limiter.take();
    expect(waits).toEqual([60_000]);
    expect(now).toBe(60_000);
  });
});
