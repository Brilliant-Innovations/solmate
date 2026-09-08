import { z } from 'zod';
import { Quote, type Bps, type Clock, type MintAddress, type QuoteRequest, type SolanaAddress } from '@sol-agent-trader/contracts';
import { fetchJupiterTransport, type JupiterHttpTransport } from './http.js';
import { JupiterHttpError, NoRouteError, measureImpactBps } from './quote-client.js';
import { programForLabel } from './programs.js';

/**
 * Jupiter Swap V2 `/order` + `/execute` (blueprint §3.3 "Use Swap V2 /order + /execute for normal
 * spot execution", §15.4 steps 1 and 11). The order returns an assembled versioned transaction the
 * executor validates, simulates and signs itself; `/execute` submits the signed bytes under the
 * order's `requestId`. Nothing here signs. Impact is measured against a reference-size quote the
 * same way the quote client does, so the executor's impact cap sees the same number.
 */

export interface JupiterOrder {
  requestId: string;
  quote: Quote;
  transactionBase64: string;
  taker: string;
  router: string | null;
  lastValidBlockHeight: number | null;
  expiresAt: string | null;
}

export interface JupiterExecuteResult {
  status: 'Success' | 'Failed';
  signature: string | null;
  slot: number | null;
  code: number | null;
  error: string | null;
  inputAmountResult: string | null;
  outputAmountResult: string | null;
}

export interface JupiterOrderClient {
  order(request: QuoteRequest, referenceDivisor?: number): Promise<JupiterOrder>;
  execute(signedTransactionBase64: string, requestId: string): Promise<JupiterExecuteResult>;
}

const OrderRaw = z.looseObject({
  requestId: z.string().min(1),
  transaction: z.string().min(1).nullable(),
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string(),
  outAmount: z.string(),
  otherAmountThreshold: z.string(),
  slippageBps: z.number().int(),
  priceImpactPct: z.union([z.string(), z.number()]).nullable().optional(),
  taker: z.string().nullable().optional(),
  router: z.string().nullable().optional(),
  lastValidBlockHeight: z.number().int().nullable().optional(),
  expireAt: z.union([z.string(), z.number()]).nullable().optional(),
  routePlan: z.array(z.looseObject({ swapInfo: z.looseObject({ ammKey: z.string(), label: z.string(), inputMint: z.string(), outputMint: z.string(), inAmount: z.string(), outAmount: z.string() }), percent: z.number().nullable().optional() })).optional(),
  contextSlot: z.number().int().nullable().optional(),
});
const ExecuteRaw = z.looseObject({
  status: z.string(),
  signature: z.string().nullable().optional(),
  slot: z.union([z.number(), z.string()]).nullable().optional(),
  code: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  inputAmountResult: z.string().nullable().optional(),
  outputAmountResult: z.string().nullable().optional(),
});
const ErrorRaw = z.looseObject({ error: z.string().optional(), errorCode: z.string().optional() });

export interface JupiterOrderHttpClientOptions {
  apiKey?: string;
  baseUrl?: string;
  transport?: JupiterHttpTransport;
  clock: Clock;
  timeoutMs?: number;
}

export class JupiterOrderHttpClient implements JupiterOrderClient {
  private readonly transport: JupiterHttpTransport;
  private readonly baseUrl: string;

