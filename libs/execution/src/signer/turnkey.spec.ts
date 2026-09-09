import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { profile2SignerPolicy, sha256Hex, signerPolicyDigest, type Clock, type Instant, type MintAddress, type SigningRequest, type SolanaAddress, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { decodeTransaction, encodeTransaction, type DecodedMessage } from '../tx/codec.js';
import { ASSOCIATED_TOKEN_PROGRAM, BASE_PROGRAMS, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { TurnkeySigner, TurnkeySignerRefused, TurnkeySignerUnavailable, type TurnkeyResponse, type TurnkeyTransport } from './turnkey.js';
import { createTurnkeyStamper, decompressP256, verifyTurnkeyStamp, TurnkeyStampError } from './turnkey-stamp.js';

/**
 * The adapter against a fake Turnkey that behaves like the real one: it verifies our stamp before
 * doing anything, returns a whole signed transaction rather than a bare signature, and can return
 * every activity status the API documents. What it cannot do is tell us the provider account is
 * configured correctly — Probe A case (a) stays operator work.
 */

const addr = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const WALLET = addr(1) as SolanaAddress;
const SRC_ATA = addr(2) as SolanaAddress;
const MINT = addr(3) as MintAddress;
const DST_ATA = addr(4) as SolanaAddress;
const FOREIGN_ATA = addr(5) as SolanaAddress;
const T0 = '2026-09-09T00:00:00.000Z' as Instant;
const ORG = 'org-1';

const ms = Date.parse(T0);
const clock: Clock = { now: () => new Date(ms).toISOString() as Instant, nowMs: () => ms };

// A P-256 API key pair in the shape Turnkey issues: compressed public hex, 32-byte private scalar.
function apiKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const b64 = (s: string) => Buffer.from(s, 'base64url');
  const x = b64(jwk.x);
  const y = b64(jwk.y);
  const prefix = (y[y.length - 1]! & 1) === 1 ? '03' : '02';
  return { publicKeyHex: prefix + Buffer.from(x).toString('hex'), privateKeyHex: Buffer.from(b64(jwk.d)).toString('hex'), publicKey };
}

const KEYS = [WALLET, SRC_ATA, MINT, DST_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, '11111111111111111111111111111111'] as string[];
const transferChecked = () => Uint8Array.from([12, 64, 66, 15, 0, 0, 0, 0, 0, 6]);

function swapMessage(over: Partial<DecodedMessage> = {}, keys: string[] = KEYS): DecodedMessage {
  return {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 5 },
    staticAccountKeys: keys,
    recentBlockhash: addr(9),
    instructions: [
      { programIdIndex: 4, accountIndexes: [], data: Uint8Array.from([2, 64, 66, 15, 0]) },
      { programIdIndex: 6, accountIndexes: [0, 1, 3], data: new Uint8Array(40).fill(3) },
      { programIdIndex: 7, accountIndexes: [1, 2, 3, 0], data: transferChecked() },
    ],
    addressTableLookups: [],
    ...over,
  };
}

/** The message bytes the executor would hand the signer. */
const messageBytesOf = (m: DecodedMessage) => decodeTransaction(encodeTransaction([null], m)).messageBytes;

const policy = profile2SignerPolicy({
  version: 'signer-policy-v1' as VersionId,
  cluster: 'mainnet-beta',
  tradingWallet: WALLET,
  routePrograms: [JUPITER_V6_PROGRAM as SolanaAddress],
  basePrograms: BASE_PROGRAMS as SolanaAddress[],
  settlementMint: MINT,
  heldMints: [],
  ownedTokenAccounts: [SRC_ATA, DST_ATA],
  allowLookupTables: false,
});

interface FakeOptions {
  status?: string;
  /** Statuses to return before the terminal one, to exercise polling. */
  pendingRounds?: number;
  whoamiStatus?: number;
  signStatus?: number;
  /** Sign a different message than the one submitted. */
  tamper?: boolean;
}

