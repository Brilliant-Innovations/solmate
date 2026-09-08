import { z } from 'zod';
import type { Clock } from '@sol-agent-trader/contracts';
import type { RawSourceEvent } from '../normalize.js';
import { IntelProviderError, MinuteLimiter, redactIntelUrl, type IntelHttpTransport } from './http.js';

/**
 * CryptoPanic news adapter (blueprint §3.5, §10). Fetches recent posts, optionally filtered by
 * currency codes, and maps each to a provider-agnostic `RawSourceEvent`: source URL and publication
 * time as given (HIGH-confidence time provider in intel-v1), title, the aggregator's vote counts as
 * a bounded sentiment hint, and the currencies as symbols the entity index resolves. Only metadata
 * and the title are stored (provider terms); the raw payload is hashed for the record.
 */

const Currency = z.object({ code: z.string(), title: z.string().optional(), slug: z.string().optional() }).passthrough();
const Post = z
  .object({
    id: z.union([z.number(), z.string()]),
    kind: z.string().optional(),
    title: z.string(),
    url: z.string().optional(),
    published_at: z.string().optional(),
    created_at: z.string().optional(),
    source: z.object({ title: z.string().optional(), domain: z.string().optional(), region: z.string().optional() }).passthrough().optional(),
    currencies: z.array(Currency).optional(),
    votes: z.object({ negative: z.number().optional(), positive: z.number().optional(), important: z.number().optional(), liked: z.number().optional(), disliked: z.number().optional(), lol: z.number().optional(), toxic: z.number().optional(), saved: z.number().optional(), comments: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
const PostsResponse = z.object({ count: z.number().optional(), next: z.string().nullable().optional(), results: z.array(Post) }).passthrough();
export type CryptoPanicPost = z.infer<typeof Post>;

export interface CryptoPanicClientOptions {
  apiKey: string;
  transport: IntelHttpTransport;
  clock: Clock;
  requestsPerMinute?: number;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Vote counts → a sentiment hint in [-1, 1] with confidence rising with the number of votes. */
export function sentimentFromVotes(votes: CryptoPanicPost['votes']): { score: number; confidence: number } | null {
  if (!votes) return null;
  const pos = (votes.positive ?? 0) + (votes.liked ?? 0);
  const neg = (votes.negative ?? 0) + (votes.disliked ?? 0) + (votes.toxic ?? 0);
  const total = pos + neg;
  if (total === 0) return null;
  return { score: (pos - neg) / total, confidence: Math.min(1, total / 20) };
}

export function postToRawEvent(post: CryptoPanicPost): RawSourceEvent & { symbols: string[] } {
  const url = post.url ?? (post.source?.domain ? `https://${post.source.domain}` : null);
  return {
    provider: 'CRYPTOPANIC',
    sourceId: String(post.id),
    kind: post.kind === 'media' ? 'SOCIAL' : 'NEWS',
    url,
    publishedAt: post.published_at ?? post.created_at ?? null,
    title: post.title,
    summary: null,
    mints: [],
    symbols: (post.currencies ?? []).map((c) => c.code.toUpperCase()),
    sentiment: sentimentFromVotes(post.votes),
    classification: post.kind ?? null,
    payload: post,
  };
}

export class CryptoPanicClient {
  private readonly limiter: MinuteLimiter;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(private readonly opts: CryptoPanicClientOptions) {
    this.limiter = new MinuteLimiter(opts.requestsPerMinute ?? 5, () => opts.clock.nowMs(), opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
    this.baseUrl = opts.baseUrl ?? 'https://cryptopanic.com';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Recent posts, newest first, for the given currency codes (all when empty). One request per page. */
  async recentPosts(query: { currencies?: readonly string[]; kind?: 'news' | 'media'; page?: number } = {}): Promise<{ events: (RawSourceEvent & { symbols: string[] })[]; next: string | null }> {
    await this.limiter.take();
    const url = new URL('/api/v1/posts/', this.baseUrl);
    url.searchParams.set('auth_token', this.opts.apiKey);
    url.searchParams.set('public', 'true');
    if (query.currencies && query.currencies.length > 0) url.searchParams.set('currencies', query.currencies.slice(0, 50).join(','));
    if (query.kind) url.searchParams.set('kind', query.kind);
    if (query.page && query.page > 1) url.searchParams.set('page', String(query.page));
    const res = await this.opts.transport({ method: 'GET', url: url.toString(), headers: { accept: 'application/json' }, timeoutMs: this.timeoutMs });
    if (res.status !== 200) throw new IntelProviderError('CRYPTOPANIC', res.status, redactIntelUrl(url.pathname), res.body);
    const parsed = PostsResponse.safeParse(JSON.parse(res.body));
    if (!parsed.success) throw new IntelProviderError('CRYPTOPANIC', res.status, url.pathname, `unexpected shape: ${parsed.error.issues[0]?.message ?? 'n/a'}`);
    return { events: parsed.data.results.map(postToRawEvent), next: parsed.data.next ?? null };
  }
}
