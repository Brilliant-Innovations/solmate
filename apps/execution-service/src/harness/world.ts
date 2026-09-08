import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { addMs, canonicalHash, fixtures, signPayload, toInstant, type Bps, type Clock, type ExecutionRequest, type ExecutorGuardrails, type Instant, type KeyId, type MintAddress, type Nonce, type Quote, type RiskAuthorizedIntent, type SigningKeyPair, type TradeIntent, type TradingWalletSigner, type Uuid } from '@sol-agent-trader/contracts';
import { BASE_PROGRAMS, JUPITER_V6_PROGRAM, SoftwareDevSigner, baseIntent, quoteOf, type QuorumObserver } from '@sol-agent-trader/execution';
import { ExecutorPipeline, type Boundary, type PipelineDeps, type SubmitOutcome } from '../pipeline/pipeline.js';
import { ExecutorJournal } from '../journal/journal.js';
import type { ModeFacts } from '../authority/mode-gate.js';
import { FakeChain, type ExecuteBehaviour, type FakeChainOptions } from './fake-chain.js';

/** Shared harness world (§24.3): the real pipeline over the fake chain, one journal per world, rebuildable after a "crash". Test-only. */

export const AT: Instant = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
export const USDC = fixtures.MINTS.USDC as MintAddress;
export const TOKEN = fixtures.MINTS.RISK as MintAddress;
export const ACTIVE: ModeFacts = { activity: 'ACTIVE', authority: 'LIVE_AUTO', paused: false, localPause: false, liveCapabilityEnabled: true };

let seq = 0;
export const newId = (): Uuid => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
export const nonceOf = (n: number): Nonce => n.toString(16).padStart(32, '0') as Nonce;
export const nextSeq = (): number => ++seq;

export function steppingClock(start: Instant, stepMs: number): Clock {
  let t = start;
  return { now: () => { const out = t; t = addMs(t, stepMs); return out; } } as Clock;
}

export function devSigner(clock: Clock): SoftwareDevSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new SoftwareDevSigner({ privateKeyPkcs8Hex: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('hex'), cluster: 'devnet', liveCapabilityEnabled: true, clock });
}

