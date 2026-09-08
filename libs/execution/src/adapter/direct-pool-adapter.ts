import { amountToBigInt, sha256Hex, type Amount, type Clock, type DirectPoolHop, type EmergencyRoutePolicy, type ExecutionRequest, type Fill, type Instant, type Order, type OrderAttempt, type Quote, type Sha256Hex, type SimulationReport, type Slot, type TradingWalletSigner, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { attemptTransition, newOrderAttempt, type OrderAttemptRecord, type OrderAttemptResult } from '../state/order-attempt.js';
import { decodeTransaction, encodeTransaction, toBase64 } from '../tx/codec.js';
import { checkTransactionStructure, type StructureExpectation } from '../validate/structure.js';
import type { ExecutionBounds } from '../validate/bounds.js';
import { assertSemanticDeltas } from '../simulate/deltas.js';
import type { AccountSnapshot, SimulationReader } from '../simulate/client.js';
import type { TransactionSubmitter } from '../chain/submit.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '../direct-pool/bytes.js';
import { adapterFor, buildEmergencyExit, type EmergencyBuild } from '../direct-pool/dry-run.js';
import { PoolDecodeError, type DirectPoolAdapter } from '../direct-pool/types.js';
import { COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM } from '../validate/programs.js';
import type { DetailedExecution } from './paper-adapter.js';

/**
 * Provider-independent emergency exit (blueprint §14.6 steps 4–9, D33; plan M8b). When Jupiter is
 * unavailable or unrouteable the executor rebuilds the exit itself from the persisted direct-pool
 * snapshot: fresh pool state → local quote → the swap the family's adapter encodes → the same
 * structural check, independent simulation and semantic balance-delta validation every live
 * transaction gets → sign → journal before submit → the executor's gate → direct RPC submission.
 * It can only convert a chain-held risk asset into a deployment settlement mint for at most the
 * bounded amount; there is no path here to a buy, a transfer or an exposure increase.
 */

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface DirectPoolEmergencyOptions {
  submitter: TransactionSubmitter;
  simulation: SimulationReader;
  signer: TradingWalletSigner;
  clock: Clock;
  newId: () => Uuid;
  /** Base programs every emergency shape may touch; the hop's program is added per attempt. */
  structure: Omit<StructureExpectation, 'tradingWallet' | 'allowedPrograms' | 'allowLookupTables'> & { allowedPrograms: readonly string[] };
  maxSolDebitLamports: bigint;
  policy: Pick<EmergencyRoutePolicy, 'computeUnitLimit' | 'computeUnitPriceMicroLamports'>;
  adapters?: readonly DirectPoolAdapter[];
  /** Persists the SIGNED_NOT_SUBMITTED attempt; must be durable before it resolves (D12). */
  journal: (records: { order: Order; attempt: OrderAttempt }) => Promise<void>;
  /** The executor's mode gate and caps, read immediately before submit (P3). */
  beforeSubmit: (bounds: ExecutionBounds) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  /** Polls the chain for `confirmed`; null when the signature did not confirm within the budget. */
  awaitConfirmed: (signature: TxSignature, lastValidBlockHeight: number | null) => Promise<{ slot: Slot } | null>;
  awaitFinalized: (signature: TxSignature, lastValidBlockHeight: number | null) => Promise<{ slot: Slot } | null>;
  proveDead: (signature: TxSignature, lastValidBlockHeight: number | null) => Promise<{ blockHeightExpired: boolean; signatureHistoryEmpty: boolean } | null>;
  /** Wallet token account for a mint; defaults to the associated token account. Harnesses override it. */
  tokenAccountFor?: (mint: string, tokenProgram: string) => string;
}

export interface DirectPoolEmergencyInput {
  bounds: ExecutionBounds;
  hop: DirectPoolHop;
  /** Why the primary path was not used; recorded on the attempt row. */
  fallbackFrom: string;
}

export class DirectPoolEmergencyAdapter {
  readonly kind = 'direct-pool' as const;

  constructor(private readonly opts: DirectPoolEmergencyOptions) {}

  async executeDetailed(request: ExecutionRequest, input: DirectPoolEmergencyInput): Promise<DetailedExecution> {
    const { intent } = request;
    const wallet = this.opts.signer.publicKey;
    const path = 'DIRECT_POOL_RPC' as const;
    const order: Order = { id: this.opts.newId(), intentId: intent.id, authorizationHash: null, executionPath: path, transactionClass: 'DIRECT_POOL_EMERGENCY_EXIT', createdAt: this.opts.clock.now() };
    const attemptId = this.opts.newId();
    let machine = newOrderAttempt();
    const times = { quoteExpiresAt: null as Instant | null, signedAt: null as Instant | null, submittedAt: null as Instant | null, confirmedAt: null as Instant | null, finalizedAt: null as Instant | null };
    let simulation: SimulationReport | null = null;
    let quote: Quote | null = null;
    const router = `${input.hop.program}:${input.hop.poolAddress}`;
    const reject = (reasons: string[], signedTxHash: Sha256Hex | null = null, signature: TxSignature | null = null): DetailedExecution => ({
      result: this.result(intent.id, attemptId, machine.state, quote, simulation, signedTxHash, signature, null, reasons),
      order,
      attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`, ...reasons]),
      fill: null,
      decisionQuote: null,
      outcome: null,
    });

    if (input.bounds.exposureEffect !== 'REDUCE') return reject(['EMERGENCY_NOT_RISK_REDUCING']);
    if (input.hop.inputMint !== input.bounds.inputMint || input.hop.outputMint !== input.bounds.outputMint) return reject(['ROUTE_PAIR_MISMATCH']);
    if (!adapterFor(input.hop, this.opts.adapters)) return reject(['ROUTE_UNSUPPORTED_PROGRAM']);

    // 4–5. Refresh the persisted pool state and build the transaction locally against a fresh blockhash.
    let build: EmergencyBuild;
    let blockhash: { blockhash: string; lastValidBlockHeight: number };
    try {
      blockhash = await this.opts.submitter.latestBlockhash();
      build = await buildEmergencyExit({
        hop: input.hop, user: wallet, amountIn: amountToBigInt(input.bounds.maxInputAmount), slippageBps: input.bounds.maxSlippageBps, policy: this.opts.policy, reader: this.opts.simulation, adapters: this.opts.adapters, now: this.opts.clock.now(),
        tokenAccountFor: this.opts.tokenAccountFor, recentBlockhash: blockhash.blockhash,
      });
    } catch (err) {
      if (err instanceof PoolDecodeError) return reject(['ROUTE_UNUSABLE', err.message]);
      return reject(['ROUTE_BUILD_FAILED', err instanceof Error ? err.message : String(err)]);
    }
    if (!build.state.tradeable) return reject(['ROUTE_NOT_TRADEABLE', build.state.tradeableReason ?? 'unknown']);
    const now = this.opts.clock.now();
    quote = {
      provider: 'DIRECT_POOL', providerRequestId: null, routerLabel: router,
      inputMint: input.hop.inputMint, outputMint: build.quote.outputMint, inputAmount: build.quote.inputAmount, expectedOutputAmount: build.quote.expectedOutputAmount, minOutputAmount: build.minimumAmountOut.toString() as Amount,
      priceImpactBps: build.quote.impactBps, slippageBps: input.bounds.maxSlippageBps, routeProgramIds: [input.hop.programId], usesAddressLookupTables: false, quotedAt: now, expiresAt: null, lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
    if (build.quote.impactBps > input.bounds.maxPriceImpactBps) return reject(['IMPACT_ABOVE_MAX', `impact ${build.quote.impactBps}bps > ${input.bounds.maxPriceImpactBps}bps`]);
    if (build.minimumAmountOut <= 0n) return reject(['ROUTE_EMPTY_OUTPUT']);

    // 6. Structure: only the base programs plus this hop's program, no lookup tables, no transfers.
    const txBytes = encodeTransaction([null], build.message);
    const decoded = decodeTransaction(txBytes);
    const structure = checkTransactionStructure(decoded, {
      tradingWallet: wallet,
      allowedPrograms: [...new Set([...this.opts.structure.allowedPrograms, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM, input.hop.programId])],
      allowLookupTables: false,
      allowedTransferRecipients: this.opts.structure.allowedTransferRecipients,
    });
    if (!structure.ok) return reject(structure.reasons);

    // Independent simulation with wallet-owned pre/post state over every static key.
    const keys = decoded.message.staticAccountKeys;
    const pre = await this.opts.simulation.accounts(keys);
    const sim = await this.opts.simulation.simulate(toBase64(txBytes), keys);
    const walletIndex = keys.indexOf(wallet);
    const preWallet = pre.accounts[walletIndex]?.lamports ?? 0;
    const postWallet = sim.accounts[walletIndex]?.lamports ?? null;
    const deltas = assertSemanticDeltas({
      tradingWallet: wallet,
      inputMint: input.hop.inputMint,
      outputMint: build.quote.outputMint,
      maxInputDecrease: input.bounds.maxInputAmount,
      minOutputIncrease: quote.minOutputAmount,
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
    if (!deltas.report.passed) return reject(deltas.reasons);
    const simulatedDelta = deltas.report.walletDeltas.find((d) => d.mint === build.quote.outputMint)?.delta ?? null;
    const simulatedOut = simulatedDelta !== null && BigInt(simulatedDelta) > 0n ? (BigInt(simulatedDelta).toString() as Amount) : null;

    // Sign, journal before submit, re-read the executor gate (P3).
    const messageHash = await sha256Hex(decoded.messageBytes);
    const signed = await this.opts.signer.signTransactionMessage(decoded.messageBytes, { intentId: intent.id, attemptId, messageHash });
    const signedBytes = encodeTransaction(decoded.signatures.map((s, i) => (i === 0 ? signed.signature : s)), decoded.message);
    const signedTxHash = (await sha256Hex(signedBytes)) as Sha256Hex;
    const signedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'SIGNED', at: signedAt, signedTxHash, expectedTxSignature: signed.signature, lastValidBlockHeight: blockhash.lastValidBlockHeight }));
    times.signedAt = signedAt;
    await this.opts.journal({ order, attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`]) });
    machine = must(attemptTransition(machine, { type: 'JOURNALED', at: signedAt }));
    const gate = await this.opts.beforeSubmit(input.bounds);
    if (!gate.allowed) return reject([gate.reason], signedTxHash);

    // 7. Submit over the approved direct RPC path (§14.6 step 7: never delay a mandatory risk exit).
    const submittedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'SUBMITTED', at: submittedAt, path }));
    times.submittedAt = submittedAt;
    let signature = signed.signature as TxSignature;
    try {
      signature = await this.opts.submitter.send(toBase64(signedBytes));
    } catch (err) {
      // The node may still have the transaction: only a proof of death closes the attempt (INV-23).
      const proof = await this.opts.proveDead(signature, blockhash.lastValidBlockHeight);
      if (proof) {
        const dead = attemptTransition(machine, { type: 'CONCLUSIVELY_DEAD', at: this.opts.clock.now(), blockHeightExpired: proof.blockHeightExpired, signatureHistoryEmpty: proof.signatureHistoryEmpty, reason: 'SEND_FAILED' });
        if (dead.ok) machine = dead.attempt;
      }
      return { ...reject(['SEND_FAILED', err instanceof Error ? err.message : String(err)], signedTxHash, signature), attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`, 'SEND_FAILED']) };
    }

    // 8. Observe confirmation from our own chain read; finality comes later when needed.
    const confirmed = await this.opts.awaitConfirmed(signature, blockhash.lastValidBlockHeight);
    if (!confirmed) {
      const proof = await this.opts.proveDead(signature, blockhash.lastValidBlockHeight);
      if (proof) {
        const dead = attemptTransition(machine, { type: 'CONCLUSIVELY_DEAD', at: this.opts.clock.now(), blockHeightExpired: proof.blockHeightExpired, signatureHistoryEmpty: proof.signatureHistoryEmpty, reason: 'NOT_CONFIRMED' });
        if (dead.ok) machine = dead.attempt;
        return { ...reject(['NOT_LANDED'], signedTxHash, signature), attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`, 'NOT_LANDED']) };
      }
      // SUBMITTED and unresolved: recovery decides from chain truth (§21.3).
      return { result: this.result(intent.id, attemptId, machine.state, quote, simulation, signedTxHash, signature, null, []), order, attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`]), fill: null, decisionQuote: null, outcome: null };
    }
    const confirmedAt = this.opts.clock.now();
    machine = must(attemptTransition(machine, { type: 'OBSERVED', at: confirmedAt, commitment: 'confirmed', slot: confirmed.slot }));
    times.confirmedAt = confirmedAt;
    const final = await this.opts.awaitFinalized(signature, blockhash.lastValidBlockHeight);
    let finalizedAt: Instant | null = null;
    if (final) {
      finalizedAt = this.opts.clock.now();
      machine = must(attemptTransition(machine, { type: 'OBSERVED', at: finalizedAt, commitment: 'finalized', slot: final.slot }));
      times.finalizedAt = finalizedAt;
    }
    const outputAmount = simulatedOut ?? quote.minOutputAmount;
    const expected = amountToBigInt(quote.expectedOutputAmount);
    const fill: Fill = {
      id: this.opts.newId(),
      orderAttemptId: attemptId,
      txSignature: signature,
      commitment: final ? 'finalized' : 'confirmed',
      slot: final ? final.slot : confirmed.slot,
      inputMint: input.hop.inputMint,
      outputMint: build.quote.outputMint,
      inputAmount: input.bounds.maxInputAmount,
      outputAmount,
      fees: { networkBaseUnits: '5000' as Amount, priorityBaseUnits: ((BigInt(this.opts.policy.computeUnitPriceMicroLamports) * BigInt(this.opts.policy.computeUnitLimit)) / 1_000_000n).toString() as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount },
      executionShortfallBps: expected > 0n ? Number(((expected - amountToBigInt(outputAmount)) * 10_000n) / expected) : null,
      executionPath: path,
      lotAllocations: intent.targetLotIds.map((lotId) => ({ lotId, quantity: input.bounds.maxInputAmount })),
      filledAt: finalizedAt ?? confirmedAt,
    };
    return { result: this.result(intent.id, attemptId, machine.state, quote, simulation, signedTxHash, signature, fill.id, []), order, attempt: this.toAttempt(attemptId, order, machine, times, router, [`FALLBACK_FROM:${input.fallbackFrom}`]), fill, decisionQuote: null, outcome: null };
  }

  private result(intentId: Uuid, attemptId: Uuid, state: OrderAttemptRecord['state'], quote: Quote | null, simulation: SimulationReport | null, signedTxHash: Sha256Hex | null, txSignature: TxSignature | null, fillId: Uuid | null, rejectionReasons: string[]) {
    return { intentId, attemptId, state, executionPath: 'DIRECT_POOL_RPC' as const, quote, simulation, signedTxHash, txSignature, fillId, paper: null, rejectionReasons, completedAt: this.opts.clock.now() };
  }

  private toAttempt(id: Uuid, order: Order, m: OrderAttemptRecord, t: { quoteExpiresAt: Instant | null; signedAt: Instant | null; submittedAt: Instant | null; confirmedAt: Instant | null; finalizedAt: Instant | null }, router: string, notes: string[]): OrderAttempt {
    const rejection = notes.find((n) => !n.startsWith('FALLBACK_FROM:'));
    return {
      id, orderId: order.id, intentId: order.intentId, authorizationHash: order.authorizationHash, attemptNumber: 1, state: m.state, jupiterRequestId: null, router, signedTxHash: m.signedTxHash, walletSignature: m.expectedTxSignature, expectedTxSignature: m.expectedTxSignature,
      blockhash: null, lastValidBlockHeight: m.lastValidBlockHeight, quoteExpiresAt: t.quoteExpiresAt, signedAt: t.signedAt, submittedAt: t.submittedAt,
      submissions: m.submissionPaths.map((path) => ({ at: t.submittedAt ?? order.createdAt, path, ok: true, providerResponseSignature: m.expectedTxSignature, error: null })),
      confirmedAt: t.confirmedAt, confirmedSlot: m.confirmedSlot, finalizedAt: t.finalizedAt, finalizedSlot: m.finalizedSlot, reorgDetectedAt: m.reorgDetectedAt, notLandedReason: m.notLandedReason,
      reconciliationOutcome: rejection ? `REJECTED:${rejection}` : `${notes[0] ?? 'FALLBACK'}`, createdAt: order.createdAt,
    };
  }
}

function must(r: OrderAttemptResult): OrderAttemptRecord {
  if (!r.ok) throw new Error(`direct-pool attempt transition rejected: ${JSON.stringify(r.rejection)}`);
  return r.attempt;
}