function fakeTurnkey(opts: FakeOptions = {}) {
  // The wallet's Ed25519 key never leaves the fake, exactly as the real key never leaves Turnkey.
  const { privateKey } = generateKeyPairSync('ed25519');
  const calls: { path: string; stampOk: boolean }[] = [];
  let polls = 0;
  const sign = (unsignedHex: string): string => {
    const tx = decodeTransaction(Uint8Array.from(Buffer.from(unsignedHex, 'hex')));
    const message = opts.tamper ? swapMessage({ recentBlockhash: addr(11) }) : tx.message;
    const bytes = messageBytesOf(message);
    const sig = base58Encode(new Uint8Array(nodeSign(null, bytes, privateKey)));
    return Buffer.from(encodeTransaction([sig], message)).toString('hex');
  };
  const transport: TurnkeyTransport = async ({ path, body, stamp }): Promise<TurnkeyResponse> => {
    const check = verifyTurnkeyStamp(stamp, body);
    calls.push({ path, stampOk: check.ok });
    if (!check.ok) return { status: 401, body: JSON.stringify({ message: 'invalid stamp' }) };
    if (path.endsWith('/whoami')) {
      const status = opts.whoamiStatus ?? 200;
      return { status, body: JSON.stringify(status === 200 ? { organizationId: ORG, organizationName: 'solmate' } : { message: 'nope' }) };
    }
    if (path.endsWith('/sign_transaction')) {
      const status = opts.signStatus ?? 200;
      if (status !== 200) return { status, body: JSON.stringify({ message: 'refused' }) };
      const parsed = JSON.parse(body) as { parameters: { unsignedTransaction: string } };
      const terminal = opts.status ?? 'ACTIVITY_STATUS_COMPLETED';
      if ((opts.pendingRounds ?? 0) > 0) return { status: 200, body: JSON.stringify({ activity: { id: 'act-1', status: 'ACTIVITY_STATUS_PENDING' } }) };
      if (terminal !== 'ACTIVITY_STATUS_COMPLETED') return { status: 200, body: JSON.stringify({ activity: { id: 'act-1', status: terminal } }) };
      return { status: 200, body: JSON.stringify({ activity: { id: 'act-1', status: terminal, result: { activity: { result: { signTransactionResult: { signedTransaction: sign(parsed.parameters.unsignedTransaction) } } } } } }) };
    }
    if (path.endsWith('/get_activity')) {
      polls++;
      if (polls <= (opts.pendingRounds ?? 0) - 1) return { status: 200, body: JSON.stringify({ activity: { id: 'act-1', status: 'ACTIVITY_STATUS_PENDING' } }) };
      return { status: 200, body: JSON.stringify({ activity: { id: 'act-1', status: 'ACTIVITY_STATUS_COMPLETED', result: { signTransactionResult: { signedTransaction: sign(lastUnsigned) } } } }) };
    }
    return { status: 404, body: '{}' };
  };
  let lastUnsigned = '';
  const wrapped: TurnkeyTransport = async (req) => {
    if (req.path.endsWith('/sign_transaction')) lastUnsigned = (JSON.parse(req.body) as { parameters: { unsignedTransaction: string } }).parameters.unsignedTransaction;
    return transport(req);
  };
  return { transport: wrapped, calls };
}

function signerWith(fake: ReturnType<typeof fakeTurnkey>, over: Partial<Parameters<typeof makeOpts>[0]> = {}) {
  return new TurnkeySigner(makeOpts({ transport: fake.transport, ...over }));
}
function makeOpts(over: Record<string, unknown> = {}) {
  const keys = apiKeyPair();
  return {
    organizationId: ORG,
    signWith: WALLET,
    apiPublicKeyHex: keys.publicKeyHex,
    apiPrivateKeyHex: keys.privateKeyHex,
    transport: (async () => ({ status: 200, body: '{}' })) as TurnkeyTransport,
    clock,
    policy,
    cluster: 'mainnet-beta' as const,
    pollDelayMs: 0,
    sleep: async () => undefined,
    ...over,
  } as ConstructorParameters<typeof TurnkeySigner>[0];
}

const request = async (bytes: Uint8Array): Promise<SigningRequest> => ({
  intentId: '10000000-0000-4000-8000-000000000001' as Uuid,
  attemptId: '20000000-0000-4000-8000-000000000001' as Uuid,
  messageHash: await sha256Hex(bytes),
});

describe('Turnkey API-key stamping (§15.7)', () => {
  it('produces a stamp the provider can verify over the exact body', () => {
    const keys = apiKeyPair();
    const stamper = createTurnkeyStamper(keys.publicKeyHex, keys.privateKeyHex);
    const body = JSON.stringify({ organizationId: ORG });
    const check = verifyTurnkeyStamp(stamper.stamp(body), body);
    expect(check.ok).toBe(true);
    expect(check.publicKeyHex).toBe(keys.publicKeyHex.toLowerCase());
    // A stamp is bound to its body: the same header over different bytes does not verify.
    expect(verifyTurnkeyStamp(stamper.stamp(body), JSON.stringify({ organizationId: 'other' })).ok).toBe(false);
  });

  it('refuses a key pair whose halves do not belong together, at construction', () => {
    const a = apiKeyPair();
    const b = apiKeyPair();
    expect(() => createTurnkeyStamper(a.publicKeyHex, b.privateKeyHex)).toThrow(TurnkeyStampError);
  });

  it('decompresses a compressed point to the same coordinates the runtime derived', () => {
    const keys = apiKeyPair();
    const jwk = keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const { x, y } = decompressP256(keys.publicKeyHex);
    expect(x.toString(16).padStart(64, '0')).toBe(Buffer.from(jwk.x, 'base64url').toString('hex'));
    expect(y.toString(16).padStart(64, '0')).toBe(Buffer.from(jwk.y, 'base64url').toString('hex'));
    expect(() => decompressP256('02' + 'ff'.repeat(32))).toThrow(TurnkeyStampError);
  });
});

