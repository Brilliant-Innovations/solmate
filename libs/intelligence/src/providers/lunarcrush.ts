import { z } from 'zod';
import { toInstant, type Clock, type Instant } from '@sol-agent-trader/contracts';
import type { RawSourceEvent } from '../normalize.js';
import { IntelProviderError, MinuteLimiter, redactIntelUrl, type IntelHttpTransport } from './http.js';

/**
 * LunarCrush social adapter (blueprint §3.4, §10). Reads the normalized coin metrics the plan
 * exposes (galaxy score, alt rank, sentiment, social volume and interactions, contributors,
 * dominance) and turns each observation into a SOCIAL event keyed by (symbol, hour bucket), so
 * repeated fetches inside the hour advance `last_seen_at` only and the two clocks stay honest:
 * the provider's own timestamp is the source time, our fetch is first-seen. Raw posts are not
 * ingested in v1 (§3.4: normalized context suffices for the first working system).
 */

const CoinMetrics = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    symbol: z.string(),
    name: z.string().optional(),
    price: z.number().nullable().optional(),
    galaxy_score: z.number().nullable().optional(),
    alt_rank: z.number().nullable().optional(),
    sentiment: z.number().nullable().optional(),
    social_volume_24h: z.number().nullable().optional(),
    social_dominance: z.number().nullable().optional(),
    interactions_24h: z.number().nullable().optional(),
    contributors_active: z.number().nullable().optional(),
    contributors_created: z.number().nullable().optional(),
    posts_active: z.number().nullable().optional(),
    posts_created: z.number().nullable().optional(),
    percent_change_24h: z.number().nullable().optional(),
    last_updated_price: z.number().nullable().optional(),
    time: z.number().nullable().optional(),
  })
  .passthrough();
const CoinResponse = z.object({ data: CoinMetrics }).passthrough();
export type LunarCrushCoin = z.infer<typeof CoinMetrics>;

export interface LunarCrushClientOptions {
  apiKey: string;
  transport: IntelHttpTransport;
  clock: Clock;
  requestsPerMinute?: number;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function hourBucket(at: Instant): string {
  return `${at.slice(0, 13)}:00Z`;
}

/** LunarCrush sentiment is 0–100 (percent positive); mapped to [-1, 1] with confidence from social volume. */
export function socialSentiment(m: LunarCrushCoin): { score: number; confidence: number } | null {
  if (m.sentiment === null || m.sentiment === undefined) return null;
  const volume = m.social_volume_24h ?? 0;
  return { score: Math.max(-1, Math.min(1, (m.sentiment - 50) / 50)), confidence: Math.min(1, volume / 500) };
}

export function coinToRawEvent(m: LunarCrushCoin, fetchedAt: Instant): RawSourceEvent & { symbols: string[] } {
  const providerTime = typeof m.time === 'number' && m.time > 0 ? toInstant(m.time * 1000) : typeof m.last_updated_price === 'number' && m.last_updated_price > 0 ? toInstant(m.last_updated_price * 1000) : null;
  const symbol = m.symbol.toUpperCase();
  const facts = { galaxyScore: m.galaxy_score ?? null, altRank: m.alt_rank ?? null, sentiment: m.sentiment ?? null, socialVolume24h: m.social_volume_24h ?? null, socialDominance: m.social_dominance ?? null, interactions24h: m.interactions_24h ?? null, contributorsActive: m.contributors_active ?? null, contributorsCreated: m.contributors_created ?? null, postsActive: m.posts_active ?? null, postsCreated: m.posts_created ?? null };
  return {
    provider: 'LUNARCRUSH',
    sourceId: `${symbol}:${hourBucket(providerTime ?? fetchedAt)}`,
    kind: 'SOCIAL',
    url: null,
    publishedAt: providerTime,
    title: `$${symbol} social metrics`,
    summary: `galaxy_score=${facts.galaxyScore ?? 'n/a'} alt_rank=${facts.altRank ?? 'n/a'} sentiment=${facts.sentiment ?? 'n/a'} social_volume_24h=${facts.socialVolume24h ?? 'n/a'} interactions_24h=${facts.interactions24h ?? 'n/a'} contributors_active=${facts.contributorsActive ?? 'n/a'}`,
    mints: [],
    symbols: [symbol],
    sentiment: socialSentiment(m),
    classification: 'SOCIAL_METRICS',
    payload: { ...facts, symbol, time: providerTime },
  };
}

export class LunarCrushClient {
  private readonly limiter: MinuteLimiter;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(private readonly opts: LunarCrushClientOptions) {
    this.limiter = new MinuteLimiter(opts.requestsPerMinute ?? 10, () => opts.clock.nowMs(), opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
    this.baseUrl = opts.baseUrl ?? 'https://lunarcrush.com';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** One coin's current normalized metrics as a SOCIAL event (null when the coin is unknown to the provider). */
  async coinMetrics(symbol: string): Promise<(RawSourceEvent & { symbols: string[] }) | null> {
    await this.limiter.take();
    const url = new URL(`/api4/public/coins/${encodeURIComponent(symbol.toLowerCase())}/v1`, this.baseUrl);
    const res = await this.opts.transport({ method: 'GET', url: url.toString(), headers: { accept: 'application/json', authorization: `Bearer ${this.opts.apiKey}` }, timeoutMs: this.timeoutMs });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new IntelProviderError('LUNARCRUSH', res.status, redactIntelUrl(url.pathname), res.body);
    const parsed = CoinResponse.safeParse(JSON.parse(res.body));
    if (!parsed.success) throw new IntelProviderError('LUNARCRUSH', res.status, url.pathname, `unexpected shape: ${parsed.error.issues[0]?.message ?? 'n/a'}`);
    return coinToRawEvent(parsed.data.data, this.opts.clock.now());
  }
}
