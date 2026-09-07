import { z } from 'zod';
import {
  Amount,
  MintAddress,
  Quote,
  QuoteRouteHop,
  SolanaAddress,
  type Bps,
  type Clock,
  type JupiterQuoteClient,
  type OrderBuild,
  type QuoteOptions,
  type QuoteRequest,
  type QuoteRoutePlan,
  type Slot,
  type SolanaAddress as SolanaAddressType,
} from '@sol-agent-trader/contracts';
import { fetchJupiterTransport, type JupiterHttpTransport } from './http.js';
import { programForLabel } from './programs.js';

/**
 * The one shared Jupiter quote client (ADR-0003; blueprint §3.3, §7.2, §14.6). Both execution
 * adapters and the eligibility probes consume it; a second quote path is a boundary violation.
 *
 * Quote-only in M4: `buildOrder` returns the quote without a transaction (the transaction build
 * and the §15.4 validation chain arrive with the live adapter in M3). Nothing here signs.
 *
 * Price impact is measured, not trusted: the quoted rate at the requested size is compared with
 * the rate for a reference quote 100× smaller, and the shortfall in basis points is the impact.
 * The provider's own `priceImpactPct` is kept verbatim for attribution only.
 */

const RouteHopRaw = z.looseObject({
  swapInfo: z.looseObject({ ammKey: z.string(), label: z.string(), inputMint: z.string(), outputMint: z.string(), inAmount: z.string(), outAmount: z.string() }),
  percent: z.number().nullable().optional(),
});
const QuoteRaw = z.looseObject({
  inputMint: z.string(),
  inAmount: z.string(),
  outputMint: z.string(),
  outAmount: z.string(),
  otherAmountThreshold: z.string(),
  swapMode: z.string(),
  slippageBps: z.number().int(),
  priceImpactPct: z.union([z.string(), z.number()]).nullable().optional(),
  routePlan: z.array(RouteHopRaw),
  contextSlot: z.number().int().nullable().optional(),
});
const QuoteErrorRaw = z.looseObject({ error: z.string().optional(), errorCode: z.string().optional() });

