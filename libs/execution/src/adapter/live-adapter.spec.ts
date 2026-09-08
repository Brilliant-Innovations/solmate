import { generateKeyPairSync } from 'node:crypto';
import { addMs, fixtures, generateSigningKeyPair, signPayload, toInstant, type Amount, type Bps, type Clock, type ExecutionRequest, type Instant, type JupiterQuoteClient, type MintAddress, type Order, type OrderAttempt, type QuoteRequest, type RiskAuthorizedIntent, type SigningKeyPair, type Slot, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import { base58Decode, base58Encode } from '@sol-agent-trader/solana-hard-state';
import { LiveExecutionAdapter, type LiveAdapterOptions } from './live-adapter.js';
import { baseIntent, parityScenarios, quoteOf, runParity, scriptedQuoteClient } from './parity.js';
import type { JupiterExecuteResult, JupiterOrder, JupiterOrderClient } from '../jupiter/order-client.js';
import { SoftwareDevSigner } from '../signer/software-dev.js';
import { decodeTransaction, encodeTransaction, fromBase64, toBase64, type DecodedMessage } from '../tx/codec.js';
import { ASSOCIATED_TOKEN_PROGRAM, BASE_PROGRAMS, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import type { AccountSnapshot, SimulationOutcome, SimulationReader } from '../simulate/client.js';

/**
 * The live adapter over stubbed transports (execution plan M3 / M5a parity addition): the same
 * parity table the paper adapter passes, plus the live-only boundaries — validation before
 * signing, journal before submit, dead proof before NOT_LANDED, tampered orders and simulations
 * refused with nothing signed.
 */

const AT = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = fixtures.MINTS.USDC as MintAddress;
const TOKEN = fixtures.MINTS.RISK as MintAddress;
const IN_ATA = base58Encode(new Uint8Array(32).fill(101));
const OUT_ATA = base58Encode(new Uint8Array(32).fill(102));
const ATTACKER = base58Encode(new Uint8Array(32).fill(66));
let seq = 0;
const newId = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;

/** Advances a fixed step per read so expiry-sensitive scenarios see time pass between steps. */
function steppingClock(start: Instant, stepMs: number): Clock {
  let t = start;
  return { now: () => { const out = t; t = addMs(t, stepMs); return out; } } as Clock;
}

function tokenAccountData(mint: string, owner: string, amount: bigint, over: { delegate?: string; frozen?: boolean } = {}): string {
  const data = new Uint8Array(165);
  data.set(base58Decode(mint), 0);
  data.set(base58Decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  if (over.delegate) {
    new DataView(data.buffer).setUint32(72, 1, true);
    data.set(base58Decode(over.delegate), 76);
  }
  data[108] = over.frozen ? 2 : 1;
  return Buffer.from(data).toString('base64');
}
const tokenSnap = (address: string, mint: string, owner: string, amount: bigint, over = {}): AccountSnapshot => ({ address, lamports: 2_039_280, owner: TOKEN_PROGRAM, dataBase64: tokenAccountData(mint, owner, amount, over) });

function swapMessage(wallet: string): DecodedMessage {
  return {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 5 },
    staticAccountKeys: [wallet, IN_ATA, OUT_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM],
    recentBlockhash: base58Encode(new Uint8Array(32).fill(9)),
    instructions: [
      { programIdIndex: 3, accountIndexes: [], data: new Uint8Array([2, 64, 66, 15, 0]) },
      { programIdIndex: 4, accountIndexes: [0, 2, 0, 7, 6], data: new Uint8Array([1]) },
      { programIdIndex: 5, accountIndexes: [0, 1, 2, 6, 8], data: new Uint8Array(40).fill(3) },
    ],
    addressTableLookups: [{ accountKey: base58Encode(new Uint8Array(32).fill(8)), writableIndexes: [1], readonlyIndexes: [] }],
  };
}

interface HarnessKnobs {
  /** Mutates the order the stub hands back (tamper tests). */
  tamperOrder?: (o: JupiterOrder) => JupiterOrder;
  /** Overrides the simulated post-state. */
  tamperPost?: (post: (AccountSnapshot | null)[]) => (AccountSnapshot | null)[];
  executeOutcome?: (order: JupiterOrder) => JupiterExecuteResult;
  proveDead?: LiveAdapterOptions['proveDead'];
  awaitFinalized?: LiveAdapterOptions['awaitFinalized'];
  beforeSubmit?: LiveAdapterOptions['beforeSubmit'];
  clock?: Clock;
}

interface Harness {
  adapter: LiveExecutionAdapter;
  signer: SoftwareDevSigner;
  journaled: { order: Order; attempt: OrderAttempt }[];
  executed: { signedTransactionBase64: string; requestId: string }[];
  orders: JupiterOrder[];
}

/** Order stub: quote call 1 = the decision reference, call 2 = the executable order (mirrors the paper adapter's two quote calls). */
function harness(quotes: JupiterQuoteClient, signer: SoftwareDevSigner, knobs: HarnessKnobs = {}): Harness {
  const clock = knobs.clock ?? steppingClock(AT, 100);
  const journaled: Harness['journaled'] = [];
  const executed: Harness['executed'] = [];
  const orders: JupiterOrder[] = [];
  const wallet = signer.publicKey;
  let ordinal = 0;
  const orderClient: JupiterOrderClient = {
    order: async (request: QuoteRequest) => {
      const { quote } = await quotes.quote(request);
      const tx = encodeTransaction([null], swapMessage(wallet));
      let o: JupiterOrder = { requestId: `req-${++ordinal}`, quote: { ...quote, providerRequestId: `req-${ordinal}` }, transactionBase64: toBase64(tx), taker: wallet, router: 'stub', lastValidBlockHeight: 500, expiresAt: null };
      if (knobs.tamperOrder) o = knobs.tamperOrder(o);
      orders.push(o);
      return o;
    },
    execute: async (signedTransactionBase64, requestId) => {
      executed.push({ signedTransactionBase64, requestId });
      const o = orders[orders.length - 1]!;
      if (knobs.executeOutcome) return knobs.executeOutcome(o);
      // The chain moves 20 bps against the taker between quote and landing; a tighter minimum fails on-chain.
      const adverse = (BigInt(o.quote.expectedOutputAmount) * 9_980n) / 10_000n;
      if (adverse < BigInt(o.quote.minOutputAmount)) return { status: 'Failed', signature: decodeTransaction(fromBase64(signedTransactionBase64)).signatures[0], slot: null, code: 6001, error: 'Slippage tolerance exceeded', inputAmountResult: null, outputAmountResult: null };
      return { status: 'Success', signature: decodeTransaction(fromBase64(signedTransactionBase64)).signatures[0], slot: 1000, code: 0, error: null, inputAmountResult: o.quote.inputAmount, outputAmountResult: adverse.toString() };
    },
  };
  const simulation: SimulationReader = {
    label: 'stub-sim',
    accounts: async (addresses) => ({ slot: 999, accounts: addresses.map((a) => (a === wallet ? { address: a, lamports: 1_000_000_000, owner: SYSTEM_PROGRAM, dataBase64: '' } : a === IN_ATA ? tokenSnap(a, USDC, wallet, 1_000_000_000n) : a === OUT_ATA ? tokenSnap(a, TOKEN, wallet, 0n) : null)) }),
    simulate: async (_tx, addresses): Promise<SimulationOutcome> => {
      const o = orders[orders.length - 1]!;
      let post = addresses.map((a) => (a === wallet ? { address: a, lamports: 1_000_000_000 - 5_000, owner: SYSTEM_PROGRAM, dataBase64: '' } : a === IN_ATA ? tokenSnap(a, USDC, wallet, 1_000_000_000n - BigInt(o.quote.inputAmount)) : a === OUT_ATA ? tokenSnap(a, TOKEN, wallet, BigInt(o.quote.expectedOutputAmount)) : null));
      if (knobs.tamperPost) post = knobs.tamperPost(post);
      return { slot: 1000, err: null, logs: ['Program log: ok'], unitsConsumed: 100_000, accounts: post };
    },
  };
  const adapter = new LiveExecutionAdapter({
    orders: orderClient,
    quotes,
    signer,
    simulation,
    clock,
    cluster: 'devnet',
    newId,
    structure: { allowedPrograms: [...BASE_PROGRAMS, JUPITER_V6_PROGRAM], allowLookupTables: true, allowedTransferRecipients: [] },
    maxSolDebitLamports: 50_000n,
    decisionQuote: async (intent) => (await quotes.quote({ inputMint: intent.inputMint, outputMint: intent.outputMint, inputAmount: intent.maxInputAmount, maxSlippageBps: intent.constraints.maxSlippageBps, taker: wallet, cluster: 'devnet', requestedAt: clock.now() })).quote,
    journal: async (r) => { journaled.push(structuredClone(r)); },
    beforeSubmit: knobs.beforeSubmit ?? (async () => ({ allowed: true })),
    awaitFinalized: knobs.awaitFinalized ?? (async () => ({ slot: 1032 as Slot })),
    proveDead: knobs.proveDead ?? (async () => ({ blockHeightExpired: true, signatureHistoryEmpty: true })),
    currentBlockHeight: async () => 400,
  });
  return { adapter, signer, journaled, executed, orders };
}

function devSigner(clock: Clock): SoftwareDevSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new SoftwareDevSigner({ privateKeyPkcs8Hex: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('hex'), cluster: 'devnet', liveCapabilityEnabled: true, clock });
}

async function authorized(intent: TradeIntent, key: SigningKeyPair): Promise<ExecutionRequest['authorization']> {
  const payload: RiskAuthorizedIntent = {
    ...fixtures.riskAuthorizedIntent(),
    intentId: intent.id,
    actionCycleId: intent.actionCycleId,
    accountId: intent.accountId,
    assetId: intent.assetId,
    strategyVersionId: intent.strategyVersionId,
    sleeveId: intent.sleeveId,
    cluster: 'devnet',
    capitalAuthority: 'LIVE_AUTO',
    action: intent.action,
    side: intent.side,
    exposureEffect: intent.exposureEffect,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    maxInputAmount: intent.maxInputAmount,
    maxSlippageBps: intent.constraints.maxSlippageBps,
    maxPriceImpactBps: intent.constraints.maxPriceImpactBps,
    chaseToleranceBps: intent.constraints.chaseToleranceBps,
    maxQuoteAgeMs: intent.constraints.maxQuoteAgeMs,
    targetLotIds: intent.targetLotIds,
    approvalRequired: intent.approvalRequired,
    issuedAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    nonce: `nonce-${intent.id}` as RiskAuthorizedIntent['nonce'],
  };
  return signPayload(payload, key, intent.createdAt);
}

describe('live execution adapter (§15.4, D12, D21, P7)', () => {
  let key: SigningKeyPair;
  beforeAll(async () => {
    key = await generateSigningKeyPair();
  });
  const liveRequest = async (intent: TradeIntent): Promise<ExecutionRequest> => ({ intent, capitalAuthority: 'LIVE_AUTO', authorization: await authorized(intent, key), approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: AT });

  it('passes the same parity table as the paper adapter', async () => {
    const requests = new Map<Uuid, ExecutionRequest>();
    const intents: TradeIntent[] = [];
    // runParity's request builder is synchronous; pre-sign one envelope per scenario intent.
    const scenarios = parityScenarios(USDC, TOKEN, AT, (ms) => addMs(AT, ms), 'live');
    for (const s of scenarios) {
      const intent = s.intent(baseIntent(newId(), `live-parity:${seq}`, USDC, TOKEN, AT, addMs(AT, 60_000)));
      intents.push(intent);
      requests.set(intent.id, await liveRequest(intent));
    }
    let i = 0;
    const report = await runParity(
      (quotes) => harness(quotes, devSigner(steppingClock(AT, 300)), { clock: steppingClock(AT, 300) }).adapter,
      scenarios,
      { intent: () => intents[i++]!, request: (intent) => requests.get(intent.id)! },
    );
    expect(report.filter((r) => r.failures.length)).toEqual([]);
    expect(report).toHaveLength(11);
  });

  it('validates, simulates and re-checks before signing, journals SIGNED_NOT_SUBMITTED before /execute, and finalizes from its own chain read', async () => {
    const clock = steppingClock(AT, 100);
    const signer = devSigner(clock);
    const h = harness(scriptedQuoteClient([quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT), quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT)]), signer, { clock });
    const intent = baseIntent(newId(), 'live:detailed', USDC, TOKEN, AT, addMs(AT, 60_000));
    const d = await h.adapter.executeDetailed(await liveRequest(intent));
    expect(d.result.rejectionReasons).toEqual([]);
    expect(d.attempt.state).toBe('FINALIZED');
    expect(h.journaled).toHaveLength(1);
    expect(h.journaled[0]!.attempt).toMatchObject({ state: 'SIGNED_NOT_SUBMITTED', submittedAt: null, jupiterRequestId: 'req-1', lastValidBlockHeight: 500 });
    expect(h.journaled[0]!.order.authorizationHash).toBe((await liveRequest(intent)).authorization!.payloadHash);
    // the submitted bytes carry the wallet's signature over the exact message the router produced
    expect(h.executed).toHaveLength(1);
    const submitted = decodeTransaction(fromBase64(h.executed[0]!.signedTransactionBase64));
    expect(submitted.signatures[0]).toBe(d.attempt.expectedTxSignature);
    expect(toBase64(submitted.messageBytes)).toBe(toBase64(decodeTransaction(fromBase64(h.orders[0]!.transactionBase64)).messageBytes));
    expect(h.executed[0]!.requestId).toBe('req-1');
    expect(d.result.simulation).toMatchObject({ passed: true, rpcEndpointLabel: 'stub-sim', slot: 1000 });
    expect(d.attempt).toMatchObject({ confirmedSlot: 1000, finalizedSlot: 1032, submissions: [{ path: 'JUPITER_ORDER', ok: true }] });
    expect(d.fill).toMatchObject({ commitment: 'finalized', slot: 1032, inputAmount: '100000000', outputAmount: '998000', executionShortfallBps: 20, txSignature: d.attempt.expectedTxSignature });
  });

  it('a provider "Failed" is not NOT_LANDED until proven dead; without proof the attempt stays SUBMITTED for reconciliation', async () => {
    const q = () => quoteOf(100_000_000n, 1_000_000n, 5, 20, USDC, TOKEN, AT);
    const intent = { ...baseIntent(newId(), 'live:unproven', USDC, TOKEN, AT, addMs(AT, 60_000)), constraints: { ...baseIntent(newId(), 'x', USDC, TOKEN, AT, AT).constraints, maxSlippageBps: 5 as Bps } };
    const unproven = harness(scriptedQuoteClient([q(), q()]), devSigner(steppingClock(AT, 100)), { proveDead: async () => null });
    const d = await unproven.adapter.executeDetailed(await liveRequest(intent));
    expect(d.attempt.state).toBe('SUBMITTED');
    expect(d.result.rejectionReasons).toEqual(['SLIPPAGE_EXCEEDED']);
    expect(d.result.txSignature).not.toBeNull();
    const proven = harness(scriptedQuoteClient([q(), q()]), devSigner(steppingClock(AT, 100)));
    const p = await proven.adapter.executeDetailed(await liveRequest({ ...intent, id: newId(), idempotencyKey: 'live:proven' as TradeIntent['idempotencyKey'] }));
    expect(p.attempt).toMatchObject({ state: 'NOT_LANDED', notLandedReason: 'Slippage tolerance exceeded' });
  });

  it('refuses a tampered order, a foreign program, a simulation that drains the wallet or an executor gate closure, each with nothing signed', async () => {
    const q = () => quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
    const cases: [HarnessKnobs, string][] = [
      [{ tamperOrder: (o) => ({ ...o, quote: { ...o.quote, inputAmount: '100000001' as Amount } }) }, 'AMOUNT_ABOVE_AUTHORIZED'],
      [{ tamperOrder: (o) => ({ ...o, quote: { ...o.quote, outputMint: USDC } }) }, 'OUTPUT_MINT_MISMATCH'],
      [{ tamperOrder: (o) => ({ ...o, taker: ATTACKER }) }, 'TAKER_MISMATCH'],
      [{ tamperOrder: (o) => ({ ...o, quote: { ...o.quote, minOutputAmount: '900000' as Amount } }) }, 'MIN_OUT_BELOW_SLIPPAGE_FLOOR'],
      [{ tamperOrder: (o) => { const m = swapMessage(devWallet); m.staticAccountKeys[5] = ATTACKER; return { ...o, transactionBase64: toBase64(encodeTransaction([null], m)) }; } }, 'PROGRAM_NOT_ALLOWED'],
      [{ tamperPost: (post) => post.map((a) => (a && a.address === IN_ATA ? tokenSnap(IN_ATA, USDC, devWallet, 0n) : a)) }, 'INPUT_DECREASE_ABOVE_AUTHORIZED'],
      [{ tamperPost: (post) => post.map((a) => (a && a.address === OUT_ATA ? tokenSnap(OUT_ATA, TOKEN, ATTACKER, 1_000_000n) : a)) }, 'ACCOUNT_OWNER_CHANGED'],
      [{ tamperPost: (post) => post.map((a) => (a && a.owner === SYSTEM_PROGRAM ? { ...a, lamports: 900_000_000 } : a)) }, 'SOL_DEBIT_ABOVE_MODELED'],
    ];
    const clock = steppingClock(AT, 100);
    const signer = devSigner(clock);
    const devWallet = signer.publicKey;
    for (const [knobs, reason] of cases) {
      const h = harness(scriptedQuoteClient([q(), q()]), signer, { ...knobs, clock: steppingClock(AT, 100) });
      const d = await h.adapter.executeDetailed(await liveRequest(baseIntent(newId(), `live:tamper:${reason}`, USDC, TOKEN, AT, addMs(AT, 60_000))));
      expect(d.result.rejectionReasons, reason).toContain(reason);
      expect(d.attempt.state, reason).toBe('PREPARED');
      expect(d.result.signedTxHash, reason).toBeNull();
      expect(h.journaled, reason).toEqual([]);
      expect(h.executed, reason).toEqual([]);
    }
  });

  it('the executor gate is re-read after the durable signed record and immediately before /execute: a closed gate leaves SIGNED_NOT_SUBMITTED, nothing submitted', async () => {
    const q = () => quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
    const h = harness(scriptedQuoteClient([q(), q()]), devSigner(steppingClock(AT, 100)), { beforeSubmit: async () => ({ allowed: false, reason: 'MODE_GATE_CLOSED' }) });
    const d = await h.adapter.executeDetailed(await liveRequest(baseIntent(newId(), 'live:gate', USDC, TOKEN, AT, addMs(AT, 60_000))));
    expect(d.result.rejectionReasons).toEqual(['MODE_GATE_CLOSED']);
    expect(d.attempt.state).toBe('SIGNED_NOT_SUBMITTED');
    expect(d.result.signedTxHash).not.toBeNull();
    expect(h.journaled).toHaveLength(1);
    expect(h.executed).toEqual([]);
  });

  it('a request without a verified authorization for this intent never reaches the router', async () => {
    const q = () => quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
    const h = harness(scriptedQuoteClient([q(), q()]), devSigner(steppingClock(AT, 100)));
    const intent = baseIntent(newId(), 'live:noauth', USDC, TOKEN, AT, addMs(AT, 60_000));
    const other = await liveRequest(baseIntent(newId(), 'live:other', USDC, TOKEN, AT, addMs(AT, 60_000)));
    const d = await h.adapter.executeDetailed({ ...other, intent });
    expect(d.result.rejectionReasons).toEqual(['AUTHORIZATION_MISSING']);
    expect(h.orders).toEqual([]);
    const approval = await h.adapter.executeDetailed({ ...(await liveRequest(intent)), capitalAuthority: 'LIVE_APPROVAL' });
    expect(approval.result.rejectionReasons).toEqual(['APPROVAL_MISSING']);
    expect(h.orders).toEqual([]);
  });
});

