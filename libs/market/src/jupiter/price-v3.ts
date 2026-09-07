import { z } from 'zod';
import { MintAddress, PriceQuote, type Clock, type Instant } from '@sol-agent-trader/contracts';
import { TokenBucket } from '../budget/rate-limiter.js';
import { HttpError, type HttpTransport } from '../http/transport.js';

/**
 * Jupiter Price API V3 (blueprint §3.3, §21.2 "secondary/reference source"). One USD price per
 * mint derived from the last swaps, anchored on oracle-priced majors. Tokens without a reliable
 * price are omitted by the provider, and we keep them omitted: a missing quote is never a zero.
 *
 * Hosts: lite-api.jup.ag (no key) or api.jup.ag with `x-api-key`. Max 50 ids per request.
 */

const PriceV3Entry = z.looseObject({
  usdPrice: z.number().nullable().optional(),
  blockId: z.number().int().nullable().optional(),
  decimals: z.number().int().nullable().optional(),
  priceChange24h: z.number().nullable().optional(),
});
const PriceV3Response = z.record(z.string(), PriceV3Entry.nullable());

export const JUPITER_PRICE_MAX_IDS = 50;

export interface JupiterPriceClientOptions {
  transport: HttpTransport;
  clock: Clock;
  apiKey?: string;
  /** Requests per second permitted by the plan; the free host is conservative (1 rps default). */
  requestsPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class JupiterPriceClient {
  private readonly bucket: TokenBucket;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: JupiterPriceClientOptions) {
    this.bucket = new TokenBucket(opts.clock, opts.requestsPerSecond ?? 1);
    this.baseUrl = (opts.baseUrl ?? (opts.apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')).replace(/\/$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Prices for up to 50 mints; mints the provider does not price are absent from the result. */
  async prices(mints: readonly string[]): Promise<{ quotes: PriceQuote[]; latencyMs: number; observedAt: Instant }> {
    if (mints.length === 0) throw new RangeError('prices: at least one mint');
    if (mints.length > JUPITER_PRICE_MAX_IDS) throw new RangeError(`prices: max ${JUPITER_PRICE_MAX_IDS} ids per request`);
    const url = `${this.baseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;
    const started = this.opts.clock.nowMs();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const turn = this.bucket.take();
      if (!turn.ok) await this.sleep(turn.waitMs);
      let status: number;
      let body: string;
      let retryAfter: string | undefined;
      try {
        const res = await this.opts.transport({ method: 'GET', url, headers, timeoutMs: this.timeoutMs });
        status = res.status;
        body = res.body;
        retryAfter = res.headers['retry-after'];
      } catch (err) {
        lastError = err;
        await this.sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      if (status === 429 || status >= 500) {
        lastError = new HttpError(status, url, body);
        const ra = Number(retryAfter);
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(30_000, ra * 1000) : Math.min(30_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      if (status !== 200) throw new HttpError(status, url, body);
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error('Jupiter price v3: response is not JSON');
      }
      const parsed = PriceV3Response.safeParse(json);
      if (!parsed.success) throw new Error(`Jupiter price v3: unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`);
      const observedAt = this.opts.clock.now();
      const quotes: PriceQuote[] = [];
      for (const [address, entry] of Object.entries(parsed.data)) {
        if (!entry || typeof entry.usdPrice !== 'number' || !(entry.usdPrice > 0)) continue;
        const mint = MintAddress.safeParse(address);
        if (!mint.success) continue;
        const q = PriceQuote.safeParse({
          mintAddress: mint.data,
          provider: 'JUPITER_PRICE_V3',
          priceUsd: entry.usdPrice,
          providerUpdatedAt: null,
          blockId: typeof entry.blockId === 'number' && entry.blockId >= 0 ? entry.blockId : null,
          liquidityUsd: null,
          observedAt,
        });
        if (q.success) quotes.push(q.data);
      }
      return { quotes, latencyMs: this.opts.clock.nowMs() - started, observedAt };
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
