import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMs, canonicalHash, fixtures, generateSigningKeyPair, sha256Hex, signPayload, toInstant, type Amount, type Bps, type Clock, type ExecutionRequest, type ExecutorGuardrails, type Instant, type KeyId, type MintAddress, type Nonce, type Quote, type RiskAuthorizedIntent, type SigningKeyPair, type TradeIntent, type TradingWalletSigner, type Uuid } from '@sol-agent-trader/contracts';
import { BASE_PROGRAMS, JUPITER_V6_PROGRAM, SoftwareDevSigner, baseIntent, encodeMessage, quoteOf, type DecodedMessage } from '@sol-agent-trader/execution';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { CrashSignal, ExecutorPipeline, type Boundary, type PipelineDeps, type SubmitOutcome } from '../pipeline/pipeline.js';
import { ExecutorJournal } from '../journal/journal.js';
import type { ModeFacts } from '../authority/mode-gate.js';
import { FakeChain, OTHER_ATA, OTHER_MINT, flakySigner, policySigner, swapMessage, tokenAccountData, type ExecuteBehaviour, type FakeChainOptions } from './fake-chain.js';

/**
 * Execution harness (blueprint §24.3; execution plan M3 exit gate). Every case runs the real
 * pipeline: authority verification, idempotency, caps, the live adapter, the durable journal and
 * restart recovery, over the fake Jupiter/Solana. Cases that need modules M6/M8b own (Trigger
 * lifecycle, explicit stop slippage, direct-pool emergency adapter, provider-protected lots) are
 * listed in the changelog as pending, not silently skipped here.
 */

const AT = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = fixtures.MINTS.USDC as MintAddress;
const TOKEN = fixtures.MINTS.RISK as MintAddress;
const ATTACKER = base58Encode(new Uint8Array(32).fill(66));
const ACTIVE: ModeFacts = { activity: 'ACTIVE', authority: 'LIVE_AUTO', paused: false, localPause: false, liveCapabilityEnabled: true };
let seq = 0;
const newId = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const nonceOf = (n: number) => n.toString(16).padStart(32, '0') as Nonce;

function steppingClock(start: Instant, stepMs: number): Clock {
  let t = start;
  return { now: () => { const out = t; t = addMs(t, stepMs); return out; } } as Clock;
}

function devSigner(clock: Clock): SoftwareDevSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new SoftwareDevSigner({ privateKeyPkcs8Hex: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('hex'), cluster: 'devnet', liveCapabilityEnabled: true, clock });
}

async function envelopeFor(intent: TradeIntent, key: SigningKeyPair, nonce: Nonce) {
  const { intentHash: _drop, ...unsigned } = {
    ...fixtures.riskAuthorizedIntent(),
    intentId: intent.id, actionCycleId: intent.actionCycleId, clearedCutoffVersion: intent.clearedCutoffVersion, accountId: intent.accountId, assetId: intent.assetId, strategyVersionId: intent.strategyVersionId, sleeveId: intent.sleeveId,
    cluster: 'devnet' as const, capitalAuthority: 'LIVE_AUTO' as const, action: intent.action, side: intent.side, exposureEffect: intent.exposureEffect, inputMint: intent.inputMint, outputMint: intent.outputMint, maxInputAmount: intent.maxInputAmount,
    maxSlippageBps: intent.constraints.maxSlippageBps, maxPriceImpactBps: intent.constraints.maxPriceImpactBps, chaseToleranceBps: intent.constraints.chaseToleranceBps, maxQuoteAgeMs: intent.constraints.maxQuoteAgeMs,
    targetLotIds: intent.targetLotIds, approvalRequired: intent.approvalRequired, issuedAt: intent.createdAt, expiresAt: intent.expiresAt, nonce,
  };
  void _drop;
  const payload: RiskAuthorizedIntent = { ...unsigned, intentHash: await canonicalHash(unsigned) } as RiskAuthorizedIntent;
  return signPayload(payload, key, intent.createdAt);
}

interface World {
  chain: FakeChain;
  journalPath: string;
  signer: TradingWalletSigner;
  authorizer: SigningKeyPair;
  guardrails: ExecutorGuardrails;
  clock: Clock;
  pipeline: ExecutorPipeline;
  reopen(over?: Partial<Pick<PipelineDeps, 'probe' | 'signer' | 'modeFacts'>>): Promise<ExecutorPipeline>;
  request(over?: Partial<TradeIntent>): Promise<{ request: ExecutionRequest; intent: TradeIntent }>;
  submit(over?: Partial<TradeIntent>, stored?: (i: TradeIntent) => TradeIntent | null): Promise<SubmitOutcome>;
}

