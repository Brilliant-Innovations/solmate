import { createHash } from 'node:crypto';
import { addMs, type Clock, type ExecutionAdapter, type ExecutionPath, type ExecutionPreview, type ExecutionRequest, type ExecutionResult, type Fill, type Instant, type JupiterQuoteClient, type Order, type OrderAttempt, type PaperFillPolicy, type Quote, type QuoteRequest, type Sha256Hex, type Slot, type SolanaAddress, type SolanaCluster, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { attemptTransition, newOrderAttempt, type OrderAttemptRecord, type OrderAttemptResult } from '../state/order-attempt.js';
import { emptyIntentRegistry, registerIntent, type IntentRegistry } from '../state/intent.js';
import { modelPaperFill, type FillModelOutcome } from './fill-model.js';

/**
 * Paper execution adapter (blueprint §17.1–17.4; execution plan M5a). Runs the same sequence the
 * live adapter runs, over the same state machines, with no signing and no submission:
 *
 *   decision quote (real, now) → modelled submission delay → executable quote (real, later)
 *   → pre-submit checks → pseudo-sign → journal → SUBMITTED → modelled outcome
 *   → CONFIRMED_PROVISIONAL → FINALIZED (or NOT_LANDED when the modelled output misses the minimum)
 *
 * Only the fill model decides the output; a decision price never becomes a fill. The virtual
 * balances and custody are the only differences from live (parity suite in `parity.ts`).
 * Confirmation and finalization are modelled timestamps, not waits. Every fill carries the
 * policy version and the decision quote so it can be re-derived from stored inputs.
 */

export interface PaperAdapterOptions {
  quotes: JupiterQuoteClient;
  clock: Clock;
  policy: PaperFillPolicy;
  taker: SolanaAddress;
  cluster: SolanaCluster;
  newId: () => Uuid;
  /** Real wait before the executable quote so it is genuinely later than the decision quote; tests pass a no-op. */
  wait: (ms: number) => Promise<void>;
  /** Persists the signed-not-submitted attempt before the modelled submission (D12, §6.18). */
  journal: (records: { order: Order; attempt: OrderAttempt }) => Promise<void>;
}

export interface DetailedExecution {
  result: ExecutionResult;
  order: Order;
  attempt: OrderAttempt;
  fill: Fill | null;
  decisionQuote: Quote | null;
  outcome: FillModelOutcome | null;
}

export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly kind = 'paper' as const;
  private registry: IntentRegistry = emptyIntentRegistry();

  constructor(private readonly opts: PaperAdapterOptions) {}

  async preview(request: QuoteRequest, path: ExecutionPath): Promise<ExecutionPreview> {
    const { quote } = await this.opts.quotes.quote(request);
    const p = this.opts.policy;
    return {
      quote,
      executionPath: path,
      estimatedFees: { networkLamports: p.fees.networkLamports, priorityLamports: p.fees.priorityLamports, routerBaseUnits: '0' as never, transferFeeBaseUnits: '0' as never },
      adverseExecutionAllowanceBps: p.adverseAllowanceBpsByPath[path] ?? (0 as never),
      previewedAt: this.opts.clock.now(),
    };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return (await this.executeDetailed(request)).result;
  }

  async executeDetailed(request: ExecutionRequest): Promise<DetailedExecution> {
    const { intent } = request;
    const p = this.opts.policy;
    const order: Order = { id: this.opts.newId(), intentId: intent.id, authorizationHash: null, executionPath: request.executionPath, transactionClass: 'SWAP_V2', createdAt: this.opts.clock.now() };
    const attemptId = this.opts.newId();
    let machine = newOrderAttempt();
    const reject = (reasons: string[], decisionQuote: Quote | null, outcome: FillModelOutcome | null): DetailedExecution => {
      const attempt = this.toAttempt(attemptId, order, machine, { quoteExpiresAt: decisionQuote?.expiresAt ?? null, signedAt: null, submittedAt: null, confirmedAt: null, finalizedAt: null });
      return { result: this.result(intent.id, attemptId, request.executionPath, machine.state, decisionQuote, null, null, null, reasons), order, attempt, fill: null, decisionQuote, outcome };
    };

    if (request.capitalAuthority !== 'PAPER') return reject(['NOT_PAPER_AUTHORITY'], null, null);
    const registered = registerIntent(this.registry, intent.id, intent.idempotencyKey);
    if (registered.outcome === 'DUPLICATE') return reject(['DUPLICATE_INTENT'], null, null);
    this.registry = registered.registry;

    const decisionAt = this.opts.clock.now();
    const quoteRequest: QuoteRequest = { inputMint: intent.inputMint, outputMint: intent.outputMint, inputAmount: intent.maxInputAmount, maxSlippageBps: intent.constraints.maxSlippageBps, taker: this.opts.taker, cluster: this.opts.cluster, requestedAt: decisionAt };
    const decision = await this.tryQuote(quoteRequest);
    if (!decision) return reject(['NO_ROUTE'], null, null);

    await this.opts.wait(p.submissionDelayMs);
    const executionAt = addMs(decisionAt, p.submissionDelayMs);
    const executable = await this.tryQuote({ ...quoteRequest, requestedAt: executionAt });
    const outcome = modelPaperFill({ intent, decisionQuote: decision.quote, executableQuote: executable?.quote ?? null, path: request.executionPath, policy: p, executionAt });
    if (outcome.kind === 'REJECT' && outcome.stage === 'PRE_SUBMIT') return reject([outcome.reason], decision.quote, outcome);

    // Pseudo-sign: the identifiers a live attempt would have, derived deterministically, nothing real is signed.
    const seed = `paper:${intent.id}:${attemptId}:1`;
    const signedTxHash = createHash('sha256').update(seed).digest('hex') as Sha256Hex;
    const signature = encodeBase58(createHash('sha512').update(seed).digest()) as TxSignature;
    machine = must(attemptTransition(machine, { type: 'SIGNED', at: executionAt, signedTxHash, expectedTxSignature: signature, lastValidBlockHeight: executable?.quote.lastValidBlockHeight ?? null }));
    const times = { quoteExpiresAt: executable?.quote.expiresAt ?? null, signedAt: executionAt, submittedAt: null as Instant | null, confirmedAt: null as Instant | null, finalizedAt: null as Instant | null };
    await this.opts.journal({ order, attempt: this.toAttempt(attemptId, order, machine, times) });
    machine = must(attemptTransition(machine, { type: 'JOURNALED', at: executionAt }));
    machine = must(attemptTransition(machine, { type: 'SUBMITTED', at: executionAt, path: request.executionPath }));
    times.submittedAt = executionAt;

    if (outcome.kind === 'REJECT') {
      machine = must(attemptTransition(machine, { type: 'CONCLUSIVELY_DEAD', at: addMs(executionAt, p.confirmationDelayMs), blockHeightExpired: true, signatureHistoryEmpty: true, reason: outcome.detail }));
      const attempt = this.toAttempt(attemptId, order, machine, times);
      return { result: this.result(intent.id, attemptId, request.executionPath, machine.state, outcome.executableQuote, signedTxHash, signature, null, [outcome.reason]), order, attempt, fill: null, decisionQuote: decision.quote, outcome };
    }

    const confirmedSlot = (executable?.route.contextSlot ?? decision.route.contextSlot ?? 0) as Slot;
    const confirmedAt = addMs(executionAt, p.confirmationDelayMs);
    const finalizedAt = addMs(confirmedAt, p.finalizationDelayMs);
    machine = must(attemptTransition(machine, { type: 'OBSERVED', at: confirmedAt, commitment: 'confirmed', slot: confirmedSlot }));
    machine = must(attemptTransition(machine, { type: 'OBSERVED', at: finalizedAt, commitment: 'finalized', slot: (confirmedSlot + p.finalizationSlots) as Slot }));
    times.confirmedAt = confirmedAt;
    times.finalizedAt = finalizedAt;
    const attempt = this.toAttempt(attemptId, order, machine, times);
    const fill: Fill = {
      id: this.opts.newId(),
      orderAttemptId: attemptId,
      txSignature: signature,
      commitment: 'finalized',
      slot: (confirmedSlot + p.finalizationSlots) as Slot,
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      inputAmount: outcome.inputAmount,
      outputAmount: outcome.outputAmount,
      fees: outcome.fees,
      executionShortfallBps: outcome.executionShortfallBps,
      executionPath: request.executionPath,
      lotAllocations: intent.targetLotIds.map((lotId) => ({ lotId, quantity: outcome.inputAmount })),
      filledAt: finalizedAt,
    };
    const result: ExecutionResult = {
      ...this.result(intent.id, attemptId, request.executionPath, machine.state, outcome.executableQuote, signedTxHash, signature, fill.id, []),
      paper: { modeledLatencyMs: p.submissionDelayMs + p.confirmationDelayMs + p.finalizationDelayMs, adverseAllowanceBps: outcome.adverseAllowanceBps, modeledOutputAmount: outcome.outputAmount, quoteAtDecision: decision.quote },
    };
    return { result, order, attempt, fill, decisionQuote: decision.quote, outcome };
  }

  private async tryQuote(request: QuoteRequest): Promise<{ quote: Quote; route: { contextSlot: Slot | null } } | null> {
    try {
      return await this.opts.quotes.quote(request);
    } catch (err) {
      if (err instanceof Error && err.name === 'NoRouteError') return null;
      throw err;
    }
  }

  private result(intentId: Uuid, attemptId: Uuid, path: ExecutionPath, state: OrderAttemptRecord['state'], quote: Quote | null, signedTxHash: Sha256Hex | null, txSignature: TxSignature | null, fillId: Uuid | null, rejectionReasons: string[]): ExecutionResult {
    return { intentId, attemptId, state, executionPath: path, quote, simulation: null, signedTxHash, txSignature, fillId, paper: null, rejectionReasons, completedAt: this.opts.clock.now() };
  }

  private toAttempt(id: Uuid, order: Order, m: OrderAttemptRecord, t: { quoteExpiresAt: Instant | null; signedAt: Instant | null; submittedAt: Instant | null; confirmedAt: Instant | null; finalizedAt: Instant | null }): OrderAttempt {
    return {
      id,
      orderId: order.id,
      intentId: order.intentId,
      authorizationHash: null,
      attemptNumber: 1,
      state: m.state,
      jupiterRequestId: null,
      router: 'paper',
      signedTxHash: m.signedTxHash,
      walletSignature: null,
      expectedTxSignature: m.expectedTxSignature,
      blockhash: null,
      lastValidBlockHeight: m.lastValidBlockHeight,
      quoteExpiresAt: t.quoteExpiresAt,
      signedAt: t.signedAt,
      submittedAt: t.submittedAt,
      submissions: m.submissionPaths.map((path) => ({ at: t.submittedAt ?? order.createdAt, path, ok: true, providerResponseSignature: m.expectedTxSignature, error: null })),
      confirmedAt: t.confirmedAt,
      confirmedSlot: m.confirmedSlot,
      finalizedAt: t.finalizedAt,
      finalizedSlot: m.finalizedSlot,
      reorgDetectedAt: m.reorgDetectedAt,
      notLandedReason: m.notLandedReason,
      reconciliationOutcome: m.state === 'FINALIZED' ? 'PAPER_MODELLED' : null,
      createdAt: order.createdAt,
    };
  }
}

function must(r: OrderAttemptResult): OrderAttemptRecord {
  if (!r.ok) throw new Error(`paper attempt transition rejected: ${JSON.stringify(r.rejection)}`);
  return r.attempt;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 for a pseudo transaction signature; 64 bytes encode to 87–88 characters. */
export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