export class NoRouteError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`no route: ${code}: ${detail}`);
    this.name = 'NoRouteError';
  }
}
export class JupiterHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Jupiter HTTP ${status}: ${detail.slice(0, 200)}`);
    this.name = 'JupiterHttpError';
  }
}

/** Error codes Jupiter returns for "this pair cannot be routed" rather than "try again". */
const NO_ROUTE_CODES = new Set(['COULD_NOT_FIND_ANY_ROUTE', 'TOKEN_NOT_TRADABLE', 'NOT_SUPPORTED', 'CIRCULAR_ARBITRAGE_IS_DISABLED', 'ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT']);

export interface JupiterSwapClientOptions {
  transport?: JupiterHttpTransport;
  clock: Clock;
  apiKey?: string;
  baseUrl?: string;
  /** Free host tolerates about one request per second. */
  requestsPerSecond?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Reference quote divisor for impact measurement (default 100). */
  impactReferenceDivisor?: number;
}

export class JupiterSwapClient implements JupiterQuoteClient {
  private readonly transport: JupiterHttpTransport;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ratePerSecond: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly divisor: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly opts: JupiterSwapClientOptions) {
    this.transport = opts.transport ?? fetchJupiterTransport;
    this.baseUrl = (opts.baseUrl ?? (opts.apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')).replace(/\/$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ratePerSecond = opts.requestsPerSecond ?? 1;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.divisor = opts.impactReferenceDivisor ?? 100;
    this.tokens = Math.max(1, Math.floor(this.ratePerSecond));
    this.lastRefillMs = opts.clock.nowMs();
  }

  private async pace(): Promise<void> {
    const now = this.opts.clock.nowMs();
    const burst = Math.max(1, Math.floor(this.ratePerSecond));
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefillMs) / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    this.tokens = 0;
    this.lastRefillMs = this.opts.clock.nowMs();
  }

  private async rawQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number, options: QuoteOptions | undefined): Promise<z.infer<typeof QuoteRaw>> {
    // Built by hand so spaces in venue labels become %20, not the form-style "+".
    const params: [string, string][] = [
      ['inputMint', inputMint],
      ['outputMint', outputMint],
      ['amount', amount],
      ['slippageBps', String(slippageBps)],
      ['swapMode', 'ExactIn'],
    ];
    if (options?.onlyDirectRoutes) params.push(['onlyDirectRoutes', 'true']);
    if (options?.dexes && options.dexes.length > 0) params.push(['dexes', options.dexes.join(',')]);
    if (options?.maxAccounts) params.push(['maxAccounts', String(options.maxAccounts)]);
    const url = new URL(`${this.baseUrl}/swap/v1/quote?${params.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`).join('&')}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace();
      let status: number;
      let body: string;
      try {
        const res = await this.transport({ url: url.toString(), headers, timeoutMs: this.timeoutMs });
        status = res.status;
        body = res.body;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      if (status === 429 || status >= 500) {
        lastError = new JupiterHttpError(status, body);
        await this.sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new JupiterHttpError(status, 'response is not JSON');
      }
      if (status !== 200) {
        const err = QuoteErrorRaw.safeParse(json);
        const code = err.success ? (err.data.errorCode ?? 'UNKNOWN') : 'UNKNOWN';
        const detail = err.success ? (err.data.error ?? '') : body;
        if (status === 400 && NO_ROUTE_CODES.has(code)) throw new NoRouteError(code, detail);
        throw new JupiterHttpError(status, `${code} ${detail}`);
      }
      const parsed = QuoteRaw.safeParse(json);
      if (!parsed.success) throw new JupiterHttpError(200, `unexpected quote shape: ${parsed.error.issues[0]?.message ?? ''}`);
      return parsed.data;
    }
    throw lastError ?? new JupiterHttpError(0, 'exhausted attempts');
  }

  private normalize(raw: z.infer<typeof QuoteRaw>, request: QuoteRequest, impactBps: number): { quote: Quote; route: QuoteRoutePlan } {
    const hops = raw.routePlan.map((h) => {
      const known = programForLabel(h.swapInfo.label);
      return QuoteRouteHop.parse({
        ammKey: h.swapInfo.ammKey,
        label: h.swapInfo.label.slice(0, 64),
        programId: known?.programId ?? null,
        inputMint: h.swapInfo.inputMint,
        outputMint: h.swapInfo.outputMint,
        inputAmount: h.swapInfo.inAmount,
        outputAmount: h.swapInfo.outAmount,
        percent: h.percent ?? 100,
      });
    });
    const quote = Quote.parse({
      provider: 'JUPITER',
      providerRequestId: null,
      routerLabel: hops.map((h) => h.label).join('>') || null,
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inputAmount: raw.inAmount,
      expectedOutputAmount: raw.outAmount,
      minOutputAmount: raw.otherAmountThreshold,
      priceImpactBps: impactBps,
      slippageBps: raw.slippageBps,
      routeProgramIds: [...new Set(hops.map((h) => h.programId).filter((p): p is SolanaAddressType => p !== null))],
      usesAddressLookupTables: false,
      quotedAt: this.opts.clock.now(),
      expiresAt: null,
      lastValidBlockHeight: null,
    });
    return { quote, route: { hops, contextSlot: (raw.contextSlot ?? null) as Slot | null, providerImpactPct: raw.priceImpactPct === null || raw.priceImpactPct === undefined ? null : String(raw.priceImpactPct).slice(0, 64) } };
  }

  async quote(request: QuoteRequest, options?: QuoteOptions): Promise<{ quote: Quote; route: QuoteRoutePlan }> {
    MintAddress.parse(request.inputMint);
    MintAddress.parse(request.outputMint);
    SolanaAddress.parse(request.taker);
    const amount = Amount.parse(request.inputAmount);
    const raw = await this.rawQuote(request.inputMint, request.outputMint, amount, request.maxSlippageBps, options);
    // Impact: rate at size vs rate at size/divisor (both ExactIn on the same pair and route constraints).
    const refAmount = BigInt(amount) / BigInt(this.divisor);
    let impactBps = 0;
    if (refAmount > 0n && refAmount < BigInt(amount)) {
      const ref = await this.rawQuote(request.inputMint, request.outputMint, refAmount.toString(), request.maxSlippageBps, options);
      impactBps = measureImpactBps({ inAmount: raw.inAmount, outAmount: raw.outAmount }, { inAmount: ref.inAmount, outAmount: ref.outAmount });
    }
    return this.normalize(raw, request, impactBps as Bps);
  }

  async buildOrder(request: QuoteRequest): Promise<OrderBuild> {
    const { quote } = await this.quote(request);
    return { quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] };
  }
}

/** Shortfall of the sized rate against the reference rate, in basis points (never negative). */
export function measureImpactBps(sized: { inAmount: string; outAmount: string }, reference: { inAmount: string; outAmount: string }): number {
  const sizedRate = Number(sized.outAmount) / Number(sized.inAmount);
  const refRate = Number(reference.outAmount) / Number(reference.inAmount);
  if (!(refRate > 0) || !Number.isFinite(sizedRate)) return 10_000;
  return Math.min(10_000, Math.max(0, Math.round((1 - sizedRate / refRate) * 10_000)));
}
