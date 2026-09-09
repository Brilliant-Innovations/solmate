import { sha256Hex, signerPolicyDigest, type Clock, type SignatureResult, type SignerHealth, type SignerTransactionPolicy, type SigningRequest, type Sha256Hex, type SolanaAddress, type SolanaCluster, type TradingWalletSigner, type TxSignature } from '@sol-agent-trader/contracts';
import { decodeTransaction } from '../tx/codec.js';
import { evaluateSignerPolicy } from './policy.js';
import { createTurnkeyStamper, type TurnkeyStamper } from './turnkey-stamp.js';

/**
 * Turnkey `TradingWalletSigner` (blueprint D47, D51, D55, §15.7, §15.7A; the v1 reference signer).
 *
 * The executor owns authorization to request a signature, never possession of the key. This adapter
 * sends the exact bytes that already passed authorization, structural validation, simulation and
 * the chase/expiry checks, and returns only the signature and signer metadata. It constructs
 * nothing and interprets no strategy.
 *
 * Three refusals live here, in front of the provider rather than behind it:
 *
 *   - the message must hash to what the request claims (§15.4: a retry presents the same hash);
 *   - the transaction must pass the local mirror of the pinned signer policy, so a shape the
 *     provider would deny never leaves this host (INV-25). The provider is still the enforcing
 *     layer — that is what D55 requires — but a violation should be a bug we catch, not an entry in
 *     someone's audit log;
 *   - what comes back must be the transaction we sent. The provider returns a whole signed
 *     transaction, so the adapter re-decodes it and refuses unless the message bytes are identical.
 *
 * `health()` is the D51 signal and INV-26's observable: a revoked or disabled executor identity
 * makes `whoami` fail, and this reports UNAVAILABLE without needing the database or a signature
 * attempt.
 */

export class TurnkeySignerRefused extends Error {
  constructor(
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'TurnkeySignerRefused';
  }
}

export class TurnkeySignerUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'TurnkeySignerUnavailable';
  }
}

export interface TurnkeyResponse {
  status: number;
  body: string;
}

/** The one egress the adapter makes. Injected so the executor's allowlist and the tests both own it. */
export type TurnkeyTransport = (req: { path: string; body: string; stamp: string }) => Promise<TurnkeyResponse>;

export interface TurnkeySignerOptions {
  organizationId: string;
  /** The wallet account address to sign with; must be the policy's trading wallet. */
  signWith: SolanaAddress;
  apiPublicKeyHex: string;
  apiPrivateKeyHex: string;
  transport: TurnkeyTransport;
  clock: Clock;
  policy: SignerTransactionPolicy;
  cluster: SolanaCluster;
  /** A signature that cannot be obtained promptly is a failure, never an unbounded retry (§15.4). */
  maxPolls?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SIGN_PATH = '/public/v1/submit/sign_transaction';
const ACTIVITY_PATH = '/public/v1/query/get_activity';
const WHOAMI_PATH = '/public/v1/query/whoami';

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

interface ActivityEnvelope {
  activity?: {
    id?: string;
    status?: string;
    result?: { activity?: { result?: { signTransactionResult?: { signedTransaction?: string } } }; signTransactionResult?: { signedTransaction?: string } };
  };
}

/** Turnkey nests the result one level deeper on the submit response than on the query response. */
function signedTransactionOf(env: ActivityEnvelope): string | null {
  const r = env.activity?.result;
  return r?.activity?.result?.signTransactionResult?.signedTransaction ?? r?.signTransactionResult?.signedTransaction ?? null;
}

export class TurnkeySigner implements TradingWalletSigner {
  readonly backend = 'TURNKEY' as const;
  readonly publicKey: SolanaAddress;
  private readonly stamper: TurnkeyStamper;
  private readonly seen = new Map<string, TxSignature>();
  private policyDigestCache: Sha256Hex | null = null;

  constructor(private readonly opts: TurnkeySignerOptions) {
    if (opts.signWith !== opts.policy.tradingWallet) {
      throw new TurnkeySignerRefused(`signer wallet ${opts.signWith} is not the policy's trading wallet ${opts.policy.tradingWallet}`);
    }
    if (opts.cluster !== opts.policy.cluster) {
      throw new TurnkeySignerRefused(`executor cluster ${opts.cluster} is not the policy's cluster ${opts.policy.cluster}`);
    }
    this.stamper = createTurnkeyStamper(opts.apiPublicKeyHex, opts.apiPrivateKeyHex);
    this.publicKey = opts.signWith;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<{ status: number; parsed: unknown; body: string }> {
    const body = JSON.stringify(payload);
    const res = await this.opts.transport({ path, body, stamp: this.stamper.stamp(body) });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(res.body) as unknown;
    } catch {
      parsed = null;
    }
    return { status: res.status, parsed, body: res.body };
  }

  async policyDigest(): Promise<Sha256Hex> {
    this.policyDigestCache ??= await signerPolicyDigest(this.opts.policy);
    return this.policyDigestCache;
  }