interface WorldOptions {
  behaviour?: ExecuteBehaviour;
  quotes?: Quote[];
  probe?: (b: Boundary) => void;
  signer?: (base: TradingWalletSigner) => TradingWalletSigner;
  chain?: Partial<FakeChainOptions>;
  modeFacts?: () => ModeFacts;
}

let dir: string;
let authorizer: SigningKeyPair;
beforeAll(async () => {
  authorizer = await generateSigningKeyPair();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solmate-harness-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function world(opts: WorldOptions = {}): Promise<World> {
  const clock = steppingClock(AT, 100);
  const base = devSigner(clock);
  const signer = opts.signer ? opts.signer(base) : base;
  const q = quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
  const chain = new FakeChain({ wallet: base.publicKey, inputMint: USDC, outputMint: TOKEN, clock, quotes: opts.quotes ?? [q, q], behaviour: opts.behaviour ?? 'FILL', ...opts.chain });
  const guardrails: ExecutorGuardrails = {
    liveCapabilityEnabled: true, cluster: 'devnet', tradingWalletAddress: base.publicKey, allowedSettlementMints: [USDC], allowedFundingMints: [USDC],
    maxPerEntryNotionalBaseUnits: '300000000', maxAggregateNonSettlementExposureBaseUnits: '900000000', maxSignerOutageUnprotectedExposureBaseUnits: '400000000', maxEmergencyCloseTxBaseUnits: null,
    hardMaxSlippageBps: 150 as Bps, hardMaxProtectiveSlippageBps: 300 as Bps, acceptedRiskAuthorizerKeyIds: [authorizer.keyId], acceptedEmergencyOperatorKeyIds: ['ed25519:' + '1'.repeat(32) as KeyId], expectedSignerPolicyDigest: null, expectedSignerWorkloadFingerprint: null,
  };
  const journalPath = join(dir, `executor-${seq}.journal`);
  let token = 0;
  const open = async (over: Partial<Pick<PipelineDeps, 'probe' | 'signer' | 'modeFacts'>> = {}): Promise<ExecutorPipeline> => {
    const journal = await ExecutorJournal.open(journalPath, `executor-${++token}`, () => clock.now());
    return new ExecutorPipeline({
      journal, guardrails, authorizerKeys: [authorizer], approverKeys: [], signer, chain, clock, newId,
      modeFacts: () => ACTIVE,
      adapter: { orders: chain.orderClient(), quotes: chain.quoteClient(), simulation: chain, cluster: 'devnet', structure: { allowedPrograms: [...BASE_PROGRAMS, JUPITER_V6_PROGRAM], allowLookupTables: false, allowedTransferRecipients: [] }, maxSolDebitLamports: 50_000n, decisionQuote: async (intent) => (await chain.quoteClient().quote({ inputMint: intent.inputMint, outputMint: intent.outputMint, inputAmount: intent.maxInputAmount, maxSlippageBps: intent.constraints.maxSlippageBps, taker: base.publicKey, cluster: 'devnet', requestedAt: clock.now() })).quote },
      awaitFinalized: async (signature) => { const s = chain.statuses.get(signature); if (!s) return null; s.confirmationStatus = 'finalized'; return { slot: s.slot }; },
      maxSkewMs: 5_000,
      probe: opts.probe,
      ...over,
    });
  };
  const pipeline = await open();
  const w: World = {
    chain, journalPath, signer, authorizer, guardrails, clock, pipeline,
    reopen: async (over) => { w.pipeline.journal.release(); w.pipeline = await open(over); return w.pipeline; },
    request: async (over = {}) => {
      const n = ++seq;
      const intent: TradeIntent = { ...baseIntent(newId(), `harness:${n}`, USDC, TOKEN, AT, addMs(AT, 120_000)), ...over };
      const authorization = await envelopeFor(intent, authorizer, nonceOf(n));
      return { request: { intent, capitalAuthority: 'LIVE_AUTO', authorization, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: AT }, intent };
    },
    submit: async (over = {}, stored = (i) => i) => {
      const { request, intent } = await w.request(over);
      return w.pipeline.submit({ request, storedIntent: stored(intent), approval: null, protectionMode: 'MONITORED_EXIT' });
    },
  };
  return w;
}

const kinds = (w: World) => w.pipeline.journal.all().map((e) => e.kind);

describe('execution harness (§24.3): the pipeline over a fake Jupiter/Solana', () => {
  it('successful fill: authority → prepared → caps → signed → submitted → finalized, journaled in that order, exposure held at cost', async () => {
    const w = await world();
    const r = await w.submit();
    expect(r.outcome).toBe('EXECUTED');
    if (r.outcome !== 'EXECUTED') return;
    expect(r.execution.attempt.state).toBe('FINALIZED');
    expect(r.execution.fill?.outputAmount).toBe('998000');
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_SIGNED', 'ATTEMPT_SUBMITTED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT']);
    expect(w.chain.landed).toHaveLength(1);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    expect(w.pipeline.registry.state(w.pipeline.journal.all()[0]!.payload['idempotencyKey'] as never)).toBe('COMPLETED');
  });

  it('duplicate worker delivery: the same idempotency key is refused with no second attempt, before and after a restart', async () => {
    const w = await world();
    const { request, intent } = await w.request();
    const first = await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' });
    expect(first.outcome).toBe('EXECUTED');
    const again = await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' });
    expect(again).toMatchObject({ outcome: 'DUPLICATE', intentId: intent.id, state: 'COMPLETED' });
    const entries = kinds(w).length;
    await w.reopen();
    const afterRestart = await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' });
    expect(afterRestart.outcome).toBe('DUPLICATE');
    expect(kinds(w)).toHaveLength(entries);
    expect(w.chain.executeCalls).toHaveLength(1);
  });

  it('DB tamper and cap breaches are refused before anything is prepared or signed', async () => {
    const w = await world();
    const tampered = await w.submit({}, (i) => ({ ...i, maxInputAmount: '250000000' as Amount }));
    expect(tampered).toMatchObject({ outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['DB_TAMPER_DETECTED'] });
    expect(kinds(w)).toEqual([]);
    const missing = await w.submit({}, () => null);
    expect(missing).toMatchObject({ outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['INTENT_RECORD_MISSING'] });
    const overCap = await w.submit({ maxInputAmount: '300000001' as Amount });
    expect(overCap).toMatchObject({ outcome: 'DENIED', stage: 'CAPS', reasons: ['PER_ENTRY_CAP'] });
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'ATTEMPT_RESULT']);
    expect(w.chain.orders).toEqual([]);
    expect(w.pipeline.openExposure()).toBe(0n);
  });

  it('quote invalid between risk check and execution: refused pre-submit, exposure released, nothing signed', async () => {
    const w = await world({ quotes: [quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT), quoteOf(100_000_000n, 950_000n, 100, 20, USDC, TOKEN, AT)] });
    const r = await w.submit();
    expect(r.outcome).toBe('EXECUTED');
    if (r.outcome !== 'EXECUTED') return;
    expect(r.execution.result.rejectionReasons[0]).toBe('CHASE_EXCEEDED');
    expect(r.execution.result.signedTxHash).toBeNull();
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT']);
    expect(w.pipeline.openExposure()).toBe(0n);
  });

  it('stale blockhash and slippage failure: the provider says Failed, the chain proves the transaction dead, NOT_LANDED and released', async () => {
    for (const [behaviour, reason] of [['STALE_BLOCKHASH', 'EXECUTE_FAILED_-32002'], ['SLIPPAGE_FAIL', 'SLIPPAGE_EXCEEDED']] as const) {
      const w = await world({ behaviour });
      const r = await w.submit();
      expect(r.outcome, behaviour).toBe('EXECUTED');
      if (r.outcome !== 'EXECUTED') return;
      expect(r.execution.attempt.state, behaviour).toBe('NOT_LANDED');
      expect(r.execution.result.rejectionReasons[0], behaviour).toBe(reason);
      expect(w.chain.landed, behaviour).toHaveLength(0);
      expect(w.pipeline.openExposure(), behaviour).toBe(0n);
      expect(kinds(w).at(-1), behaviour).toBe('ATTEMPT_RESULT');
    }
  });

  it('partial/changed amount: the fill records what actually landed and the shortfall against the quote', async () => {
    const w = await world({ behaviour: 'PARTIAL_FILL' });
    const r = await w.submit();
    if (r.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(r.execution.attempt.state).toBe('FINALIZED');
    expect(r.execution.fill).toMatchObject({ inputAmount: '100000000', outputAmount: '598800', executionShortfallBps: 4012 });
    expect(w.chain.landed[0]?.outputAmount).toBe(598_800n);
  });

  it('remote signer timeout then retry: the identical canonical bytes are re-signed and the signature is the same', async () => {
    let flaky!: ReturnType<typeof flakySigner>;
    const w = await world({ signer: (base) => (flaky = flakySigner(base, 1)) });
    const r = await w.submit();
    if (r.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(r.execution.attempt.state).toBe('FINALIZED');
    expect(flaky.calls).toHaveLength(2);
    expect(Buffer.from(flaky.calls[0]!).equals(Buffer.from(flaky.calls[1]!))).toBe(true);
    expect(w.chain.landed).toHaveLength(1);
    expect(w.chain.landed[0]?.signature).toBe(r.execution.attempt.expectedTxSignature);
  });

  it('unknown submission result / landed but response timeout: recovery finds the landed transaction, finishes it once, and a redelivery is a duplicate', async () => {
    const w = await world({ behaviour: 'LAND_THEN_TIMEOUT' });
    const { request, intent } = await w.request();
    await expect(w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).rejects.toThrow(/timed out/);
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_SIGNED', 'ATTEMPT_SUBMITTED']);
    expect(w.chain.landed).toHaveLength(1);
    await w.reopen();
    expect(await w.pipeline.recover()).toEqual([{ correlationId: intent.id, resolution: 'LANDED_CONFIRMED_PENDING', signature: w.chain.landed[0]!.signature }]);
    expect(w.pipeline.openExposure()).toBe(100_000_000n); // exposure is real while confirmed
    w.chain.finalizeAll();
    expect(await w.pipeline.recover()).toEqual([{ correlationId: intent.id, resolution: 'LANDED_FINALIZED', signature: w.chain.landed[0]!.signature }]);
    expect(kinds(w).slice(-2)).toEqual(['EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT']);
    expect(await w.pipeline.recover()).toEqual([]);
    const again = await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' });
    expect(again).toMatchObject({ outcome: 'DUPLICATE', state: 'COMPLETED' });
    expect(w.chain.landed).toHaveLength(1);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
  });

  it('failed before submission (router error after the SUBMITTED journal line): unknown until proven; provable after the block height passes', async () => {
    const w = await world({ behaviour: 'FAIL_BEFORE_SUBMIT' });
    const { request, intent } = await w.request();
    await expect(w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).rejects.toThrow(/unavailable/);
    await w.reopen();
    expect((await w.pipeline.recover())[0]?.resolution).toBe('STILL_LANDABLE');
    expect(w.pipeline.openExposure()).toBe(100_000_000n); // still reserved: INV-23
    expect((await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).outcome).toBe('DUPLICATE');
    w.chain.advanceBlocks(200);
    expect((await w.pipeline.recover())[0]?.resolution).toBe('NOT_LANDED');
    expect(w.pipeline.openExposure()).toBe(0n);
    expect(w.chain.landed).toHaveLength(0);
  });

  it('crash after durable SIGNED_NOT_SUBMITTED but before submit: the attempt stays unresolved while landable, then resolves dead; a fresh intent may proceed', async () => {
    const w = await world({ probe: (b) => { if (b === 'AFTER_SIGNED_JOURNAL') throw new CrashSignal(b); } });
    const { request, intent } = await w.request();
    await expect(w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).rejects.toThrow(CrashSignal);
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_SIGNED']);
    expect(w.chain.executeCalls).toEqual([]);
    await w.reopen({ probe: undefined });
    expect((await w.pipeline.recover())[0]).toMatchObject({ resolution: 'STILL_LANDABLE', signature: expect.any(String) });
    expect((await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).outcome).toBe('DUPLICATE');
    w.chain.advanceBlocks(200);
    expect((await w.pipeline.recover())[0]?.resolution).toBe('NOT_LANDED');
    expect(w.pipeline.openExposure()).toBe(0n);
    const fresh = await w.submit();
    expect(fresh.outcome).toBe('EXECUTED');
    if (fresh.outcome === 'EXECUTED') expect(fresh.execution.attempt.state).toBe('FINALIZED');
    expect(w.chain.landed).toHaveLength(1);
  });

  it('crash after submit but before response persistence: recovery completes the landed entry exactly once', async () => {
    const w = await world({ behaviour: 'LAND_THEN_CRASH' });
    const { request, intent } = await w.request();
    await expect(w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).rejects.toThrow(CrashSignal);
    expect(kinds(w).at(-1)).toBe('ATTEMPT_SUBMITTED');
    w.chain.finalizeAll();
    await w.reopen();
    expect((await w.pipeline.recover())[0]?.resolution).toBe('LANDED_FINALIZED');
    expect(w.pipeline.ledger.history().filter((e) => e.kind === 'ENTRY_CONFIRMED')).toHaveLength(1);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    expect(w.chain.landed).toHaveLength(1);
    expect((await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).outcome).toBe('DUPLICATE');
  });

  it('crash at the other boundaries (after PREPARED, after SUBMITTED journal): nothing lands twice and recovery is consistent', async () => {
    for (const boundary of ['AFTER_PREPARED', 'AFTER_SUBMITTED_JOURNAL'] as const) {
      const w = await world({ probe: (b) => { if (b === boundary) throw new CrashSignal(b); } });
      const { request, intent } = await w.request();
      await expect(w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).rejects.toThrow(CrashSignal);
      expect(w.chain.landed, boundary).toHaveLength(0);
      await w.reopen({ probe: undefined });
      const recovered = await w.pipeline.recover();
      if (boundary === 'AFTER_PREPARED') {
        expect(recovered, boundary).toEqual([]); // nothing was signed: the key is claimed, exposure reserved, no attempt to resolve
        expect((await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' })).outcome, boundary).toBe('DUPLICATE');
      } else {
        expect(recovered[0]?.resolution, boundary).toBe('STILL_LANDABLE');
        w.chain.advanceBlocks(200);
        expect((await w.pipeline.recover())[0]?.resolution, boundary).toBe('NOT_LANDED');
        expect(w.pipeline.openExposure(), boundary).toBe(0n);
      }
    }
  });

  it('tampered transaction whose simulation moves an unrelated token, and an unexpected signer in the assembled transaction: refused, nothing signed', async () => {
    const drain = await world({ chain: { tamperPost: (post, wallet) => post.map((a) => (a && a.address === OTHER_ATA ? { ...a, dataBase64: tokenAccountData(OTHER_MINT, wallet, 0n) } : a)) } });
    const d = await drain.submit();
    if (d.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(d.execution.result.rejectionReasons).toContain('UNRELATED_TOKEN_DECREASE');
    expect(d.execution.result.signedTxHash).toBeNull();
    expect(drain.chain.executeCalls).toEqual([]);
    const extraSigner = await world({ chain: { tamperMessage: (m: DecodedMessage) => ({ ...m, header: { ...m.header, numRequiredSignatures: 2 }, staticAccountKeys: [m.staticAccountKeys[0]!, ATTACKER, ...m.staticAccountKeys.slice(1)] }) } });
    const e = await extraSigner.submit();
    if (e.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(e.execution.result.rejectionReasons).toContain('UNEXPECTED_SIGNER');
    expect(e.execution.result.signedTxHash).toBeNull();
  });

  it('signer policy denies an unexpected program even when a compromised executor skips its own validation', async () => {
    let policy!: ReturnType<typeof policySigner>;
    const w = await world({ signer: (base) => (policy = policySigner(base)), chain: { tamperMessage: (m) => ({ ...m, staticAccountKeys: m.staticAccountKeys.map((k) => (k === JUPITER_V6_PROGRAM ? ATTACKER : k)) }) } });
    // Through the pipeline: the executor's own structural check stops it first and the signer is never asked.
    const r = await w.submit();
    if (r.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(r.execution.result.rejectionReasons).toContain('PROGRAM_NOT_ALLOWED');
    expect(policy.refusals).toEqual([]);
    // Compromise fixture: executor code calls the signer directly with the foreign-program message.
    const hostile = { ...swapMessage(w.signer.publicKey), staticAccountKeys: swapMessage(w.signer.publicKey).staticAccountKeys.map((k) => (k === JUPITER_V6_PROGRAM ? ATTACKER : k)) };
    const bytes = encodeMessage(hostile);
    await expect(policy.signTransactionMessage(bytes, { intentId: newId(), attemptId: newId(), messageHash: await sha256Hex(bytes) })).rejects.toThrow(/signer policy/);
    expect(policy.refusals).toEqual([ATTACKER]);
    expect(w.chain.landed).toHaveLength(0);
  });

  it('mode gate re-read immediately before submit: a pause that lands after signing stops the submission and releases exposure', async () => {
    let paused = false;
    const w = await world({ probe: (b) => { if (b === 'AFTER_SIGNED_JOURNAL') paused = true; } });
    await w.reopen({ modeFacts: () => ({ ...ACTIVE, paused }) });
    const r = await w.submit();
    if (r.outcome !== 'EXECUTED') throw new Error('expected execution');
    expect(r.execution.result.rejectionReasons).toEqual(['MODE_GATE_PAUSED']);
    expect(r.execution.attempt.state).toBe('SIGNED_NOT_SUBMITTED');
    expect(w.chain.executeCalls).toEqual([]);
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_SIGNED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT']);
    expect(w.pipeline.openExposure()).toBe(0n);
  });
});
