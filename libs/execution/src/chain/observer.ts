import { z } from 'zod';
import { fetchRpcTransport, type RpcTransport } from '@sol-agent-trader/solana-hard-state';

/**
 * What the executor needs from the chain to resolve an attempt it signed or submitted (§15.4
 * staged reconciliation, §21.3 restart recovery, INV-23): did this signature land, at what
 * commitment, and has the transaction's block height expired so it can never land. Read-only;
 * the method set is closed. Production talks JSON-RPC; the execution harness fakes it.
 */

export interface SignatureStatus {
  slot: number;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
  err: unknown | null;
}

export interface ChainObserver {
  readonly label: string;
  /** null when the signature is unknown to the node (including history). */
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
  blockHeight(): Promise<number>;
}

export class ChainObserverError extends Error {
  constructor(readonly method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'ChainObserverError';
  }
}

const StatusResult = z.object({
  value: z.array(z.object({ slot: z.number().int().nonnegative(), confirmationStatus: z.enum(['processed', 'confirmed', 'finalized']).nullable(), err: z.unknown().nullable() }).nullable()),
});
const Envelope = z.object({ result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });

export interface RpcChainObserverOptions {
  url: string;
  allowedOrigins: readonly string[];
  label: string;
  transport?: RpcTransport;
  timeoutMs?: number;
}

export class RpcChainObserver implements ChainObserver {
  private readonly transport: RpcTransport;
  private id = 0;

  constructor(private readonly opts: RpcChainObserverOptions) {
    const origin = new URL(opts.url).origin;
    if (!opts.allowedOrigins.includes(origin)) throw new ChainObserverError('init', `endpoint ${origin} is not on the allowlist`);
    this.transport = opts.transport ?? fetchRpcTransport;
  }

  get label(): string {
    return this.opts.label;
  }

  private async call<T extends z.ZodType>(method: 'getSignatureStatuses' | 'getBlockHeight' | 'getSlot', params: unknown[], schema: T): Promise<z.infer<T>> {
    const id = ++this.id;
    const res = await this.transport({ url: this.opts.url, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), timeoutMs: this.opts.timeoutMs ?? 10_000 });
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ChainObserverError(method, 'response is not JSON');
    }
    const env = Envelope.safeParse(json);
    if (!env.success) throw new ChainObserverError(method, 'malformed JSON-RPC envelope');
    if (env.data.error) throw new ChainObserverError(method, `${env.data.error.code} ${env.data.error.message}`);
    const parsed = schema.safeParse(env.data.result);
    if (!parsed.success) throw new ChainObserverError(method, `unexpected result shape: ${parsed.error.issues[0]?.message ?? ''}`);
    return parsed.data;
  }

  async signatureStatus(signature: string): Promise<SignatureStatus | null> {
    const r = await this.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], StatusResult);
    const v = r.value[0];
    if (!v) return null;
    return { slot: v.slot, confirmationStatus: v.confirmationStatus ?? 'processed', err: v.err ?? null };
  }

  async blockHeight(): Promise<number> {
    return this.call('getBlockHeight', [{ commitment: 'confirmed' }], z.number().int().nonnegative());
  }

  /** This view's confirmed head, so a missing signature can be told apart from a view that is merely behind. */
  async headSlot(): Promise<number> {
    return this.call('getSlot', [{ commitment: 'confirmed' }], z.number().int().nonnegative());
  }
}

/** INV-23 proof: a transaction is conclusively dead only when its block height has passed and the node has no record of its signature. */
export async function proveDead(observer: ChainObserver, signature: string, lastValidBlockHeight: number | null): Promise<{ blockHeightExpired: boolean; signatureHistoryEmpty: boolean } | null> {
  const status = await observer.signatureStatus(signature);
  if (status !== null) return null;
  if (lastValidBlockHeight === null) return null;
  const height = await observer.blockHeight();
  if (height <= lastValidBlockHeight) return null;
  return { blockHeightExpired: true, signatureHistoryEmpty: true };
}
