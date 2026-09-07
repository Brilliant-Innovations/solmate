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

const READ_ONLY_METHODS = ['getAccountInfo', 'getMultipleAccounts', 'getTokenSupply', 'getTokenLargestAccounts', 'getSlot', 'getBlockHeight'] as const;
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

export class SolanaRpcClient {
  private readonly transport: RpcTransport;
  private readonly commitment: Commitment;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(private readonly opts: SolanaRpcClientOptions) {
    const origin = new URL(opts.url).origin;
    if (!opts.allowedOrigins.includes(origin)) throw new RangeError(`rpc endpoint ${origin} is not on the allowlist`);
    this.transport = opts.transport ?? fetchRpcTransport;
    this.commitment = opts.commitment ?? 'confirmed';
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  private async call<T extends z.ZodType>(method: ReadOnlyMethod, params: unknown[], schema: T): Promise<z.infer<T>> {
    if (!READ_ONLY_METHODS.includes(method)) throw new RpcError(method, null, 'method not permitted');
    const id = this.nextId++;
    const res = await this.transport({ url: this.opts.url, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), timeoutMs: this.timeoutMs });
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
}