export async function envelopeFor(intent: TradeIntent, key: SigningKeyPair, nonce: Nonce) {
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

export interface World {
  chain: FakeChain;
  journalPath: string;
  signer: TradingWalletSigner;
  authorizer: SigningKeyPair;
  emergencyOperator: SigningKeyPair;
  guardrails: ExecutorGuardrails;
  clock: Clock;
  pipeline: ExecutorPipeline;
  reopen(over?: Partial<Pick<PipelineDeps, 'probe' | 'signer' | 'modeFacts'>>): Promise<ExecutorPipeline>;
  request(over?: Partial<TradeIntent>): Promise<{ request: ExecutionRequest; intent: TradeIntent }>;
  submit(over?: Partial<TradeIntent>, stored?: (i: TradeIntent) => TradeIntent | null): Promise<SubmitOutcome>;
}

export interface WorldOptions {
  behaviour?: ExecuteBehaviour;
  quotes?: Quote[];
  probe?: (b: Boundary) => void;
  signer?: (base: TradingWalletSigner) => TradingWalletSigner;
  chain?: Partial<FakeChainOptions>;
  modeFacts?: () => ModeFacts;
  guardrails?: Partial<ExecutorGuardrails>;
  /** DEFERRED: `/execute` returns CONFIRMED_PROVISIONAL and the finality tracker finishes the attempt. */
  finality?: 'WITHIN_BUDGET' | 'DEFERRED';
  secondaryChain?: QuorumObserver;
  persistFinality?: PipelineDeps['persistFinality'];
}

export async function createWorld(dir: string, keys: { authorizer: SigningKeyPair; emergencyOperator: SigningKeyPair }, opts: WorldOptions = {}): Promise<World> {
  const clock = steppingClock(AT, 100);
  const base = devSigner(clock);
  const signer = opts.signer ? opts.signer(base) : base;
  const q = quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
  const chain = new FakeChain({ wallet: base.publicKey, inputMint: USDC, outputMint: TOKEN, clock, quotes: opts.quotes ?? [q, q], behaviour: opts.behaviour ?? 'FILL', ...opts.chain });
  const guardrails: ExecutorGuardrails = {
    liveCapabilityEnabled: true, cluster: 'devnet', tradingWalletAddress: base.publicKey, allowedSettlementMints: [USDC], allowedFundingMints: [USDC],
    maxPerEntryNotionalBaseUnits: '300000000', maxAggregateNonSettlementExposureBaseUnits: '900000000', maxSignerOutageUnprotectedExposureBaseUnits: '400000000', maxEmergencyCloseTxBaseUnits: null,
    hardMaxSlippageBps: 150 as Bps, hardMaxProtectiveSlippageBps: 300 as Bps, acceptedRiskAuthorizerKeyIds: [keys.authorizer.keyId], acceptedEmergencyOperatorKeyIds: [keys.emergencyOperator.keyId], expectedSignerPolicyDigest: null, expectedSignerWorkloadFingerprint: null,
    ...opts.guardrails,
  };
  const journalPath = join(dir, `executor-${nextSeq()}.journal`);
  let token = 0;
  const open = async (over: Partial<Pick<PipelineDeps, 'probe' | 'signer' | 'modeFacts'>> = {}): Promise<ExecutorPipeline> => {
    const journal = await ExecutorJournal.open(journalPath, `executor-${++token}`, () => clock.now());
    return new ExecutorPipeline({
      journal, guardrails, authorizerKeys: [keys.authorizer], approverKeys: [], emergencyOperatorKeys: [keys.emergencyOperator], signer, chain, custody: chain, clock, newId,
      modeFacts: opts.modeFacts ?? (() => ACTIVE),
      emergency: { slippageBps: 200 as Bps, maxPriceImpactBps: 500 as Bps, maxQuoteAgeMs: 15_000, validityMs: 60_000 },
      adapter: { orders: chain.orderClient(), quotes: chain.quoteClient(), simulation: chain, cluster: 'devnet', structure: { allowedPrograms: [...BASE_PROGRAMS, JUPITER_V6_PROGRAM], allowLookupTables: false, allowedTransferRecipients: [] }, maxSolDebitLamports: 50_000n, decisionQuote: async (intent) => (await chain.quoteClient().quote({ inputMint: intent.inputMint, outputMint: intent.outputMint, inputAmount: intent.maxInputAmount, maxSlippageBps: intent.constraints.maxSlippageBps, taker: base.publicKey, cluster: 'devnet', requestedAt: clock.now() })).quote },
      awaitFinalized: async (signature) => { if (opts.finality === 'DEFERRED') return null; const s = chain.statuses.get(signature); if (!s) return null; s.confirmationStatus = 'finalized'; return { slot: s.slot }; },
      secondaryChains: opts.secondaryChain ? [opts.secondaryChain] : undefined,
      persistFinality: opts.persistFinality,
      maxSkewMs: 5_000,
      probe: opts.probe,
      ...over,
    });
  };
  const pipeline = await open();
  const w: World = {
    chain, journalPath, signer, authorizer: keys.authorizer, emergencyOperator: keys.emergencyOperator, guardrails, clock, pipeline,
    reopen: async (over) => { w.pipeline.journal.release(); w.pipeline = await open(over); return w.pipeline; },
    request: async (over = {}) => {
      const n = nextSeq();
      const intent: TradeIntent = { ...baseIntent(newId(), `harness:${n}`, USDC, TOKEN, AT, addMs(AT, 120_000)), ...over };
      const authorization = await envelopeFor(intent, keys.authorizer, nonceOf(n));
      return { request: { intent, capitalAuthority: 'LIVE_AUTO', authorization, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: AT }, intent };
    },
    submit: async (over = {}, stored = (i) => i) => {
      const { request, intent } = await w.request(over);
      return w.pipeline.submit({ request, storedIntent: stored(intent), approval: null, protectionMode: 'MONITORED_EXIT' });
    },
  };
  return w;
}

export const kinds = (w: World) => w.pipeline.journal.all().map((e) => e.kind);
export type { KeyId };
