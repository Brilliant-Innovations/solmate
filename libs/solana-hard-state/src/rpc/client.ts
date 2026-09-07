import { z } from 'zod';

/**
 * Minimal read-only Solana JSON-RPC client (blueprint D45, D52; GUARDRAILS Part 4: this library
 * has no signer, keypair, wallet or sendTransaction capability, and the risk-authorizer may only
 * reach the narrow read-only RPC path). The endpoint must be on the allowlist given at
 * construction; the method set is closed. Transport is injected so tests replay recorded responses.
 */

export interface RpcHttpRequest {
  url: string;
  body: string;
  timeoutMs: number;
}
export interface RpcHttpResponse {
  status: number;
  body: string;
}
export type RpcTransport = (req: RpcHttpRequest) => Promise<RpcHttpResponse>;

export const fetchRpcTransport: RpcTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

export type Commitment = 'confirmed' | 'finalized';

const READ_ONLY_METHODS = ['getAccountInfo', 'getMultipleAccounts', 'getTokenSupply', 'getTokenLargestAccounts', 'getSlot', 'getBlockHeight', 'getBalance', 'getTokenAccountsByOwner', 'getSignaturesForAddress'] as const;
export type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];

const RpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`rpc ${method}: ${message}`);
    this.name = 'RpcError';
  }
}

export interface SolanaRpcClientOptions {
  url: string;
  /** Exact origins this process may talk to. The constructor refuses anything else. */
  allowedOrigins: readonly string[];
  transport?: RpcTransport;
  commitment?: Commitment;
  timeoutMs?: number;
  /** Pacing for the endpoint's published limit; the public mainnet endpoint tolerates only a few per second. Default 4. */
  requestsPerSecond?: number;
  /** Bounded retry on 429/5xx/transport failure. Default 4 attempts with 1s·2^n backoff. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Millisecond clock for pacing; injectable for tests. */
  nowMs?: () => number;
}

export const AccountInfo = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z
    .object({
      data: z.tuple([z.string(), z.literal('base64')]),
      owner: z.string(),
      lamports: z.number(),
      executable: z.boolean(),
    })
    .nullable(),
});
export type AccountInfo = z.infer<typeof AccountInfo>;

export const TokenAmount = z.object({
  amount: z.string().regex(/^[0-9]+$/),
  decimals: z.number().int().min(0).max(18),
});

export const TokenSupply = z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: TokenAmount });
export const TokenLargestAccounts = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(TokenAmount.extend({ address: z.string() })).max(20),
});

export const Balance = z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.number().int().nonnegative() });

/** jsonParsed token account as returned by getTokenAccountsByOwner. */
export const ParsedTokenAccount = z.object({
  pubkey: z.string(),
  account: z.object({
    owner: z.string(),
    lamports: z.number(),
    data: z.object({
      program: z.string(),
      parsed: z.object({
        type: z.string(),
        info: z.object({
          mint: z.string(),
          owner: z.string(),
          tokenAmount: TokenAmount,
          state: z.string().optional(),
        }),
      }),
    }),
  }),
});
export const TokenAccountsByOwner = z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.array(ParsedTokenAccount) });
export type TokenAccountsByOwner = z.infer<typeof TokenAccountsByOwner>;

export const SignatureInfo = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable().optional(),
  err: z.unknown().nullable().optional(),
});
export type SignatureInfo = z.infer<typeof SignatureInfo>;

/** getMultipleAccounts with jsonParsed encoding; `data` is left loose because non-token accounts come back as base64 tuples. */
export const MultipleAccountsParsed = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(z.object({ owner: z.string(), lamports: z.number(), executable: z.boolean(), data: z.unknown() }).nullable()),
});
export type MultipleAccountsParsed = z.infer<typeof MultipleAccountsParsed>;

