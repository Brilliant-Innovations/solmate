import { z } from 'zod';
import { fetchRpcTransport, type RpcTransport } from '@sol-agent-trader/solana-hard-state';

/**
 * The executor's independent simulation RPC (blueprint §15.4 step 5, D45). Two methods only:
 * `simulateTransaction` with post-state for named accounts, and `getMultipleAccounts` for the
 * pre-state of the same accounts, both against the allowlisted endpoint from the deployment
 * environment (`SOLANA_RPC_SIMULATION`), never the router's or the worker's endpoint. It cannot
 * send a transaction: the method set is closed.
 */

export interface SimulationRpcOptions {
  url: string;
  allowedOrigins: readonly string[];
  label: string;
  transport?: RpcTransport;
  timeoutMs?: number;
}

const AccountValue = z.object({ data: z.tuple([z.string(), z.literal('base64')]), owner: z.string(), lamports: z.number(), executable: z.boolean() }).nullable();

const SimulateResult = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.object({
    err: z.unknown().nullable(),
    logs: z.array(z.string()).nullable(),
    unitsConsumed: z.number().int().nonnegative().optional(),
    accounts: z.array(AccountValue).nullable(),
  }),
});
const MultipleAccounts = z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.array(AccountValue) });
const Envelope = z.object({ result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });

export interface AccountSnapshot {
  address: string;
  lamports: number;
  owner: string;
  dataBase64: string;
}

export interface SimulationOutcome {
  slot: number;
  err: unknown | null;
  logs: string[];
  unitsConsumed: number | null;
  accounts: (AccountSnapshot | null)[];
}

export class SimulationRpcError extends Error {
  constructor(readonly method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'SimulationRpcError';
  }
}

/** What the live adapter needs from the independent simulation endpoint; the RPC client implements it, harnesses stub it. */
export interface SimulationReader {
  readonly label: string;
  simulate(transactionBase64: string, accounts: readonly string[]): Promise<SimulationOutcome>;
  accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: (AccountSnapshot | null)[] }>;
}

export class SimulationRpcClient implements SimulationReader {
  private readonly transport: RpcTransport;
  private id = 0;

  constructor(private readonly opts: SimulationRpcOptions) {
    const origin = new URL(opts.url).origin;
    if (!opts.allowedOrigins.includes(origin)) throw new RangeError(`simulation rpc endpoint ${origin} is not on the allowlist`);
    this.transport = opts.transport ?? fetchRpcTransport;
  }

  get label(): string {
    return this.opts.label;
  }

  private async call<T extends z.ZodType>(method: 'simulateTransaction' | 'getMultipleAccounts', params: unknown[], schema: T): Promise<z.infer<T>> {
    const id = ++this.id;
    const res = await this.transport({ url: this.opts.url, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), timeoutMs: this.opts.timeoutMs ?? 10_000 });
    if (res.status !== 200) throw new SimulationRpcError(method, `HTTP ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new SimulationRpcError(method, 'response is not JSON');
    }
    const env = Envelope.safeParse(json);
    if (!env.success) throw new SimulationRpcError(method, 'malformed JSON-RPC envelope');
    if (env.data.error) throw new SimulationRpcError(method, `${env.data.error.code} ${env.data.error.message}`);
    const parsed = schema.safeParse(env.data.result);
    if (!parsed.success) throw new SimulationRpcError(method, `unexpected result shape: ${parsed.error.issues[0]?.message ?? ''}`);
    return parsed.data;
  }

  /** Simulates the exact bytes with signature verification off (the wallet has not signed yet) and returns post-state for `accounts`. */
  async simulate(transactionBase64: string, accounts: readonly string[]): Promise<SimulationOutcome> {
    const r = await this.call('simulateTransaction', [transactionBase64, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64', accounts: { encoding: 'base64', addresses: [...accounts] } }], SimulateResult);
    return {
      slot: r.context.slot,
      err: r.value.err ?? null,
      logs: r.value.logs ?? [],
      unitsConsumed: r.value.unitsConsumed ?? null,
      accounts: (r.value.accounts ?? []).map((a, i) => (a ? { address: accounts[i]!, lamports: a.lamports, owner: a.owner, dataBase64: a.data[0] } : null)),
    };
  }

  async accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: (AccountSnapshot | null)[] }> {
    const r = await this.call('getMultipleAccounts', [[...addresses], { encoding: 'base64', commitment: 'confirmed' }], MultipleAccounts);
    return { slot: r.context.slot, accounts: r.value.map((a, i) => (a ? { address: addresses[i]!, lamports: a.lamports, owner: a.owner, dataBase64: a.data[0] } : null)) };
  }
}