  async signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult> {
    const hash = await sha256Hex(messageBytes);
    if (hash !== request.messageHash) throw new TurnkeySignerRefused(`message hash ${hash} does not match the request ${request.messageHash}`);

    // A Solana transaction is its signature vector followed by the message. The unsigned form the
    // provider expects is that vector zero-filled, which is reconstructable from the message alone:
    // parse once with a single empty slot to read the header, then size the vector properly.
    const probe = decodeTransaction(prefixEmptySignatures(messageBytes, 1));
    const required = probe.message.header.numRequiredSignatures;
    const unsignedBytes = required === 1 ? prefixEmptySignatures(messageBytes, 1) : prefixEmptySignatures(messageBytes, required);
    const tx = required === 1 ? probe : decodeTransaction(unsignedBytes);

    const verdict = evaluateSignerPolicy(tx, this.opts.policy, { cluster: this.opts.cluster });
    if (!verdict.ok) throw new TurnkeySignerRefused(`the signer policy denies this transaction: ${verdict.reasons.join(', ')}`, verdict.reasons);

    const cached = this.seen.get(request.messageHash);
    if (cached) return { signature: cached, signer: this.publicKey, signedAt: this.opts.clock.now(), deduplicated: true };

    const submit = await this.post(SIGN_PATH, {
      type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
      timestampMs: String(this.opts.clock.nowMs()),
      organizationId: this.opts.organizationId,
      parameters: { signWith: this.opts.signWith, unsignedTransaction: bytesToHex(unsignedBytes), type: 'TRANSACTION_TYPE_SOLANA' },
    });
    if (submit.status === 401 || submit.status === 403) throw new TurnkeySignerUnavailable('the executor signing identity was rejected by the provider', submit.status);
    if (submit.status !== 200) throw new TurnkeySignerUnavailable(`sign_transaction returned ${submit.status}`, submit.status);

    let env = submit.parsed as ActivityEnvelope;
    let signedHex = signedTransactionOf(env);
    const activityId = env.activity?.id ?? null;
    let status = env.activity?.status ?? 'ACTIVITY_STATUS_PENDING';
    const maxPolls = this.opts.maxPolls ?? 5;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let poll = 0; signedHex === null && poll < maxPolls; poll++) {
      if (status === 'ACTIVITY_STATUS_FAILED' || status === 'ACTIVITY_STATUS_REJECTED') break;
      // CONSENSUS_NEEDED means a human must approve. The autonomous path never waits on one: that
      // is a policy configuration error, and the caller must see it as a failure now (D55).
      if (status === 'ACTIVITY_STATUS_CONSENSUS_NEEDED') throw new TurnkeySignerRefused('the provider requires consensus for this activity; the autonomous principal must not need approval to sign an already-authorized transaction');
      if (!activityId) break;
      await sleep(this.opts.pollDelayMs ?? 250);
      const q = await this.post(ACTIVITY_PATH, { organizationId: this.opts.organizationId, activityId });
      if (q.status !== 200) throw new TurnkeySignerUnavailable(`get_activity returned ${q.status}`, q.status);
      env = q.parsed as ActivityEnvelope;
      status = env.activity?.status ?? status;
      signedHex = signedTransactionOf(env);
    }

    if (signedHex === null) throw new TurnkeySignerUnavailable(`no signature after ${maxPolls} poll(s); last activity status ${status}`);

    const signedTx = decodeTransaction(hexToBytes(signedHex));
    if (bytesToHex(signedTx.messageBytes) !== bytesToHex(messageBytes)) {
      throw new TurnkeySignerRefused('the provider returned a signature over different message bytes than were submitted');
    }
    const signature = signedTx.signatures[0];
    if (!signature) throw new TurnkeySignerRefused('the provider returned a transaction with no signature in the wallet slot');

    this.seen.set(request.messageHash, signature as TxSignature);
    return { signature: signature as TxSignature, signer: this.publicKey, signedAt: this.opts.clock.now(), deduplicated: false };
  }

  async health(): Promise<SignerHealth> {
    const policyDigest = await this.policyDigest();
    const startedMs = this.opts.clock.nowMs();
    let res: { status: number; parsed: unknown; body: string };
    try {
      res = await this.post(WHOAMI_PATH, { organizationId: this.opts.organizationId });
    } catch (err) {
      return { backend: 'TURNKEY', state: 'UNAVAILABLE', checkedAt: this.opts.clock.now(), latencyMs: null, policyDigest, detail: `provider unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 512) };
    }
    const latencyMs = this.opts.clock.nowMs() - startedMs;
    if (res.status === 401 || res.status === 403) {
      // D54: revocation of the executor identity is the first containment action, and it must be
      // visible here without the executor's database or a signing attempt (INV-26).
      return { backend: 'TURNKEY', state: 'UNAVAILABLE', checkedAt: this.opts.clock.now(), latencyMs, policyDigest, detail: `signing identity rejected (HTTP ${res.status}); it may have been revoked or disabled` };
    }
    if (res.status !== 200) {
      return { backend: 'TURNKEY', state: 'DEGRADED', checkedAt: this.opts.clock.now(), latencyMs, policyDigest, detail: `whoami returned HTTP ${res.status}` };
    }
    const org = (res.parsed as { organizationId?: unknown } | null)?.organizationId;
    if (org !== this.opts.organizationId) {
      return { backend: 'TURNKEY', state: 'DEGRADED', checkedAt: this.opts.clock.now(), latencyMs, policyDigest, detail: `whoami reported organization ${String(org)}, expected ${this.opts.organizationId}` };
    }
    return { backend: 'TURNKEY', state: 'HEALTHY', checkedAt: this.opts.clock.now(), latencyMs, policyDigest, detail: null };
  }
}

/** `[compact-u16 count][count × 64 zero bytes][message]` — the unsigned wire form of a transaction. */
function prefixEmptySignatures(messageBytes: Uint8Array, count: number): Uint8Array {
  if (count < 1 || count > 127) throw new TurnkeySignerRefused(`unsupported signature count ${count}`);
  const out = new Uint8Array(1 + count * 64 + messageBytes.length);
  out[0] = count;
  out.set(messageBytes, 1 + count * 64);
  return out;
}