export class SolanaRpcClient {
  private readonly transport: RpcTransport;
  private readonly commitment: Commitment;
  private readonly timeoutMs: number;
  private readonly ratePerSecond: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private nextId = 1;
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly opts: SolanaRpcClientOptions) {
    const origin = new URL(opts.url).origin;
    if (!opts.allowedOrigins.includes(origin)) throw new RangeError(`rpc endpoint ${origin} is not on the allowlist`);
    this.transport = opts.transport ?? fetchRpcTransport;
    this.commitment = opts.commitment ?? 'confirmed';
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.ratePerSecond = opts.requestsPerSecond ?? 4;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.tokens = Math.max(1, Math.floor(this.ratePerSecond));
    this.lastRefillMs = this.nowMs();
  }

  /** Token bucket: waits until a request is within the configured rate. */
  private async pace(): Promise<void> {
    const now = this.nowMs();
    const burst = Math.max(1, Math.floor(this.ratePerSecond));
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefillMs) / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
    await this.sleep(waitMs);
    this.tokens = 0;
    this.lastRefillMs = this.nowMs();
  }

  private async call<T extends z.ZodType>(method: ReadOnlyMethod, params: unknown[], schema: T): Promise<z.infer<T>> {
    if (!READ_ONLY_METHODS.includes(method)) throw new RpcError(method, null, 'method not permitted');
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    let lastError: RpcError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace();
      let res: RpcHttpResponse;
      try {
        res = await this.transport({ url: this.opts.url, body, timeoutMs: this.timeoutMs });
      } catch (err) {
        lastError = new RpcError(method, null, `transport: ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new RpcError(method, null, `HTTP ${res.status}`);
        await this.sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status !== 200) throw new RpcError(method, null, `HTTP ${res.status}`);
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new RpcError(method, null, 'response is not JSON');
      }
      const env = RpcEnvelope.safeParse(json);
      if (!env.success) throw new RpcError(method, null, 'malformed JSON-RPC envelope');
      if (env.data.error) throw new RpcError(method, env.data.error.code, env.data.error.message);
      const parsed = schema.safeParse(env.data.result);
      if (!parsed.success) throw new RpcError(method, null, `unexpected result shape: ${parsed.error.issues[0]?.message ?? ''}`);
      return parsed.data;
    }
    throw lastError ?? new RpcError(method, null, 'exhausted attempts');
  }

  getSlot(): Promise<number> {
    return this.call('getSlot', [{ commitment: this.commitment }], z.number().int().nonnegative());
  }

  getAccountInfo(address: string): Promise<AccountInfo> {
    return this.call('getAccountInfo', [address, { encoding: 'base64', commitment: this.commitment }], AccountInfo);
  }

  getTokenSupply(mint: string): Promise<z.infer<typeof TokenSupply>> {
    return this.call('getTokenSupply', [mint, { commitment: this.commitment }], TokenSupply);
  }

  getTokenLargestAccounts(mint: string): Promise<z.infer<typeof TokenLargestAccounts>> {
    return this.call('getTokenLargestAccounts', [mint, { commitment: this.commitment }], TokenLargestAccounts);
  }

  /** Up to 100 accounts in one call; null entries for addresses that do not exist on chain. */
  getMultipleAccountsParsed(addresses: readonly string[]): Promise<MultipleAccountsParsed> {
    return this.call('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment: this.commitment }], MultipleAccountsParsed);
  }

  getBalance(address: string): Promise<z.infer<typeof Balance>> {
    return this.call('getBalance', [address, { commitment: this.commitment }], Balance);
  }

  /** Every token account of `owner` under one token program, parsed by the node. */
  getTokenAccountsByOwner(owner: string, programId: string): Promise<TokenAccountsByOwner> {
    return this.call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: this.commitment }], TokenAccountsByOwner);
  }

  /** Signatures touching `address`, newest first, stopping at `until` (exclusive) when given. */
  getSignaturesForAddress(address: string, opts: { until?: string | null; before?: string | null; limit?: number } = {}): Promise<SignatureInfo[]> {
    const params: Record<string, unknown> = { commitment: this.commitment, limit: opts.limit ?? 100 };
    if (opts.until) params['until'] = opts.until;
    if (opts.before) params['before'] = opts.before;
    return this.call('getSignaturesForAddress', [address, params], z.array(SignatureInfo));
  }
}