  constructor(private readonly opts: JupiterOrderHttpClientOptions) {
    this.transport = opts.transport ?? fetchJupiterTransport;
    this.baseUrl = (opts.baseUrl ?? (opts.apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')).replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) h['x-api-key'] = this.opts.apiKey;
    return h;
  }

  private async rawOrder(request: QuoteRequest, amount: string): Promise<z.infer<typeof OrderRaw>> {
    const params: [string, string][] = [['inputMint', request.inputMint], ['outputMint', request.outputMint], ['amount', amount], ['slippageBps', String(request.maxSlippageBps)], ['taker', request.taker], ['swapMode', 'ExactIn']];
    const url = `${this.baseUrl}/swap/v2/order?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
    const res = await this.transport({ url, headers: this.headers(), timeoutMs: this.opts.timeoutMs ?? 10_000 });
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new JupiterHttpError(res.status, 'order response is not JSON');
    }
    if (res.status !== 200) {
      const err = ErrorRaw.safeParse(json);
      const code = err.success ? (err.data.errorCode ?? 'UNKNOWN') : 'UNKNOWN';
      const detail = err.success ? (err.data.error ?? '') : res.body;
      if (res.status === 400 && /ROUTE/i.test(code)) throw new NoRouteError(code, detail);
      throw new JupiterHttpError(res.status, `${code} ${detail}`);
    }
    const parsed = OrderRaw.safeParse(json);
    if (!parsed.success) throw new JupiterHttpError(200, `unexpected order shape: ${parsed.error.issues[0]?.message ?? ''}`);
    return parsed.data;
  }

  async order(request: QuoteRequest, referenceDivisor = 100): Promise<JupiterOrder> {
    const raw = await this.rawOrder(request, request.inputAmount);
    if (!raw.transaction) throw new JupiterHttpError(200, 'order carried no transaction');
    // Reference quote at a fraction of the size for measured impact, as the quote client does (§7.2).
    let impactBps: number | null = null;
    const ref = BigInt(request.inputAmount) / BigInt(referenceDivisor);
    if (ref > 0n) {
      try {
        const small = await this.rawOrder(request, ref.toString());
        impactBps = measureImpactBps({ inAmount: raw.inAmount, outAmount: raw.outAmount }, { inAmount: small.inAmount, outAmount: small.outAmount });
      } catch {
        impactBps = null;
      }
    }
    const hops = (raw.routePlan ?? []).map((h) => ({ label: h.swapInfo.label, programId: programForLabel(h.swapInfo.label)?.programId ?? null }));
    const quote = Quote.parse({
      provider: 'JUPITER',
      providerRequestId: raw.requestId,
      routerLabel: raw.router ?? (hops.map((h) => h.label).join('>') || null),
      inputMint: raw.inputMint as MintAddress,
      outputMint: raw.outputMint as MintAddress,
      inputAmount: raw.inAmount,
      expectedOutputAmount: raw.outAmount,
      minOutputAmount: raw.otherAmountThreshold,
      priceImpactBps: impactBps as Bps | null,
      slippageBps: raw.slippageBps,
      routeProgramIds: [...new Set(hops.map((h) => h.programId).filter((p): p is SolanaAddress => p !== null))],
      usesAddressLookupTables: false,
      quotedAt: this.opts.clock.now(),
      expiresAt: raw.expireAt ? new Date(typeof raw.expireAt === 'number' ? raw.expireAt * 1000 : raw.expireAt).toISOString() : null,
      lastValidBlockHeight: raw.lastValidBlockHeight ?? null,
    });
    return { requestId: raw.requestId, quote, transactionBase64: raw.transaction, taker: raw.taker ?? request.taker, router: raw.router ?? null, lastValidBlockHeight: raw.lastValidBlockHeight ?? null, expiresAt: quote.expiresAt };
  }

  async execute(signedTransactionBase64: string, requestId: string): Promise<JupiterExecuteResult> {
    const res = await this.transport({ url: `${this.baseUrl}/swap/v2/execute`, headers: { ...this.headers(), 'content-type': 'application/json' }, timeoutMs: this.opts.timeoutMs ?? 30_000, method: 'POST', body: JSON.stringify({ signedTransaction: signedTransactionBase64, requestId }) });
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new JupiterHttpError(res.status, 'execute response is not JSON');
    }
    const parsed = ExecuteRaw.safeParse(json);
    if (!parsed.success) throw new JupiterHttpError(res.status, `unexpected execute shape: ${parsed.error.issues[0]?.message ?? ''}`);
    const r = parsed.data;
    return {
      status: r.status === 'Success' ? 'Success' : 'Failed',
      signature: r.signature ?? null,
      slot: r.slot === null || r.slot === undefined ? null : Number(r.slot),
      code: r.code ?? null,
      error: r.error ?? (res.status !== 200 ? `HTTP ${res.status}` : null),
      inputAmountResult: r.inputAmountResult ?? null,
      outputAmountResult: r.outputAmountResult ?? null,
    };
  }
}
