import {
  toInstant,
  type CandleResolution,
  type Clock,
  type DataProvenance,
  type DiscoveredToken,
  type Instant,
  type PriceQuote,
  type ProviderTier,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';
import type { z } from 'zod';
import { ComputeUnitLedger, TokenBucket } from '../budget/rate-limiter.js';
import { RESOLUTION_MS } from '../candles/resolution.js';
import { HttpError, type HttpTransport, type HttpResponse } from '../http/transport.js';
import { BIRDEYE_INTERVAL, normalizeCandles, normalizeNewListings, normalizeOverview, normalizePrices, normalizeSecurity, normalizeTokenList, normalizeTrending, type NormalizedCandles } from './normalize.js';
import { MultiPriceResponse, NewListingResponse, OhlcvV3Response, TokenListResponse, TokenOverviewResponse, TokenSecurityResponse, TrendingResponse } from './schemas.js';
import { BIRDEYE_CU, BIRDEYE_ENDPOINT_LIMITS } from './tiers.js';

/**
 * Birdeye REST adapter (blueprint §3.1; execution plan M4 "REST first"). Every call:
 *   1. checks the compute-unit ledger for the purchased tier (CRITICAL requests may dip into the
 *      reserve, NORMAL ones may not);
 *   2. waits for the token bucket that mirrors the tier's requests-per-second;
 *   3. retries 429/5xx/transport failures with bounded exponential backoff, honouring Retry-After;
 *   4. validates the raw JSON against the documented shape and normalises it, never inventing
 *      values for absent fields.
 * Time comes from the injected Clock; waiting is done through the injected `sleep` so tests run
 * instantly. The API key travels only in the `X-API-KEY` header and never appears in errors.
 */

export type RequestPriority = 'CRITICAL' | 'NORMAL';

export interface BirdeyeClientOptions {
  apiKey: string;
  tier: ProviderTier;
  transport: HttpTransport;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  chain?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  ledger?: ComputeUnitLedger;
}

export interface CallMeta {
  endpoint: string;
  latencyMs: number;
  computeUnits: number;
  attempts: number;
  observedAt: Instant;
}

export class BudgetExhaustedError extends Error {
  constructor(readonly endpoint: string) {
    super(`Birdeye compute-unit allowance exhausted; refusing ${endpoint}`);
    this.name = 'BudgetExhaustedError';
  }
}

export class ProviderResponseError extends Error {
  constructor(
    readonly endpoint: string,
    detail: string,
  ) {
    super(`Birdeye ${endpoint}: ${detail}`);
    this.name = 'ProviderResponseError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BirdeyeClient {
  private readonly bucket: TokenBucket;
  readonly ledger: ComputeUnitLedger;
  private readonly baseUrl: string;
  private readonly chain: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: BirdeyeClientOptions) {
    this.bucket = new TokenBucket(opts.clock, opts.tier.requestsPerSecond);
    this.ledger = opts.ledger ?? new ComputeUnitLedger(opts.clock, opts.tier.computeUnitsPerMonth);
    this.baseUrl = (opts.baseUrl ?? 'https://public-api.birdeye.so').replace(/\/$/, '');
    this.chain = opts.chain ?? 'solana';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async get<T extends z.ZodType>(endpoint: string, path: string, query: Record<string, string | number | boolean | undefined>, schema: T, cu: number, priority: RequestPriority): Promise<{ data: z.infer<T>; meta: CallMeta }> {
    if (!this.ledger.allows(cu, priority)) throw new BudgetExhaustedError(endpoint);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const started = this.opts.clock.nowMs();
    let attempts = 0;
    let lastError: unknown;
    while (attempts < this.maxAttempts) {
      attempts++;
      const turn = this.bucket.take();
      if (!turn.ok) await this.sleep(turn.waitMs);
      let res: HttpResponse;
      try {
        res = await this.opts.transport({ method: 'GET', url: url.toString(), headers: { 'X-API-KEY': this.opts.apiKey, 'x-chain': this.chain, accept: 'application/json' }, timeoutMs: this.timeoutMs });
      } catch (err) {
        lastError = err;
        await this.sleep(this.backoffMs(attempts, undefined));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url.toString(), res.body);
        await this.sleep(this.backoffMs(attempts, res.headers['retry-after']));
        continue;
      }
      if (res.status !== 200) throw new HttpError(res.status, url.toString(), res.body);
      // Charged on every accepted response, before validation: the provider billed it either way.
      this.ledger.charge(endpoint, cu);
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new ProviderResponseError(endpoint, 'response is not JSON');
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new ProviderResponseError(endpoint, `unexpected shape: ${parsed.error.issues[0]?.path.join('.') ?? '?'} ${parsed.error.issues[0]?.message ?? ''}`);
      const observedAt = this.opts.clock.now();
      return { data: parsed.data, meta: { endpoint, latencyMs: this.opts.clock.nowMs() - started, computeUnits: cu, attempts, observedAt } };
    }
    throw lastError instanceof Error ? lastError : new Error(`Birdeye ${endpoint}: ${String(lastError)}`);
  }

  private backoffMs(attempt: number, retryAfter: string | undefined): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra > 0) return Math.min(30_000, ra * 1000);
    return Math.min(30_000, 500 * 2 ** (attempt - 1));
  }

  /** GET /defi/v3/ohlcv for one asset and resolution over [from, to) in bucket time. */
  async candles(input: { assetId: Uuid; mintAddress: string; resolution: CandleResolution; from: Instant; to: Instant; provenance: DataProvenance; priority?: RequestPriority }): Promise<NormalizedCandles & { meta: CallMeta }> {
    const fromS = Math.floor(Date.parse(input.from) / 1000);
    const toS = Math.floor(Date.parse(input.to) / 1000);
    if (!(toS > fromS)) throw new RangeError('candles: to must be after from');
    const expected = Math.ceil(((toS - fromS) * 1000) / RESOLUTION_MS[input.resolution]);
    if (expected > BIRDEYE_ENDPOINT_LIMITS.ohlcvMaxItems) throw new RangeError(`candles: range needs ${expected} buckets; max ${BIRDEYE_ENDPOINT_LIMITS.ohlcvMaxItems} per request`);
    const { data, meta } = await this.get(
      'ohlcv_v3',
      '/defi/v3/ohlcv',
      { address: input.mintAddress, type: BIRDEYE_INTERVAL[input.resolution], time_from: fromS, time_to: toS, currency: 'usd', mode: 'range', outlier: true },
      OhlcvV3Response,
      BIRDEYE_CU.ohlcvV3(expected),
      input.priority ?? 'NORMAL',
    );
    if (!data.success || !data.data) throw new ProviderResponseError('ohlcv_v3', data.message ?? 'success=false');
    const normalized = normalizeCandles(data.data.items, { assetId: input.assetId, resolution: input.resolution, provenance: input.provenance, observedAt: meta.observedAt });
    return { ...normalized, meta };
  }

  /** GET /defi/multi_price for up to 100 mints. Absent or zero prices are simply not returned. */
  async prices(mints: readonly string[], priority: RequestPriority = 'NORMAL'): Promise<{ quotes: PriceQuote[]; meta: CallMeta }> {
    if (mints.length === 0) throw new RangeError('prices: at least one mint');
    if (mints.length > BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses) throw new RangeError(`prices: max ${BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses} mints per request`);
    const { data, meta } = await this.get('multi_price', '/defi/multi_price', { list_address: mints.join(','), include_liquidity: true }, MultiPriceResponse, BIRDEYE_CU.multiPrice(mints.length), priority);
    if (!data.success) throw new ProviderResponseError('multi_price', data.message ?? 'success=false');
    return { quotes: normalizePrices(data.data, meta.observedAt), meta };
  }

  async trending(input: { interval?: '1h' | '4h' | '24h'; limit?: number; offset?: number } = {}): Promise<{ tokens: DiscoveredToken[]; meta: CallMeta }> {
    const limit = Math.min(input.limit ?? BIRDEYE_ENDPOINT_LIMITS.trendingMaxLimit, BIRDEYE_ENDPOINT_LIMITS.trendingMaxLimit);
    const { data, meta } = await this.get('token_trending', '/defi/token_trending', { sort_by: 'rank', sort_type: 'asc', interval: input.interval ?? '24h', offset: input.offset ?? 0, limit }, TrendingResponse, BIRDEYE_CU.tokenTrending, 'NORMAL');
    if (!data.success || !data.data) throw new ProviderResponseError('token_trending', data.message ?? 'success=false');
    const updated = typeof data.data.updateUnixTime === 'number' && data.data.updateUnixTime > 0 ? toInstant(data.data.updateUnixTime * 1000) : null;
    return { tokens: normalizeTrending(data.data.tokens, updated, meta.observedAt), meta };
  }

  async newListings(input: { limit?: number; timeTo?: Instant; memePlatforms?: boolean } = {}): Promise<{ tokens: DiscoveredToken[]; meta: CallMeta }> {
    const limit = Math.min(input.limit ?? BIRDEYE_ENDPOINT_LIMITS.newListingMaxLimit, BIRDEYE_ENDPOINT_LIMITS.newListingMaxLimit);
    const { data, meta } = await this.get(
      'new_listing',
      '/defi/v2/tokens/new_listing',
      { limit, time_to: input.timeTo ? Math.floor(Date.parse(input.timeTo) / 1000) : undefined, meme_platform_enabled: input.memePlatforms ?? false },
      NewListingResponse,
      BIRDEYE_CU.newListing,
      'NORMAL',
    );
    if (!data.success || !data.data) throw new ProviderResponseError('new_listing', data.message ?? 'success=false');
    return { tokens: normalizeNewListings(data.data.items, meta.observedAt), meta };
  }

  async tokenList(input: { minLiquidityUsd?: number; minVolume24hUsd?: number; offset?: number; limit?: number; sortBy?: 'liquidity' | 'volume_24h_usd' | 'recent_listing_time' } = {}): Promise<{ tokens: DiscoveredToken[]; hasNext: boolean; meta: CallMeta }> {
    const limit = Math.min(input.limit ?? BIRDEYE_ENDPOINT_LIMITS.tokenListMaxLimit, BIRDEYE_ENDPOINT_LIMITS.tokenListMaxLimit);
    const offset = Math.min(input.offset ?? 0, BIRDEYE_ENDPOINT_LIMITS.tokenListMaxOffset);
    const { data, meta } = await this.get(
      'token_list_v3',
      '/defi/v3/token/list',
      { sort_by: input.sortBy ?? 'liquidity', sort_type: 'desc', offset, limit, min_liquidity: input.minLiquidityUsd, min_volume_24h_usd: input.minVolume24hUsd },
      TokenListResponse,
      BIRDEYE_CU.tokenListV3,
      'NORMAL',
    );
    if (!data.success || !data.data) throw new ProviderResponseError('token_list_v3', data.message ?? 'success=false');
    return { tokens: normalizeTokenList(data.data.items, meta.observedAt), hasNext: data.data.hasNext ?? false, meta };
  }

  /** GET /defi/token_security: analytics corroboration for the chain read, never authority (D45). */
  async security(mintAddress: string, priority: RequestPriority = 'NORMAL'): Promise<{ security: TokenSecurityReport | null; meta: CallMeta }> {
    const { data, meta } = await this.get('token_security', '/defi/token_security', { address: mintAddress }, TokenSecurityResponse, BIRDEYE_CU.tokenSecurity, priority);
    if (!data.success || !data.data) throw new ProviderResponseError('token_security', data.message ?? 'success=false');
    return { security: normalizeSecurity(mintAddress, data.data, meta.observedAt), meta };
  }

  async overview(mintAddress: string, priority: RequestPriority = 'NORMAL'): Promise<{ overview: TokenOverview | null; meta: CallMeta }> {
    const { data, meta } = await this.get('token_overview', '/defi/token_overview', { address: mintAddress }, TokenOverviewResponse, BIRDEYE_CU.tokenOverview, priority);
    if (!data.success || !data.data) throw new ProviderResponseError('token_overview', data.message ?? 'success=false');
    return { overview: normalizeOverview(data.data, meta.observedAt), meta };
  }
}
