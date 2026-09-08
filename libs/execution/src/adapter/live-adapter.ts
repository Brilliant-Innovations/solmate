import { amountToBigInt, instantToMs, sha256Hex, type Amount, type Clock, type ExecutionAdapter, type ExecutionPath, type ExecutionPreview, type ExecutionRequest, type ExecutionResult, type Fill, type Instant, type JupiterQuoteClient, type Order, type OrderAttempt, type Quote, type QuoteRequest, type Sha256Hex, type TradeIntent, type SimulationReport, type Slot, type SolanaCluster, type TradingWalletSigner, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { attemptTransition, newOrderAttempt, type OrderAttemptRecord, type OrderAttemptResult } from '../state/order-attempt.js';
import { emptyIntentRegistry, registerIntent, type IntentRegistry } from '../state/intent.js';
import { NoRouteError } from '../jupiter/quote-client.js';
import type { JupiterOrderClient } from '../jupiter/order-client.js';
import { decodeTransaction, encodeTransaction, fromBase64, toBase64 } from '../tx/codec.js';
import { checkOrderAgainstAuthorization } from '../validate/order.js';
import { checkTransactionStructure, type StructureExpectation } from '../validate/structure.js';
import type { ExecutionBounds } from '../validate/bounds.js';
import { assertSemanticDeltas } from '../simulate/deltas.js';
import type { AccountSnapshot, SimulationReader } from '../simulate/client.js';
import type { DetailedExecution } from './paper-adapter.js';
import { chaseWorseBps } from './fill-model.js';
import type { OrderRejection } from '../validate/order.js';

/**
 * Live execution adapter (blueprint §15.4 in full, D12, D21, D45, D49; ADR-0009 P3/P4/P7). The
 * same shape and result as the paper adapter so the parity table applies, with real steps:
 *
 *   /order for the exact authorized pair and amount → order-vs-authorization checks → structural
 *   checks → independent simulation with pre/post wallet state → semantic delta assertions →
 *   re-check validity → executor's pre-submit gate (P3) → sign → persist SIGNED_NOT_SUBMITTED →
 *   /execute → SUBMITTED → observe confirmed → finalized (or proven dead → NOT_LANDED)
 *
 * The adapter never decides authority: the caller hands it an already-verified envelope and the
 * executor's own gate hook. It never declares a submitted transaction dead on its own word: only
 * a proof (block height expired and signature history empty) moves an attempt to NOT_LANDED.
 */

export interface LiveAdapterOptions {
  orders: JupiterOrderClient;
  quotes: JupiterQuoteClient;
  signer: TradingWalletSigner;
  simulation: SimulationReader;
  /** The quote the strategy decided on (the cycle's DECISION probe); the chase check measures the order against it. */
  decisionQuote: (intent: TradeIntent) => Promise<Quote | null>;
  clock: Clock;
  cluster: SolanaCluster;
  newId: () => Uuid;
  structure: Omit<StructureExpectation, 'tradingWallet'>;
  /** Fees and rent the shape may spend from the wallet; asserted against the simulated SOL debit. */
  maxSolDebitLamports: bigint;
  /** Persists the SIGNED_NOT_SUBMITTED attempt; must be durable before it resolves (D12). */
  journal: (records: { order: Order; attempt: OrderAttempt }) => Promise<void>;
  /** The executor's mode gate and caps, read immediately before submit (P3). */
  beforeSubmit: (bounds: ExecutionBounds) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  /** Waits for finality of a confirmed signature; null when it could not be observed within the caller's budget. */
  awaitFinalized: (signature: TxSignature, lastValidBlockHeight: number | null) => Promise<{ slot: Slot } | null>;
  /** Proof that a submitted transaction can no longer land (INV-23); null when not (yet) provable. */
  proveDead: (signature: TxSignature, lastValidBlockHeight: number | null) => Promise<{ blockHeightExpired: boolean; signatureHistoryEmpty: boolean } | null>;
  currentBlockHeight: () => Promise<number | null>;
}

export class LiveExecutionAdapter implements ExecutionAdapter {
  readonly kind = 'live' as const;
  private registry: IntentRegistry = emptyIntentRegistry();

  constructor(private readonly opts: LiveAdapterOptions) {}

  async preview(request: QuoteRequest, path: ExecutionPath): Promise<ExecutionPreview> {
    const { quote } = await this.opts.quotes.quote(request);
    return { quote, executionPath: path, estimatedFees: { networkLamports: '5000' as Amount, priorityLamports: '0' as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount }, adverseExecutionAllowanceBps: 0 as never, previewedAt: this.opts.clock.now() };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return (await this.executeDetailed(request)).result;
  }

  /**
   * `emergency` carries D22 bounds built by the executor from chain custody (§15.10): no envelope
   * exists during a database outage, and the caller has already verified the command. Everything
   * downstream (order, structure, simulation, deltas, signing) runs exactly as for an envelope.
   */
  async executeDetailed(request: ExecutionRequest, emergency?: { bounds: ExecutionBounds }): Promise<DetailedExecution> {
    const { intent } = request;
    const wallet = this.opts.signer.publicKey;
    const order: Order = { id: this.opts.newId(), intentId: intent.id, authorizationHash: null, executionPath: request.executionPath, transactionClass: 'SWAP_V2', createdAt: this.opts.clock.now() };
    const attemptId = this.opts.newId();
    let machine = newOrderAttempt();
    const times = { quoteExpiresAt: null as Instant | null, signedAt: null as Instant | null, submittedAt: null as Instant | null, confirmedAt: null as Instant | null, finalizedAt: null as Instant | null };
    let requestId: string | null = null;
    let router: string | null = null;
    let simulation: SimulationReport | null = null;
    const reject = (reasons: string[], quote: Quote | null): DetailedExecution => ({
      result: this.result(intent.id, attemptId, request.executionPath, machine.state, quote, simulation, null, null, null, reasons),
      order,
      attempt: this.toAttempt(attemptId, order, machine, times, requestId, router),
      fill: null,
      decisionQuote: quote,
      outcome: null,
    });

    if (request.capitalAuthority !== 'LIVE_APPROVAL' && request.capitalAuthority !== 'LIVE_AUTO') return reject(['NOT_LIVE_AUTHORITY'], null);
    let authorized: ExecutionBounds;
    if (emergency) {
      if (emergency.bounds.exposureEffect !== 'REDUCE') return reject(['EMERGENCY_NOT_RISK_REDUCING'], null);
      authorized = emergency.bounds;
    } else {
      if (!request.authorization || request.authorization.payload.intentId !== intent.id) return reject(['AUTHORIZATION_MISSING'], null);
      authorized = request.authorization.payload;
      order.authorizationHash = request.authorization.payloadHash;
      if (request.capitalAuthority === 'LIVE_APPROVAL' && !request.approvalHash) return reject(['APPROVAL_MISSING'], null);
    }
    const registered = registerIntent(this.registry, intent.id, intent.idempotencyKey);
    if (registered.outcome === 'DUPLICATE') return reject(['DUPLICATE_INTENT'], null);
    this.registry = registered.registry;

    // 1. Order for exactly the authorized pair and amount.
    const now = this.opts.clock.now();
    if (instantToMs(now) >= instantToMs(intent.expiresAt)) return reject(['INTENT_EXPIRED'], null);
    let decision: Quote | null = null;
    if (authorized.chaseToleranceBps !== null) {
      try {
        decision = await this.opts.decisionQuote(intent);
      } catch (err) {
        if (err instanceof NoRouteError) return reject(['NO_ROUTE'], null);
        throw err;
      }
      if (!decision) return reject(['DECISION_QUOTE_MISSING'], null);
    }
    const quoteRequest: QuoteRequest = { inputMint: authorized.inputMint, outputMint: authorized.outputMint, inputAmount: authorized.maxInputAmount, maxSlippageBps: authorized.maxSlippageBps, taker: wallet, cluster: this.opts.cluster, requestedAt: now };
    let built: Awaited<ReturnType<JupiterOrderClient['order']>>;
    try {
      built = await this.opts.orders.order(quoteRequest);
    } catch (err) {
      if (err instanceof NoRouteError) return reject(['NO_ROUTE'], null);
      throw err;
    }
    requestId = built.requestId;
    router = built.router;
    times.quoteExpiresAt = built.quote.expiresAt;
    const txBytes = fromBase64(built.transactionBase64);

    // 2–3. Order versus authorization.
    const orderCheck = await checkOrderAgainstAuthorization(
      { requestId: built.requestId, inputMint: built.quote.inputMint, outputMint: built.quote.outputMint, inAmount: built.quote.inputAmount, outAmount: built.quote.expectedOutputAmount, minOutAmount: built.quote.minOutputAmount, slippageBps: built.quote.slippageBps, priceImpactBps: built.quote.priceImpactBps, taker: built.taker, quotedAt: built.quote.quotedAt, expiresAt: built.quote.expiresAt, lastValidBlockHeight: built.lastValidBlockHeight, transactionBytes: txBytes, reportedTransactionHash: null },
      authorized,
      { tradingWallet: wallet, now, currentBlockHeight: await this.opts.currentBlockHeight() },
    );
    if (!orderCheck.ok) return reject(canonicalReasons(orderCheck.reasons), built.quote);
    const worse = decision ? chaseWorseBps(decision, built.quote) : null;
    if (worse !== null && authorized.chaseToleranceBps !== null && worse > authorized.chaseToleranceBps) return reject(['CHASE_EXCEEDED', `executable price ${worse}bps worse than decision > ${authorized.chaseToleranceBps}bps`], built.quote);

    // 4. Structure.
    let decoded: ReturnType<typeof decodeTransaction>;
    try {
      decoded = decodeTransaction(txBytes);
    } catch {
      return reject(['TRANSACTION_UNDECODABLE'], built.quote);
    }
    const structure = checkTransactionStructure(decoded, { ...this.opts.structure, tradingWallet: wallet });
    if (!structure.ok) return reject(structure.reasons, built.quote);

    // 5–6. Independent simulation with wallet-owned pre/post state over every static key.
    const keys = decoded.message.staticAccountKeys;
    const pre = await this.opts.simulation.accounts(keys);
    const sim = await this.opts.simulation.simulate(toBase64(txBytes), keys);
    const walletIndex = keys.indexOf(wallet);
    const preWallet = pre.accounts[walletIndex]?.lamports ?? 0;
    const postWallet = sim.accounts[walletIndex]?.lamports ?? null;
    const deltas = assertSemanticDeltas({
      tradingWallet: wallet,
      inputMint: authorized.inputMint,
      outputMint: authorized.outputMint,
      maxInputDecrease: authorized.maxInputAmount,
      minOutputIncrease: built.quote.minOutputAmount,
      maxSolDebitLamports: this.opts.maxSolDebitLamports,
      pre: pre.accounts.filter((a): a is AccountSnapshot => a !== null),
      preWalletLamports: preWallet,
      post: sim.accounts,
      postWalletLamports: postWallet,
      simulationErr: sim.err,
      logs: sim.logs,
      slot: sim.slot,
      rpcLabel: this.opts.simulation.label,
    });
    simulation = deltas.report;
    if (!deltas.report.passed) return reject(deltas.reasons, built.quote);

    // 7. Re-check validity after simulation, then the executor's own gate (P3).
    const recheck = await checkOrderAgainstAuthorization(
      { requestId: built.requestId, inputMint: built.quote.inputMint, outputMint: built.quote.outputMint, inAmount: built.quote.inputAmount, outAmount: built.quote.expectedOutputAmount, minOutAmount: built.quote.minOutputAmount, slippageBps: built.quote.slippageBps, priceImpactBps: built.quote.priceImpactBps, taker: built.taker, quotedAt: built.quote.quotedAt, expiresAt: built.quote.expiresAt, lastValidBlockHeight: built.lastValidBlockHeight, transactionBytes: txBytes, reportedTransactionHash: null },
      authorized,
      { tradingWallet: wallet, now: this.opts.clock.now(), currentBlockHeight: await this.opts.currentBlockHeight() },
    );
    if (!recheck.ok) return reject(canonicalReasons(recheck.reasons), built.quote);
    if (instantToMs(this.opts.clock.now()) >= instantToMs(intent.expiresAt)) return reject(['INTENT_EXPIRED'], built.quote);

    // 8–10. Sign, derive identifiers, persist before submit.
    const messageHash = await sha256Hex(decoded.messageBytes);
    const signed = await this.opts.signer.signTransactionMessage(decoded.messageBytes, { intentId: intent.id, attemptId, messageHash });
    const signatures = decoded.signatures.map((s, i) => (i === 0 ? signed.signature : s));
    const signedBytes = encodeTransaction(signatures, decoded.message);
    const signedTxHash = (await sha256Hex(signedBytes)) as Sha256Hex;
    const signedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'SIGNED', at: signedAt, signedTxHash, expectedTxSignature: signed.signature, lastValidBlockHeight: built.lastValidBlockHeight }));
    times.signedAt = signedAt;
    await this.opts.journal({ order, attempt: this.toAttempt(attemptId, order, machine, times, requestId, router) });
    machine = must(attemptTransition(machine, { type: 'JOURNALED', at: signedAt }));

    // Executor gate re-read immediately before submit (P3): a pause that landed while we were signing stops here,
    // with the signed attempt durably recorded and never sent.
    const gate = await this.opts.beforeSubmit(authorized);
    if (!gate.allowed) return { ...reject([gate.reason], built.quote), result: this.result(intent.id, attemptId, request.executionPath, machine.state, built.quote, simulation, signedTxHash, null, null, [gate.reason]) };

    // 11–12. Submit and record the provider response.
    const submittedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'SUBMITTED', at: submittedAt, path: request.executionPath }));
    times.submittedAt = submittedAt;
    const exec = await this.opts.orders.execute(toBase64(signedBytes), built.requestId);
    const signature = (exec.signature ?? signed.signature) as TxSignature;
    if (exec.status !== 'Success') {
      const reason = /slippage/i.test(exec.error ?? '') ? 'SLIPPAGE_EXCEEDED' : `EXECUTE_FAILED${exec.code !== null ? `_${exec.code}` : ''}`;
      const proof = await this.opts.proveDead(signature, built.lastValidBlockHeight);
      if (proof) {
        const dead = attemptTransition(machine, { type: 'CONCLUSIVELY_DEAD', at: this.opts.clock.now(), blockHeightExpired: proof.blockHeightExpired, signatureHistoryEmpty: proof.signatureHistoryEmpty, reason: exec.error ?? reason });
        if (dead.ok) machine = dead.attempt;
      }
      return { result: this.result(intent.id, attemptId, request.executionPath, machine.state, built.quote, simulation, signedTxHash, signature, null, [reason]), order, attempt: this.toAttempt(attemptId, order, machine, times, requestId, router), fill: null, decisionQuote: built.quote, outcome: null };
    }

    // 13. Observe: the provider reports confirmation; finality comes from our own chain read.
    const confirmedSlot = (exec.slot ?? sim.slot) as Slot;
    const confirmedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'OBSERVED', at: confirmedAt, commitment: 'confirmed', slot: confirmedSlot }));
    times.confirmedAt = confirmedAt;
    const final = await this.opts.awaitFinalized(signature, built.lastValidBlockHeight);
    // A fill exists from `confirmed` (provisional exposure, D49); it is promoted to `finalized` here when finality
    // arrived within budget, otherwise by the executor's finality tracker later (INV-22).
    let fill: Fill | null = null;
    {
      let finalizedAt: Instant | null = null;
      if (final) {
        finalizedAt = this.opts.clock.now();
        machine = must(attemptTransition(machine, { type: 'OBSERVED', at: finalizedAt, commitment: 'finalized', slot: final.slot }));
        times.finalizedAt = finalizedAt;
      }
      const inputAmount = (exec.inputAmountResult ?? built.quote.inputAmount) as Amount;
      const outputAmount = (exec.outputAmountResult ?? built.quote.minOutputAmount) as Amount;
      const expected = amountToBigInt(built.quote.expectedOutputAmount);
      fill = {
        id: this.opts.newId(),
        orderAttemptId: attemptId,
        txSignature: signature,
        commitment: final ? 'finalized' : 'confirmed',
        slot: final ? final.slot : confirmedSlot,
        inputMint: authorized.inputMint,
        outputMint: authorized.outputMint,
        inputAmount,
        outputAmount,
        fees: { networkBaseUnits: '5000' as Amount, priorityBaseUnits: '0' as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount },
        executionShortfallBps: expected > 0n ? Number(((expected - amountToBigInt(outputAmount)) * 10_000n) / expected) : null,
        executionPath: request.executionPath,
        lotAllocations: intent.targetLotIds.map((lotId) => ({ lotId, quantity: inputAmount })),
        filledAt: finalizedAt ?? confirmedAt,
      };
    }
    return { result: this.result(intent.id, attemptId, request.executionPath, machine.state, built.quote, simulation, signedTxHash, signature, fill?.id ?? null, []), order, attempt: this.toAttempt(attemptId, order, machine, times, requestId, router), fill, decisionQuote: built.quote, outcome: null };
  }

  private result(intentId: Uuid, attemptId: Uuid, path: ExecutionPath, state: OrderAttemptRecord['state'], quote: Quote | null, simulation: SimulationReport | null, signedTxHash: Sha256Hex | null, txSignature: TxSignature | null, fillId: Uuid | null, rejectionReasons: string[]): ExecutionResult {
    return { intentId, attemptId, state, executionPath: path, quote, simulation, signedTxHash, txSignature, fillId, paper: null, rejectionReasons, completedAt: this.opts.clock.now() };
  }

  private toAttempt(id: Uuid, order: Order, m: OrderAttemptRecord, t: { quoteExpiresAt: Instant | null; signedAt: Instant | null; submittedAt: Instant | null; confirmedAt: Instant | null; finalizedAt: Instant | null }, requestId: string | null, router: string | null): OrderAttempt {
    return {
      id, orderId: order.id, intentId: order.intentId, authorizationHash: order.authorizationHash, attemptNumber: 1, state: m.state, jupiterRequestId: requestId, router, signedTxHash: m.signedTxHash, walletSignature: m.expectedTxSignature, expectedTxSignature: m.expectedTxSignature,
      blockhash: null, lastValidBlockHeight: m.lastValidBlockHeight, quoteExpiresAt: t.quoteExpiresAt, signedAt: t.signedAt, submittedAt: t.submittedAt,
      submissions: m.submissionPaths.map((path) => ({ at: t.submittedAt ?? order.createdAt, path, ok: true, providerResponseSignature: m.expectedTxSignature, error: null })),
      confirmedAt: t.confirmedAt, confirmedSlot: m.confirmedSlot, finalizedAt: t.finalizedAt, finalizedSlot: m.finalizedSlot, reorgDetectedAt: m.reorgDetectedAt, notLandedReason: m.notLandedReason, reconciliationOutcome: null, createdAt: order.createdAt,
    };
  }
}

/** The parity vocabulary (contracts EXECUTION_REJECTIONS) leads; the validator's precise reason follows it. */
function canonicalReasons(reasons: OrderRejection[]): string[] {
  const map: Partial<Record<OrderRejection, string>> = { IMPACT_ABOVE_AUTHORIZED: 'IMPACT_ABOVE_MAX', IMPACT_UNKNOWN: 'IMPACT_ABOVE_MAX', AUTHORIZATION_EXPIRED: 'INTENT_EXPIRED', QUOTE_TOO_OLD: 'QUOTE_STALE', QUOTE_EXPIRED: 'QUOTE_STALE', BLOCK_HEIGHT_EXPIRED: 'QUOTE_STALE', SLIPPAGE_ABOVE_AUTHORIZED: 'SLIPPAGE_EXCEEDED' };
  const first = reasons.map((r) => map[r]).find((r): r is string => r !== undefined);
  return first ? [first, ...reasons] : [...reasons];
}

function must(r: OrderAttemptResult): OrderAttemptRecord {
  if (!r.ok) throw new Error(`live attempt transition rejected: ${JSON.stringify(r.rejection)}`);
  return r.attempt;
}

