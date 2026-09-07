import type { Clock, TxSignature } from '@sol-agent-trader/contracts';
import { parseHeliusTransaction, type ParseOutcome } from './parse.js';

/**
 * Helius Parsed Events client (blueprint §3.2). Read-only HTTP over an injected transport; the
 * API key travels only as the `api-key` query parameter and is stripped from every error message.
 * The client parses transactions we already know the signatures of (from the read-only RPC's
 * getSignaturesForAddress), so provider-side filtering can never hide a movement from us.
 */

export interface HeliusHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export interface HeliusHttpResponse {
  status: number;
  body: string;
}
export type HeliusTransport = (req: HeliusHttpRequest) => Promise<HeliusHttpResponse>;

export const fetchHeliusTransport: HeliusTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

export class HeliusError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(`helius: ${message}`);
    this.name = 'HeliusError';
  }
}

export interface HeliusClientOptions {
  apiKey: string;
  clock: Clock;
  transport?: HeliusTransport;
  baseUrl?: string;
  timeoutMs?: number;
  /** Free tier allows 10 rps; keep well under it. Default 2. */
  requestsPerSecond?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  commitment?: 'confirmed' | 'finalized';
}

const MAX_SIGNATURES_PER_CALL = 100;

export class HeliusClient {
  private readonly transport: HeliusTransport;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rate: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly commitment: 'confirmed' | 'finalized';
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly opts: HeliusClientOptions) {
    if (!opts.apiKey) throw new RangeError('helius api key required');
    this.transport = opts.transport ?? fetchHeliusTransport;
    this.baseUrl = opts.baseUrl ?? 'https://mainnet.helius-rpc.com';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.rate = opts.requestsPerSecond ?? 2;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.commitment = opts.commitment ?? 'confirmed';
    this.tokens = Math.max(1, Math.floor(this.rate));
    this.lastRefillMs = opts.clock.nowMs();
  }

  private async pace(): Promise<void> {
    const now = this.opts.clock.nowMs();
    const burst = Math.max(1, Math.floor(this.rate));
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefillMs) / 1000) * this.rate);
    this.lastRefillMs = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    this.tokens = 0;
    this.lastRefillMs = this.opts.clock.nowMs();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}?api-key=${encodeURIComponent(this.opts.apiKey)}`;
    let last: HeliusError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace();
      let res: HeliusHttpResponse;
      try {
        res = await this.transport({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: this.timeoutMs });
      } catch (err) {
        last = new HeliusError(null, `transport: ${this.redact(err instanceof Error ? err.message : String(err))}`);
        await this.sleep(Math.min(20_000, 1_000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        last = new HeliusError(res.status, `HTTP ${res.status}`);
        await this.sleep(Math.min(20_000, 1_000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new HeliusError(res.status, 'authentication rejected');
      if (res.status !== 200) throw new HeliusError(res.status, `HTTP ${res.status}`);
      try {
        return JSON.parse(res.body) as unknown;
      } catch {
        throw new HeliusError(res.status, 'response is not JSON');
      }
    }
    throw last ?? new HeliusError(null, 'exhausted attempts');
  }

  /** Never let the key leak through an error string that embeds the URL. */
  private redact(s: string): string {
    return s.split(this.opts.apiKey).join('<redacted>');
  }

  /**
   * Parsed history of one address, oldest first after `afterSignature` (or the newest page when
   * no cursor exists). Returns the provider's pagination token when more pages remain.
   */
  async transactionHistory(opts: { address: string; afterSignature?: string | null; limit?: number; paginationToken?: string | null }): Promise<{ items: ParseOutcome[]; paginationToken: string | null }> {
    const body: Record<string, unknown> = { address: opts.address, limit: Math.min(MAX_SIGNATURES_PER_CALL, opts.limit ?? MAX_SIGNATURES_PER_CALL), commitment: this.commitment, sortOrder: opts.afterSignature ? 'asc' : 'desc' };
    if (opts.afterSignature) body['afterSignature'] = opts.afterSignature;
    if (opts.paginationToken) body['paginationToken'] = opts.paginationToken;
    const json = await this.post('/v1/parsed-events/transaction-history', body);
    const data = Array.isArray(json) ? json : (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new HeliusError(200, 'unexpected history shape');
    const items = data.map(parseHeliusTransaction);
    const token = (json as { paginationToken?: unknown })?.paginationToken;
    return { items: opts.afterSignature ? items : items.reverse(), paginationToken: typeof token === 'string' && token.length > 0 ? token : null };
  }

  /** Parses the given signatures, in input order, chunked to the provider's limit. */
  async parseTransactions(signatures: readonly TxSignature[]): Promise<ParseOutcome[]> {
    const out: ParseOutcome[] = [];
    for (let i = 0; i < signatures.length; i += MAX_SIGNATURES_PER_CALL) {
      const chunk = signatures.slice(i, i + MAX_SIGNATURES_PER_CALL);
      const json = await this.post('/v1/parsed-events/transactions', { transactions: chunk, commitment: this.commitment });
      const items = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
      if (!items) throw new HeliusError(200, 'unexpected response shape');
      const bySig = new Map<string, unknown>();
      for (const it of items) if (typeof it === 'object' && it !== null && typeof (it as { signature?: unknown }).signature === 'string') bySig.set((it as { signature: string }).signature, it);
      for (const sig of chunk) {
        const it = bySig.get(sig);
        out.push(it === undefined ? { ok: false, signature: sig, reason: 'PARSER_ERROR' } : parseHeliusTransaction(it));
      }
    }
    return out;
  }
}
