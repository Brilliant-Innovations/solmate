import { z } from 'zod';
import { fetchRpcTransport, type RpcTransport } from '@sol-agent-trader/solana-hard-state';
import type { TxSignature } from '@sol-agent-trader/contracts';

/**
 * Direct RPC submission for the provider-independent emergency path (blueprint §14.6 step 7,
 * D33). The executor is the only deployable allowed to send a transaction, and this module is the
 * only place in the execution library that does: two methods, a closed set, an allowlisted origin.
 * It never signs; it carries an already-signed transaction and reads the blockhash the message
 * must be built against. Production talks JSON-RPC; the execution harness fakes the interface.
 */

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface TransactionSubmitter {
  readonly label: string;
  latestBlockhash(): Promise<LatestBlockhash>;
  /** Sends a signed transaction (base64) with preflight disabled: the executor already simulated it independently. */
  send(signedTransactionBase64: string): Promise<TxSignature>;
}

export class SubmitError extends Error {
  constructor(readonly method: string, message: string, readonly code: number | null = null) {
    super(`${method}: ${message}`);
    this.name = 'SubmitError';
  }
}

export interface RpcTransactionSubmitterOptions {
  url: string;
  allowedOrigins: readonly string[];
  label: string;
  transport?: RpcTransport;
  timeoutMs?: number;
}

const Envelope = z.object({ result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const BlockhashResult = z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.object({ blockhash: z.string().min(32), lastValidBlockHeight: z.number().int().nonnegative() }) });

export class RpcTransactionSubmitter implements TransactionSubmitter {
  private readonly transport: RpcTransport;
  private id = 0;

  constructor(private readonly opts: RpcTransactionSubmitterOptions) {
    const origin = new URL(opts.url).origin;
    if (!opts.allowedOrigins.includes(origin)) throw new SubmitError('init', `endpoint ${origin} is not on the allowlist`);
    this.transport = opts.transport ?? fetchRpcTransport;
  }

  get label(): string {
    return this.opts.label;
  }

  private async call<T extends z.ZodType>(method: 'getLatestBlockhash' | 'sendTransaction', params: unknown[], schema: T): Promise<z.infer<T>> {
    const id = ++this.id;
    const res = await this.transport({ url: this.opts.url, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), timeoutMs: this.opts.timeoutMs ?? 15_000 });
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new SubmitError(method, 'response is not JSON');
    }
    const env = Envelope.safeParse(json);
    if (!env.success) throw new SubmitError(method, 'malformed JSON-RPC envelope');
    if (env.data.error) throw new SubmitError(method, env.data.error.message, env.data.error.code);
    const parsed = schema.safeParse(env.data.result);
    if (!parsed.success) throw new SubmitError(method, `unexpected result shape: ${parsed.error.issues[0]?.message ?? ''}`);
    return parsed.data;
  }

  async latestBlockhash(): Promise<LatestBlockhash> {
    const r = await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }], BlockhashResult);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
  }

  async send(signedTransactionBase64: string): Promise<TxSignature> {
    const sig = await this.call('sendTransaction', [signedTransactionBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' }], z.string().min(32));
    return sig as TxSignature;
  }
}