describe('Turnkey signer (D47, D51, D55, INV-25, INV-26)', () => {
  it('signs an approved transaction, stamping every call, and returns the signature over the bytes it submitted', async () => {
    const fake = fakeTurnkey();
    const signer = signerWith(fake);
    const bytes = messageBytesOf(swapMessage());
    const result = await signer.signTransactionMessage(bytes, await request(bytes));
    expect(result).toMatchObject({ signer: WALLET, deduplicated: false });
    expect(result.signature.length).toBeGreaterThan(64);
    expect(fake.calls.every((c) => c.stampOk)).toBe(true);
    expect(fake.calls.map((c) => c.path)).toEqual(['/public/v1/submit/sign_transaction']);
  });

  it('a retry with the same message hash returns the same signature without asking the provider again (§15.4)', async () => {
    const fake = fakeTurnkey();
    const signer = signerWith(fake);
    const bytes = messageBytesOf(swapMessage());
    const req = await request(bytes);
    const first = await signer.signTransactionMessage(bytes, req);
    const second = await signer.signTransactionMessage(bytes, req);
    expect(second.signature).toBe(first.signature);
    expect(second.deduplicated).toBe(true);
    expect(fake.calls.filter((c) => c.path.endsWith('/sign_transaction'))).toHaveLength(1);
  });

  it('refuses before the provider is ever asked when the signer policy denies the shape (INV-25)', async () => {
    const fake = fakeTurnkey();
    const signer = signerWith(fake);
    // Tokens credited to an account we do not own.
    const bytes = messageBytesOf(swapMessage({}, [...KEYS.slice(0, 3), FOREIGN_ATA, ...KEYS.slice(4)]));
    await expect(signer.signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(TurnkeySignerRefused);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a request whose hash does not cover the bytes', async () => {
    const fake = fakeTurnkey();
    const signer = signerWith(fake);
    const bytes = messageBytesOf(swapMessage());
    const wrong = { ...(await request(bytes)), messageHash: await sha256Hex(new Uint8Array([1, 2, 3])) };
    await expect(signer.signTransactionMessage(bytes, wrong)).rejects.toThrow(TurnkeySignerRefused);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a signature the provider produced over different bytes than were submitted', async () => {
    const fake = fakeTurnkey({ tamper: true });
    const signer = signerWith(fake);
    const bytes = messageBytesOf(swapMessage());
    await expect(signer.signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(/different message bytes/);
  });

  it('polls a pending activity a bounded number of times and then gives up rather than looping', async () => {
    const ok = fakeTurnkey({ pendingRounds: 2 });
    const signer = signerWith(ok);
    const bytes = messageBytesOf(swapMessage());
    const result = await signer.signTransactionMessage(bytes, await request(bytes));
    expect(result.deduplicated).toBe(false);
    expect(ok.calls.filter((c) => c.path.endsWith('/get_activity')).length).toBeGreaterThanOrEqual(1);

    const stuck = fakeTurnkey({ pendingRounds: 99 });
    const stubborn = new TurnkeySigner(makeOpts({ transport: stuck.transport, maxPolls: 2 }));
    await expect(stubborn.signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(TurnkeySignerUnavailable);
    expect(stuck.calls.filter((c) => c.path.endsWith('/get_activity'))).toHaveLength(2);
  });

  it('treats a rejected, failed or consensus-needed activity as a failure, never as a signature', async () => {
    const bytes = messageBytesOf(swapMessage());
    for (const status of ['ACTIVITY_STATUS_REJECTED', 'ACTIVITY_STATUS_FAILED']) {
      const fake = fakeTurnkey({ status });
      await expect(signerWith(fake).signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(TurnkeySignerUnavailable);
    }
    const consensus = fakeTurnkey({ status: 'ACTIVITY_STATUS_CONSENSUS_NEEDED' });
    await expect(signerWith(consensus).signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(/consensus/);
  });

  it('reports the pinned policy digest and, when the identity is revoked, UNAVAILABLE without a signing attempt (D51, D54, INV-26)', async () => {
    const healthy = await signerWith(fakeTurnkey()).health();
    expect(healthy).toMatchObject({ backend: 'TURNKEY', state: 'HEALTHY', detail: null });
    expect(healthy.policyDigest).toBe(await signerPolicyDigest(policy));

    for (const status of [401, 403]) {
      const revoked = await signerWith(fakeTurnkey({ whoamiStatus: status })).health();
      expect(revoked.state).toBe('UNAVAILABLE');
      expect(revoked.detail).toMatch(/revoked or disabled/);
      expect(revoked.policyDigest).toBe(await signerPolicyDigest(policy));
    }
    const degraded = await signerWith(fakeTurnkey({ whoamiStatus: 500 })).health();
    expect(degraded.state).toBe('DEGRADED');

    // A rejected credential on the signing path is an availability failure, not a policy refusal.
    const bytes = messageBytesOf(swapMessage());
    await expect(signerWith(fakeTurnkey({ signStatus: 403 })).signTransactionMessage(bytes, await request(bytes))).rejects.toThrow(TurnkeySignerUnavailable);
  });

  it('refuses to exist when its wallet or cluster is not the one the policy pins', () => {
    expect(() => new TurnkeySigner(makeOpts({ signWith: FOREIGN_ATA }))).toThrow(TurnkeySignerRefused);
    expect(() => new TurnkeySigner(makeOpts({ cluster: 'devnet' }))).toThrow(TurnkeySignerRefused);
  });
});
