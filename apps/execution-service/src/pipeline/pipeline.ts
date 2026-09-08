import { amountToBigInt, instantToMs, mulDiv, type Amount, type PositionRiskShadow, type Slot, type TxSignature, type Bps, type Clock, type EmergencyCommand, type EmergencyIssuer, type ExecutionRequest, type ExecutorGuardrails, type Fill, type IdempotencyKey, type Instant, type JsonRecord, type MintAddress, type Order, type OrderAttempt, type ProtectionMode, type RiskAuthorizedIntent, type SignedApprovalGrant, type SignedEmergencyCommand, type SigningRequest, type SignatureResult, type TradeIntent, type TradingWalletSigner, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import { LiveExecutionAdapter, attemptTransition, newOrderAttempt, planEmergencyClose, proveDead, proveDeadAcrossViews, quorumVerdict, readSignature, type OrderAttemptRecord, type QuorumObserver, type ChainObserver, type CustodyReader, type DetailedExecution, type EmergencyCloseAction, type EmergencyClosePolicy, type EmergencyPlanRejection, type ExecutionBounds, type LiveAdapterOptions } from '@sol-agent-trader/execution';
import { verifyEmergencyCommand, type EmergencyCommandRejection } from '../emergency/command.js';
import { verifyAuthority, type AuthorityRejection } from '../authority/verify.js';
import { modeGate, type ModeFacts } from '../authority/mode-gate.js';
import { checkCaps, type CapRejection } from '../caps/check.js';
import { ExecutorExposureLedger, type ExposureEvent } from '../caps/exposure-ledger.js';
import { ExecutorJournal } from '../journal/journal.js';
import { DirectPoolEmergencyAdapter, type DirectPoolAdapter, type TransactionSubmitter } from '@sol-agent-trader/execution';
import type { DirectPoolHop, EmergencyRoutePolicy, ExecutionPath, MintAddress as _MintAddressAlias } from '@sol-agent-trader/contracts';
import { IdempotencyRegistry } from '../idempotency/intents.js';

/**
 * The executor's submission pipeline (§15.3–15.4, §15.10, §21.3; D12, D21; ADR-0009 P3/P4):
 *
 *   verify authority (pinned key, hash, expiry, nonce, stored row, approval, mode gate)
 *   → claim the idempotency key and journal ATTEMPT_PREPARED
 *   → deployment caps against the local exposure ledger
 *   → live adapter (order, validation, simulation, deltas, recheck)
 *       · journal ATTEMPT_SIGNED before anything leaves the process
 *       · re-read the mode gate, then journal ATTEMPT_SUBMITTED, immediately before /execute
 *   → journal ATTEMPT_RESULT and the exposure ledger event
 *
 * A crash anywhere leaves a journal from which `recover()` finishes the attempt from chain
 * truth: landed → result; provably dead → NOT_LANDED and exposure released; still landable →
 * left unresolved, and a redelivery of the same key stays a duplicate (INV-04, INV-23).
 *
 * The harness injects crashes through `probe`; production leaves it undefined.
 */

export type Boundary = 'AFTER_PREPARED' | 'AFTER_SIGNED_JOURNAL' | 'AFTER_SUBMITTED_JOURNAL' | 'AFTER_RESPONSE';

export class CrashSignal extends Error {
  constructor(readonly boundary: Boundary) {
    super(`simulated crash at ${boundary}`);
    this.name = 'CrashSignal';
  }
}

export class SignerTimeout extends Error {
  constructor() {
    super('signer timed out');
    this.name = 'SignerTimeout';
  }
}

export interface PipelineDeps {
  journal: ExecutorJournal;
  guardrails: ExecutorGuardrails;
  authorizerKeys: readonly VerificationKey[];
  approverKeys: readonly VerificationKey[];
  emergencyOperatorKeys: readonly VerificationKey[];
  custody: CustodyReader;
  /** Deployment-local emergency policy (D22): settlement preference, protective slippage, validity. */
  emergency: Omit<EmergencyClosePolicy, 'hardMaxProtectiveSlippageBps' | 'maxTxBaseUnits' | 'settlementMints'> & { settlementMints?: readonly MintAddress[] };
  signer: TradingWalletSigner;
  chain: ChainObserver;
  clock: Clock;
  newId: () => Uuid;
  /** Read fresh every time; the gate is consulted at verification and again immediately before submit (P3). */
  modeFacts: () => ModeFacts | Promise<ModeFacts>;
  /** Everything the live adapter needs except the hooks this pipeline owns. */
  adapter: Omit<LiveAdapterOptions, 'signer' | 'clock' | 'newId' | 'journal' | 'beforeSubmit' | 'proveDead' | 'awaitFinalized' | 'currentBlockHeight'>;
  /** How long to wait for finality before returning CONFIRMED_PROVISIONAL to the caller. */
  awaitFinalized: (signature: string, lastValidBlockHeight: number | null) => Promise<{ slot: number } | null>;
  maxSkewMs: number;
  signerRetries?: number;
  probe?: (boundary: Boundary) => void;
  /** Additional independent RPC views for staged finality (§14.7); the primary `chain` is always the first view. */
  secondaryChains?: readonly QuorumObserver[];
  /** A missing view this far past the transaction's slot contradicts a landed view (chain-health policy). Default 64. */
  signatureGraceSlots?: number;
  /** Best-effort database reconciliation of a tracked finality change; the journal already holds the truth. */
  persistFinality?: (u: FinalityPersist) => Promise<void>;
  /**
   * Provider-independent emergency exit (§14.6, D33): when Jupiter is unavailable or unrouteable
   * before submission, the executor rebuilds the close from the persisted direct-pool route.
   */
  directPool?: DirectPoolFallback;
}

export interface DirectPoolFallback {
  submitter: TransactionSubmitter;
  /** Latest persisted route for a held mint (database read, with whatever cache the deployment keeps); null when none. */
  routes: (mint: MintAddress) => Promise<DirectPoolHop | null>;
  policy: Pick<EmergencyRoutePolicy, 'computeUnitLimit' | 'computeUnitPriceMicroLamports'>;
  adapters?: readonly DirectPoolAdapter[];
  /** Polls the chain for confirmation of a directly submitted transaction. */
  awaitConfirmed: (signature: string, lastValidBlockHeight: number | null) => Promise<{ slot: number } | null>;
  tokenAccountFor?: (mint: string, tokenProgram: string) => string;
}

/** Primary-path outcomes that mean "the provider could not be used", never "the provider may have landed something". */
const PRIMARY_UNAVAILABLE = /^(NO_ROUTE|TRANSACTION_UNDECODABLE|PROVIDER_|EXECUTE_FAILED_5|VERSION_UNSUPPORTED|UNEXPECTED_SIGNER|FEE_PAYER_MISMATCH|PROGRAM_)/;

export interface FinalityPersist {
  intentId: Uuid;
  signature: string;
  state: 'CONFIRMED_PROVISIONAL' | 'FINALIZED' | 'REORG_PENDING' | 'NOT_LANDED';
  slot: number | null;
  at: Instant;
  reason: string | null;
}

export interface FinalityUpdate {
  intentId: Uuid;
  signature: string;
  from: 'SUBMITTED' | 'CONFIRMED_PROVISIONAL' | 'REORG_PENDING';
  to: 'SUBMITTED' | 'CONFIRMED_PROVISIONAL' | 'REORG_PENDING' | 'FINALIZED' | 'NOT_LANDED';
  verdict: string;
  slot: number | null;
  views: number;
  note?: string;
}

export interface SubmitInput {
  request: ExecutionRequest;
  storedIntent: TradeIntent | null;
  approval: SignedApprovalGrant | null;
  protectionMode: ProtectionMode;
}

export type SubmitOutcome =
  | { outcome: 'DENIED'; stage: 'AUTHORITY' | 'CAPS'; reasons: (AuthorityRejection | CapRejection)[]; detail: string[] }
  | { outcome: 'DUPLICATE'; intentId: Uuid; state: string }
  | { outcome: 'EXECUTED'; execution: DetailedExecution };

export interface EmergencyActionOutcome {
  mint: MintAddress;
  amount: Amount;
  heldAmount: Amount;
  state: OrderAttempt['state'] | 'SKIPPED';
  txSignature: string | null;
  reasons: string[];
  executionPath?: ExecutionPath;
  fallbackFrom?: string | null;
}

export type EmergencyInput =
  | { signed: SignedEmergencyCommand }
  /** From the authenticated internal API: the position monitor acting on chain truth plus the shadow during a DB outage. */
  | { monitor: { commandId: Uuid; type: EmergencyCommand['type']; mint: MintAddress | null; maxAmount: Amount | null; reason: string; shadowSequence: number | null } };

export type EmergencyOutcome =
  | { outcome: 'REJECTED'; reasons: (EmergencyCommandRejection | EmergencyPlanRejection | 'SHADOW_STALE')[]; detail: string[] }
  | { outcome: 'PAUSED'; commandId: Uuid }
  | { outcome: 'CLOSED'; commandId: Uuid; actions: EmergencyActionOutcome[]; skipped: { mint: MintAddress; reason: string }[] };

export interface Recovery {
  correlationId: string;
  resolution: 'LANDED_FINALIZED' | 'LANDED_CONFIRMED_PENDING' | 'NOT_LANDED' | 'STILL_LANDABLE' | 'EXPIRED_UNSIGNED';
  signature: string | null;
}

/** Retries a timed-out signer with the identical canonical bytes; a deterministic backend returns the identical signature. */
function withRetry(signer: TradingWalletSigner, attempts: number): TradingWalletSigner {
  return {
    backend: signer.backend,
    publicKey: signer.publicKey,
    health: () => signer.health(),
    async signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult> {
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await signer.signTransactionMessage(messageBytes, request);
        } catch (err) {
          if (!(err instanceof SignerTimeout)) throw err;
          last = err;
        }
      }
      throw last instanceof Error ? last : new SignerTimeout();
    },
  };
}

export class ExecutorPipeline {
  readonly registry: IdempotencyRegistry;
  readonly ledger: ExecutorExposureLedger;
  /** The executor's own pause (D25 plane 1, §15.10): survives restarts through the journal; cleared only by an operator command. */
  localPause: { active: boolean; reason: string | null };

  constructor(private readonly deps: PipelineDeps) {
    const entries = deps.journal.all();
    this.registry = IdempotencyRegistry.fromJournal(entries);
    this.ledger = ExecutorExposureLedger.replay(entries.filter((e) => e.kind === 'EXPOSURE_LEDGER_UPDATED').map((e) => e.payload as unknown as ExposureEvent));
    const lastPause = [...entries].reverse().find((e) => e.kind === 'PAUSE_APPLIED' || e.kind === 'PAUSE_CLEARED');
    this.localPause = lastPause?.kind === 'PAUSE_APPLIED' ? { active: true, reason: (lastPause.payload['reason'] as string | undefined) ?? null } : { active: false, reason: null };
  }

  private async facts(): Promise<ModeFacts> {
    const f = await this.deps.modeFacts();
    return { ...f, localPause: f.localPause || this.localPause.active };
  }

  async applyLocalPause(reason: string): Promise<void> {
    if (this.localPause.active) return;
    this.localPause = { active: true, reason };
    await this.deps.journal.append('PAUSE_APPLIED', 'ops', { reason, at: this.deps.clock.now() });
  }

  /** Only the reconciliation/operator path clears a local pause after review (§15.10). */
  async clearLocalPause(by: string): Promise<void> {
    if (!this.localPause.active) return;
    this.localPause = { active: false, reason: null };
    await this.deps.journal.append('PAUSE_CLEARED', 'ops', { by, at: this.deps.clock.now() });
  }

  private lastShadowSequence(): number | null {
    const e = [...this.deps.journal.all()].reverse().find((x) => x.kind === 'SHADOW_SYNCED');
    const s = e?.payload['sequence'];
    return typeof s === 'number' ? s : null;
  }

  get journal(): ExecutorJournal {
    return this.deps.journal;
  }

  private probe(b: Boundary): void {
    this.deps.probe?.(b);
  }

  private async ledgerEvent(correlationId: string, event: ExposureEvent): Promise<void> {
    this.ledger.apply(event);
    await this.deps.journal.append('EXPOSURE_LEDGER_UPDATED', correlationId, event as unknown as JsonRecord);
  }

  async submit(input: SubmitInput): Promise<SubmitOutcome> {
    const { request } = input;
    const now = this.deps.clock.now();
    if (!request.authorization) return { outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['AUTHORIZATION_MALFORMED'], detail: ['no envelope'] };
    const authority = await verifyAuthority({
      envelope: request.authorization,
      keys: this.deps.authorizerKeys,
      acceptedKeyIds: this.deps.guardrails.acceptedRiskAuthorizerKeyIds,
      storedIntent: input.storedIntent,
      approval: input.approval ? { grant: input.approval, keys: this.deps.approverKeys } : null,
      usedNonces: this.deps.journal.usedNonces(),
      mode: await this.facts(),
      now,
      maxSkewMs: this.deps.maxSkewMs,
    });
    const intent = request.intent;
    const key = intent.idempotencyKey as IdempotencyKey;
    if (!authority.ok) {
      // The same envelope delivered again fails only on its own nonce: report the attempt it already has (INV-04), never a second one.
      const held = this.registry.peek(key);
      if (authority.reasons.every((r) => r === 'NONCE_REPLAYED') && held && held.intentId === intent.id) return { outcome: 'DUPLICATE', intentId: held.intentId, state: held.state };
      return { outcome: 'DENIED', stage: 'AUTHORITY', reasons: authority.reasons, detail: authority.detail };
    }
    const authorized: RiskAuthorizedIntent = authority.payload;

    const claim = this.registry.claim(intent.id, key);
    if (claim.outcome === 'DUPLICATE') return { outcome: 'DUPLICATE', intentId: claim.intentId, state: claim.state };
    await this.deps.journal.append('ATTEMPT_PREPARED', intent.id, { intentId: intent.id, idempotencyKey: key, nonce: authorized.nonce, authorizationHash: authority.authorizationHash, mint: authorized.outputMint, maxInputAmount: authorized.maxInputAmount, expiresAt: authorized.expiresAt });
    this.probe('AFTER_PREPARED');

    const caps = checkCaps({ guardrails: this.deps.guardrails, ledger: this.ledger, intent: authorized, protectionMode: input.protectionMode, markToMarketExposure: null });
    if (!caps.ok) {
      this.registry.advance(key, 'FAILED');
      await this.deps.journal.append('ATTEMPT_RESULT', intent.id, { intentId: intent.id, idempotencyKey: key, state: 'PREPARED', lifecycle: 'FAILED', reasons: caps.reasons });
      return { outcome: 'DENIED', stage: 'CAPS', reasons: caps.reasons, detail: caps.detail };
    }
    await this.ledgerEvent(intent.id, { kind: 'ENTRY_AUTHORIZED', at: now, intentId: intent.id, mint: authorized.outputMint as MintAddress, notional: authorized.maxInputAmount, protectionMode: input.protectionMode });
    this.registry.advance(key, 'AUTHORIZED');

    const adapter = this.adapterFor(intent.id, key, authorized.nonce, request.executionPath, null);

    const execution = await adapter.executeDetailed(request);
    this.probe('AFTER_RESPONSE');
    await this.record(intent.id, key, execution.attempt.state, execution.fill, execution.result.txSignature, execution.result.rejectionReasons, authorized);
    return { outcome: 'EXECUTED', execution };
  }

  private adapterFor(intentId: Uuid, key: IdempotencyKey, nonce: string, path: ExecutionRequest['executionPath'], emergencyCommandId: Uuid | null): LiveExecutionAdapter {
    const journal = this.deps.journal;
    const deps = this.deps;
    let signedAttempt: OrderAttempt | null = null;
    const extra = emergencyCommandId ? { emergency: true, commandId: emergencyCommandId } : {};
    return new LiveExecutionAdapter({
      ...deps.adapter,
      signer: withRetry(deps.signer, deps.signerRetries ?? 2),
      clock: deps.clock,
      newId: deps.newId,
      journal: async ({ attempt }: { order: Order; attempt: OrderAttempt }) => {
        signedAttempt = attempt;
        await journal.append('ATTEMPT_SIGNED', intentId, { intentId, idempotencyKey: key, nonce, signedTxHash: attempt.signedTxHash, expectedTxSignature: attempt.expectedTxSignature, lastValidBlockHeight: attempt.lastValidBlockHeight, jupiterRequestId: attempt.jupiterRequestId, ...extra });
        this.probe('AFTER_SIGNED_JOURNAL');
      },
      beforeSubmit: async (bounds) => {
        const gate = modeGate(await this.facts(), bounds.exposureEffect);
        if (!gate.allowed) return { allowed: false, reason: `MODE_GATE_${gate.reason}` };
        await journal.append('ATTEMPT_SUBMITTED', intentId, { intentId, idempotencyKey: key, nonce, path, expectedTxSignature: signedAttempt?.expectedTxSignature ?? null, signedTxHash: signedAttempt?.signedTxHash ?? null, lastValidBlockHeight: signedAttempt?.lastValidBlockHeight ?? null, ...extra });
        this.registry.advance(key, 'EXECUTING');
        this.probe('AFTER_SUBMITTED_JOURNAL');
        return { allowed: true };
      },
      proveDead: (signature, lastValidBlockHeight) => proveDead(deps.chain, signature, lastValidBlockHeight),
      awaitFinalized: async (signature, lastValidBlockHeight) => {
        const r = await deps.awaitFinalized(signature, lastValidBlockHeight);
        return r ? { slot: r.slot as never } : null;
      },
      currentBlockHeight: () => deps.chain.blockHeight(),
    });
  }

  /**
   * D22 / §15.10: a verified out-of-band command or an authenticated monitor request. Works with no
   * database: custody from chain, bounds from the deployment policy, everything journaled. Any
   * close action applies the local pause so entries cannot resume before operator review.
   */
  async emergency(input: EmergencyInput): Promise<EmergencyOutcome> {
    const now = this.deps.clock.now();
    let cmd: { commandId: Uuid; type: EmergencyCommand['type']; mint: MintAddress | null; maxAmount: Amount | null; issuer: EmergencyIssuer; reason: string; nonce: string; shadowSequence: number | null };
    if ('signed' in input) {
      const v = await verifyEmergencyCommand({ envelope: input.signed, keys: this.deps.emergencyOperatorKeys, acceptedKeyIds: this.deps.guardrails.acceptedEmergencyOperatorKeyIds, cluster: this.deps.guardrails.cluster, usedNonces: this.deps.journal.usedNonces(), now, maxSkewMs: this.deps.maxSkewMs });
      if (!v.ok) {
        await this.deps.journal.append('EMERGENCY_COMMAND_REJECTED', input.signed.payloadHash, { reasons: v.reasons, detail: v.detail, keyId: input.signed.keyId });
        return { outcome: 'REJECTED', reasons: v.reasons, detail: v.detail };
      }
      cmd = { commandId: v.command.commandId, type: v.command.type, mint: v.command.mint, maxAmount: v.command.maxAmount, issuer: v.command.issuer, reason: v.command.reason, nonce: v.command.nonce, shadowSequence: null };
    } else {
      const m = input.monitor;
      const last = this.lastShadowSequence();
      if (m.shadowSequence !== null && last !== null && m.shadowSequence < last) {
        await this.deps.journal.append('EMERGENCY_COMMAND_REJECTED', m.commandId, { reasons: ['SHADOW_STALE'], shadowSequence: m.shadowSequence, lastSynced: last });
        return { outcome: 'REJECTED', reasons: ['SHADOW_STALE'], detail: [`shadow ${m.shadowSequence} older than synced ${last}`] };
      }
      cmd = { commandId: m.commandId, type: m.type, mint: m.mint, maxAmount: m.maxAmount, issuer: 'POSITION_MONITOR', reason: m.reason, nonce: `monitor:${m.commandId}`, shadowSequence: m.shadowSequence };
    }
    await this.deps.journal.append('EMERGENCY_COMMAND_RECEIVED', cmd.commandId, { commandId: cmd.commandId, type: cmd.type, mint: cmd.mint, maxAmount: cmd.maxAmount, issuer: cmd.issuer, reason: cmd.reason, nonce: cmd.nonce, shadowSequence: cmd.shadowSequence });

    if (cmd.type === 'PAUSE_NEW_ENTRIES') {
      await this.applyLocalPause(`EMERGENCY_COMMAND:${cmd.commandId}`);
      return { outcome: 'PAUSED', commandId: cmd.commandId };
    }

    const g = this.deps.guardrails;
    const custody = await this.deps.custody.holdings(g.tradingWalletAddress);
    const policy: EmergencyClosePolicy = { ...this.deps.emergency, settlementMints: this.deps.emergency.settlementMints ?? g.allowedSettlementMints, hardMaxProtectiveSlippageBps: g.hardMaxProtectiveSlippageBps, maxTxBaseUnits: g.maxEmergencyCloseTxBaseUnits === null ? null : BigInt(g.maxEmergencyCloseTxBaseUnits) };
    const plan = planEmergencyClose({ type: cmd.type, mint: cmd.mint, maxAmount: cmd.maxAmount }, custody.holdings, policy, now);
    if (!plan.ok) {
      await this.deps.journal.append('EMERGENCY_COMMAND_REJECTED', cmd.commandId, { reasons: plan.reasons, custodySlot: custody.slot });
      return { outcome: 'REJECTED', reasons: plan.reasons, detail: [`custody slot ${custody.slot}`] };
    }
    const actions: EmergencyActionOutcome[] = [];
    for (const a of plan.actions) actions.push(await this.emergencyAction(cmd, a));
    await this.applyLocalPause(`EMERGENCY_ACTION:${cmd.commandId}`);
    return { outcome: 'CLOSED', commandId: cmd.commandId, actions, skipped: plan.skipped };
  }

  private async emergencyAction(cmd: { commandId: Uuid; nonce: string; reason: string }, a: EmergencyCloseAction): Promise<EmergencyActionOutcome> {
    const intentId = this.deps.newId();
    const key = `emergency:${cmd.commandId}:${a.mint}` as IdempotencyKey;
    const claim = this.registry.claim(intentId, key);
    if (claim.outcome === 'DUPLICATE') return { mint: a.mint, amount: a.amount, heldAmount: a.heldAmount, state: 'SKIPPED', txSignature: null, reasons: ['DUPLICATE_COMMAND'] };
    await this.deps.journal.append('ATTEMPT_PREPARED', intentId, { intentId, idempotencyKey: key, nonce: cmd.nonce, emergency: true, commandId: cmd.commandId, mint: a.mint, maxInputAmount: a.amount, heldAmount: a.heldAmount, outputMint: a.outputMint, expiresAt: a.bounds.expiresAt });
    this.registry.advance(key, 'AUTHORIZED');
    const intent: TradeIntent = {
      id: intentId, idempotencyKey: key, accountId: cmd.commandId, strategyVersionId: 'EMERGENCY_CLOSE@1' as TradeIntent['strategyVersionId'], sleeveId: null, assetId: cmd.commandId, action: 'EMERGENCY_CLOSE', side: 'SELL', exposureEffect: 'REDUCE',
      inputMint: a.mint, outputMint: a.outputMint, maxInputAmount: a.amount, riskEvaluationId: cmd.commandId, actionCycleId: cmd.commandId, clearedCutoffVersion: 1,
      constraints: { maxSlippageBps: a.bounds.maxSlippageBps, maxPriceImpactBps: a.bounds.maxPriceImpactBps, chaseToleranceBps: 0 as Bps, maxQuoteAgeMs: a.bounds.maxQuoteAgeMs }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: this.deps.clock.now(), expiresAt: a.bounds.expiresAt,
    };
    const request: ExecutionRequest = { intent, capitalAuthority: 'LIVE_AUTO', authorization: null, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: this.deps.clock.now() };
    const adapter = this.adapterFor(intentId, key, cmd.nonce, 'JUPITER_ORDER', cmd.commandId);
    let execution: DetailedExecution;
    let primaryFailure: string | null = null;
    try {
      execution = await adapter.executeDetailed(request, { bounds: a.bounds });
      const first = execution.result.rejectionReasons[0] ?? null;
      // Only a refusal before anything was signed counts as "provider unavailable"; a signed attempt is recovery's business.
      if (execution.attempt.state === 'PREPARED' && first !== null && PRIMARY_UNAVAILABLE.test(first)) primaryFailure = first;
    } catch (err) {
      // The provider threw before a signature existed (order/quote endpoint down): nothing can have landed.
      if (this.registry.state(key) !== 'AUTHORIZED') throw err;
      primaryFailure = `PROVIDER_ERROR:${err instanceof Error ? err.message : String(err)}`.slice(0, 160);
      execution = null as unknown as DetailedExecution;
    }
    if (primaryFailure !== null && this.deps.directPool) {
      const fallback = await this.directPoolFallback(cmd, a, intent, request, key, primaryFailure);
      if (fallback) execution = fallback;
    }
    if (!execution) throw new Error(`emergency close of ${a.mint}: primary path failed (${primaryFailure}) and no direct-pool route is available`);
    await this.record(intentId, key, execution.attempt.state, execution.fill, execution.result.txSignature, execution.result.rejectionReasons, a.bounds, { mint: a.mint, heldAmount: a.heldAmount });
    return { mint: a.mint, amount: a.amount, heldAmount: a.heldAmount, state: execution.attempt.state, txSignature: execution.result.txSignature, reasons: execution.result.rejectionReasons, executionPath: execution.result.executionPath, fallbackFrom: execution.result.executionPath === 'DIRECT_POOL_RPC' ? primaryFailure : null };
  }

  /** §14.6 steps 4–9: the persisted direct-pool route, refreshed and rebuilt locally, submitted over the approved RPC path. */
  private async directPoolFallback(cmd: { commandId: Uuid; nonce: string; reason: string }, a: EmergencyCloseAction, intent: TradeIntent, request: ExecutionRequest, key: IdempotencyKey, primaryFailure: string): Promise<DetailedExecution | null> {
    const dp = this.deps.directPool!;
    let hop: DirectPoolHop | null = null;
    try {
      hop = await dp.routes(a.mint);
    } catch (err) {
      await this.deps.journal.append('EMERGENCY_COMMAND_REJECTED', cmd.commandId, { reasons: ['DIRECT_POOL_ROUTE_UNAVAILABLE'], mint: a.mint, primaryFailure, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (!hop || hop.inputMint !== a.mint || hop.outputMint !== a.outputMint) {
      await this.deps.journal.append('EMERGENCY_COMMAND_REJECTED', cmd.commandId, { reasons: ['DIRECT_POOL_ROUTE_MISSING'], mint: a.mint, primaryFailure, hop });
      return null;
    }
    const intentId = intent.id;
    await this.deps.journal.append('ATTEMPT_PREPARED', intentId, { intentId, idempotencyKey: key, nonce: cmd.nonce, emergency: true, commandId: cmd.commandId, mint: a.mint, maxInputAmount: a.amount, executionPath: 'DIRECT_POOL_RPC', fallbackFrom: primaryFailure, hop, expiresAt: a.bounds.expiresAt });
    const journal = this.deps.journal;
    const deps = this.deps;
    let signedAttempt: OrderAttempt | null = null;
    const adapter = new DirectPoolEmergencyAdapter({
      submitter: dp.submitter,
      simulation: deps.adapter.simulation,
      signer: withRetry(deps.signer, deps.signerRetries ?? 2),
      clock: deps.clock,
      newId: deps.newId,
      structure: { allowedPrograms: deps.adapter.structure.allowedPrograms, allowedTransferRecipients: deps.adapter.structure.allowedTransferRecipients },
      maxSolDebitLamports: deps.adapter.maxSolDebitLamports,
      policy: dp.policy,
      adapters: dp.adapters,
      tokenAccountFor: dp.tokenAccountFor,
      journal: async ({ attempt }) => {
        signedAttempt = attempt;
        await journal.append('ATTEMPT_SIGNED', intentId, { intentId, idempotencyKey: key, nonce: cmd.nonce, signedTxHash: attempt.signedTxHash, expectedTxSignature: attempt.expectedTxSignature, lastValidBlockHeight: attempt.lastValidBlockHeight, executionPath: 'DIRECT_POOL_RPC', hop });
        this.probe('AFTER_SIGNED_JOURNAL');
      },
      beforeSubmit: async (bounds) => {
        const gate = modeGate(await this.facts(), bounds.exposureEffect);
        if (!gate.allowed) return { allowed: false, reason: `MODE_GATE_${gate.reason}` };
        await journal.append('ATTEMPT_SUBMITTED', intentId, { intentId, idempotencyKey: key, nonce: cmd.nonce, path: 'DIRECT_POOL_RPC', expectedTxSignature: signedAttempt?.expectedTxSignature ?? null, signedTxHash: signedAttempt?.signedTxHash ?? null });
        if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
        this.probe('AFTER_SUBMITTED_JOURNAL');
        return { allowed: true };
      },
      awaitConfirmed: async (signature, lastValidBlockHeight) => {
        const r = await dp.awaitConfirmed(signature, lastValidBlockHeight);
        return r ? { slot: r.slot as never } : null;
      },
      awaitFinalized: async (signature, lastValidBlockHeight) => {
        const r = await deps.awaitFinalized(signature, lastValidBlockHeight);
        return r ? { slot: r.slot as never } : null;
      },
      proveDead: (signature, lastValidBlockHeight) => proveDead(deps.chain, signature, lastValidBlockHeight),
    });
    return adapter.executeDetailed({ ...request, executionPath: 'DIRECT_POOL_RPC' }, { bounds: a.bounds, hop, fallbackFrom: primaryFailure });
  }

  private async record(intentId: Uuid, key: IdempotencyKey, state: OrderAttempt['state'], fill: Fill | null, signature: string | null, reasons: string[], authorized: ExecutionBounds, exit?: { mint: MintAddress; heldAmount: Amount }): Promise<void> {
    const at = this.deps.clock.now();
    if (state === 'FINALIZED') {
      if (exit) {
        // Emergency exit: release the open entries of that mint in proportion to what was sold against chain-held quantity.
        const sold = (fill?.inputAmount ?? authorized.maxInputAmount) as Amount;
        for (const o of this.ledger.openByMint(exit.mint)) {
          const released = amountToBigInt(exit.heldAmount) > 0n ? mulDiv(o.exposure, amountToBigInt(sold), amountToBigInt(exit.heldAmount), 'FLOOR') : o.exposure;
          await this.ledgerEvent(o.intentId, { kind: 'EXIT_CONFIRMED', at, intentId: o.intentId, costReleased: released });
        }
      } else await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: (fill?.inputAmount ?? authorized.maxInputAmount) as Amount });
      this.registry.advance(key, 'COMPLETED');
      await this.deps.journal.append('ATTEMPT_RESULT', intentId, { intentId, idempotencyKey: key, state, lifecycle: 'COMPLETED', txSignature: signature, fillId: fill?.id ?? null, inputAmount: fill?.inputAmount ?? null, outputAmount: fill?.outputAmount ?? null });
      return;
    }
    if (state === 'CONFIRMED_PROVISIONAL') {
      // Exposure is real once confirmed; the lifecycle stays EXECUTING until finality (INV-22). The observation is journaled so the finality tracker knows what was seen.
      if (!exit) await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: fill?.inputAmount ?? authorized.maxInputAmount });
      await this.deps.journal.append('ATTEMPT_OBSERVED', intentId, { intentId, idempotencyKey: key, commitment: 'confirmed', slot: fill?.slot ?? null, txSignature: signature, from: 'SUBMITTED', provisionalFillId: fill?.id ?? null });
      return;
    }
    if (state === 'SUBMITTED') return; // unresolved on purpose: recovery decides from chain truth
    // PREPARED (refused pre-submit) or NOT_LANDED (proven dead): nothing is open.
    if (!exit) await this.ledgerEvent(intentId, { kind: 'ENTRY_RELEASED', at, intentId, reason: reasons[0] ?? state });
    this.registry.advance(key, 'FAILED');
    await this.deps.journal.append('ATTEMPT_RESULT', intentId, { intentId, idempotencyKey: key, state, lifecycle: 'FAILED', reasons, txSignature: signature });
  }

  /** Restart: resolve every signed or submitted attempt from chain truth before any new work (§21.3). */
  async recover(): Promise<Recovery[]> {
    const out: Recovery[] = [];
    // Prepared but never signed (crash between the claim and the signature): release once the authorization has expired.
    const now = instantToMs(this.deps.clock.now());
    const seen = new Map<string, { signed: boolean; done: boolean; expiresAt: string | null; key: string | null }>();
    for (const e of this.deps.journal.all()) {
      if (e.kind === 'ATTEMPT_PREPARED') seen.set(e.correlationId, { signed: false, done: false, expiresAt: (e.payload['expiresAt'] as string | null | undefined) ?? null, key: (e.payload['idempotencyKey'] as string | undefined) ?? null });
      const s = seen.get(e.correlationId);
      if (!s) continue;
      if (e.kind === 'ATTEMPT_SIGNED' || e.kind === 'ATTEMPT_SUBMITTED') s.signed = true;
      if (e.kind === 'ATTEMPT_RESULT') s.done = true;
    }
    for (const [correlationId, s] of seen) {
      if (s.signed || s.done || !s.expiresAt || !s.key || now < instantToMs(s.expiresAt as Instant)) continue;
      const intentId = correlationId as Uuid;
      if (this.ledger.openIntents().includes(intentId)) await this.ledgerEvent(correlationId, { kind: 'ENTRY_RELEASED', at: this.deps.clock.now(), intentId, reason: 'EXPIRED_UNSIGNED' });
      this.registry.advance(s.key as IdempotencyKey, 'EXPIRED');
      await this.deps.journal.append('ATTEMPT_RESULT', correlationId, { intentId, idempotencyKey: s.key, state: 'PREPARED', lifecycle: 'EXPIRED', recovered: true, reason: 'EXPIRED_UNSIGNED' });
      out.push({ correlationId, resolution: 'EXPIRED_UNSIGNED', signature: null });
    }
    for (const u of this.deps.journal.unresolvedAttempts()) {
      const signed = [...this.deps.journal.all()].reverse().find((e) => e.correlationId === u.correlationId && e.kind === 'ATTEMPT_SIGNED');
      const key = (signed?.payload['idempotencyKey'] as IdempotencyKey | undefined) ?? null;
      const lastValid = (signed?.payload['lastValidBlockHeight'] as number | null | undefined) ?? null;
      const signature = u.expectedTxSignature ?? ((signed?.payload['expectedTxSignature'] as string | null | undefined) ?? null);
      const intentId = u.correlationId as Uuid;
      if (!signature || !key) {
        out.push({ correlationId: u.correlationId, resolution: 'STILL_LANDABLE', signature });
        continue;
      }
      const status = await this.deps.chain.signatureStatus(signature);
      if (status && status.err === null && status.confirmationStatus === 'finalized') {
        const prepared = this.deps.journal.all().find((e) => e.correlationId === u.correlationId && e.kind === 'ATTEMPT_PREPARED');
        const notional = (prepared?.payload['maxInputAmount'] as Amount | undefined) ?? ('0' as Amount);
        if (this.ledger.openIntents().includes(intentId)) await this.ledgerEvent(u.correlationId, { kind: 'ENTRY_CONFIRMED', at: this.deps.clock.now(), intentId, costBasis: notional });
        if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
        this.registry.advance(key, 'COMPLETED');
        await this.deps.journal.append('ATTEMPT_RESULT', u.correlationId, { intentId, idempotencyKey: key, state: 'FINALIZED', lifecycle: 'COMPLETED', txSignature: signature, recovered: true });
        out.push({ correlationId: u.correlationId, resolution: 'LANDED_FINALIZED', signature });
        continue;
      }
      if (status && status.err === null) {
        out.push({ correlationId: u.correlationId, resolution: 'LANDED_CONFIRMED_PENDING', signature });
        continue;
      }
      const dead = status && status.err !== null ? { blockHeightExpired: false, signatureHistoryEmpty: false } : await proveDead(this.deps.chain, signature, lastValid);
      if (dead) {
        await this.ledgerEvent(u.correlationId, { kind: 'ENTRY_RELEASED', at: this.deps.clock.now(), intentId, reason: status ? 'TX_FAILED_ON_CHAIN' : 'BLOCK_HEIGHT_EXPIRED' });
        if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
        this.registry.advance(key, 'FAILED');
        await this.deps.journal.append('ATTEMPT_RESULT', u.correlationId, { intentId, idempotencyKey: key, state: 'NOT_LANDED', lifecycle: 'FAILED', txSignature: signature, recovered: true, reason: status ? 'TX_FAILED_ON_CHAIN' : 'BLOCK_HEIGHT_EXPIRED' });
        out.push({ correlationId: u.correlationId, resolution: 'NOT_LANDED', signature });
        continue;
      }
      out.push({ correlationId: u.correlationId, resolution: 'STILL_LANDABLE', signature });
    }
    return out;
  }

  /**
   * Staged finality over independent RPC views (§14.7, §40.3, D49; INV-22, INV-23; §24.4). Runs
   * between submissions and after restart recovery for every attempt the journal still holds
   * open: a consistent `finalized` promotes accounting; a confirmed transaction that goes
   * missing or that the views contradict enters REORG_PENDING and pauses new entries locally; a
   * REORG_PENDING or SUBMITTED transaction becomes NOT_LANDED only when every answering view
   * proves it dead. The pause this tracker applied is released only once nothing is uncertain
   * and wallet custody was re-read from chain.
   */
  async trackFinality(): Promise<FinalityUpdate[]> {
    const out: FinalityUpdate[] = [];
    const observers: QuorumObserver[] = [this.deps.chain, ...(this.deps.secondaryChains ?? [])];
    const grace = this.deps.signatureGraceSlots ?? 64;
    const all = this.deps.journal.all();
    let uncertain = 0;
    for (const u of this.deps.journal.unresolvedAttempts()) {
      const mine = all.filter((e) => e.correlationId === u.correlationId);
      const signed = [...mine].reverse().find((e) => e.kind === 'ATTEMPT_SIGNED');
      const prepared = mine.find((e) => e.kind === 'ATTEMPT_PREPARED');
      const key = ((signed?.payload['idempotencyKey'] as IdempotencyKey | undefined) ?? null);
      const signature = u.expectedTxSignature ?? ((signed?.payload['expectedTxSignature'] as string | null | undefined) ?? null);
      if (!signature || !key) continue;
      const lastValid = (signed?.payload['lastValidBlockHeight'] as number | null | undefined) ?? null;
      const observedEntry = [...mine].reverse().find((e) => e.kind === 'ATTEMPT_OBSERVED' || e.kind === 'ATTEMPT_REORG_PENDING');
      const prior: 'SUBMITTED' | 'CONFIRMED_PROVISIONAL' | 'REORG_PENDING' = observedEntry?.kind === 'ATTEMPT_REORG_PENDING' ? 'REORG_PENDING' : observedEntry ? 'CONFIRMED_PROVISIONAL' : 'SUBMITTED';
      const priorSlot = (observedEntry?.payload['slot'] as number | undefined) ?? null;
      const intentId = u.correlationId as Uuid;
      const emergency = prepared?.payload['emergency'] === true;
      const notional = (prepared?.payload['maxInputAmount'] as Amount | undefined) ?? ('0' as Amount);
      const readings = await readSignature(observers, signature);
      const q = quorumVerdict(readings, grace);
      const at = this.deps.clock.now();
      const machine: OrderAttemptRecord = { ...newOrderAttempt(), state: prior, journaled: true, expectedTxSignature: signature as TxSignature, lastValidBlockHeight: lastValid, confirmedSlot: priorSlot as Slot | null };
      const summary = readings.map((r) => ({ label: r.label, kind: r.kind, ...(r.kind === 'LANDED' || r.kind === 'FAILED' ? { slot: r.status.slot, commitment: r.status.confirmationStatus } : r.kind === 'MISSING' ? { headSlot: r.headSlot } : { error: r.error }) }));
      const update = (to: FinalityUpdate['to'], extra: Partial<FinalityUpdate> = {}): FinalityUpdate => ({ intentId, signature, from: prior, to, verdict: q.verdict, slot: q.slot, views: q.answered, ...extra });
      switch (q.verdict) {
        case 'FINALIZED': {
          const t = attemptTransition(machine, { type: 'OBSERVED', at, commitment: 'finalized', slot: q.slot as Slot });
          if (!t.ok) break;
          if (emergency) {
            const mint = prepared?.payload['mint'] as MintAddress | undefined;
            const held = (prepared?.payload['heldAmount'] as Amount | undefined) ?? notional;
            if (mint) for (const o of this.ledger.openByMint(mint)) {
              const released = amountToBigInt(held) > 0n ? mulDiv(o.exposure, amountToBigInt(notional), amountToBigInt(held), 'FLOOR') : o.exposure;
              await this.ledgerEvent(o.intentId, { kind: 'EXIT_CONFIRMED', at, intentId: o.intentId, costReleased: released });
            }
          } else if (this.ledger.openIntents().includes(intentId)) await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: notional });
          if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
          if (this.registry.state(key) === 'EXECUTING') this.registry.advance(key, 'COMPLETED');
          await this.deps.journal.append('ATTEMPT_RESULT', intentId, { intentId, idempotencyKey: key, state: 'FINALIZED', lifecycle: 'COMPLETED', txSignature: signature, finalizedSlot: q.slot, tracked: true, from: prior, views: summary });
          await this.persistFinality({ intentId, signature, state: 'FINALIZED', slot: q.slot, at, reason: null });
          out.push(update('FINALIZED'));
          break;
        }
        case 'PROCESSED':
          if (prior === 'REORG_PENDING') uncertain++; // telemetry only (D49): nothing changes until confirmed again
          break;
        case 'CONFIRMED': {
          if (prior === 'CONFIRMED_PROVISIONAL') break;
          const t = attemptTransition(machine, { type: 'OBSERVED', at, commitment: 'confirmed', slot: q.slot as Slot });
          if (!t.ok) break;
          if (!emergency && this.ledger.openIntents().includes(intentId)) await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: notional });
          if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
          await this.deps.journal.append('ATTEMPT_OBSERVED', intentId, { intentId, idempotencyKey: key, commitment: 'confirmed', slot: q.slot, txSignature: signature, from: prior, views: summary });
          await this.persistFinality({ intentId, signature, state: 'CONFIRMED_PROVISIONAL', slot: q.slot, at, reason: null });
          out.push(update('CONFIRMED_PROVISIONAL'));
          break;
        }
        case 'MISSING':
        case 'FAILED':
        case 'DIVERGENT': {
          if (prior === 'CONFIRMED_PROVISIONAL') {
            const t = attemptTransition(machine, { type: 'MISSING_OR_CONFLICTING', at });
            if (!t.ok || t.attempt.state !== 'REORG_PENDING') break;
            await this.deps.journal.append('ATTEMPT_REORG_PENDING', intentId, { intentId, idempotencyKey: key, txSignature: signature, verdict: q.verdict, views: summary, at });
            await this.applyLocalPause(`REORG_PENDING:${signature}`);
            await this.persistFinality({ intentId, signature, state: 'REORG_PENDING', slot: null, at, reason: q.verdict });
            uncertain++;
            out.push(update('REORG_PENDING'));
            break;
          }
          if (q.verdict === 'DIVERGENT') {
            await this.applyLocalPause(`RPC_DIVERGENCE:${signature}`);
            uncertain++;
            out.push(update(prior, { note: 'views contradict; no state change' }));
            break;
          }
          // SUBMITTED or REORG_PENDING: a failed transaction is consumed on chain; a missing one is dead only when every view proves it (INV-23).
          let reason: string;
          if (q.verdict === 'FAILED') reason = 'TX_FAILED_ON_CHAIN';
          else {
            const dead = await proveDeadAcrossViews(observers, signature, lastValid);
            if (!dead) {
              if (prior === 'REORG_PENDING') uncertain++;
              out.push(update(prior, { note: 'still potentially landable' }));
              break;
            }
            const t = attemptTransition(machine, { type: 'CONCLUSIVELY_DEAD', at, ...dead, reason: 'BLOCK_HEIGHT_EXPIRED' });
            if (!t.ok) break;
            reason = 'BLOCK_HEIGHT_EXPIRED';
          }
          if (!emergency && this.ledger.openIntents().includes(intentId)) await this.ledgerEvent(intentId, { kind: 'ENTRY_RELEASED', at, intentId, reason });
          if (this.registry.state(key) === 'AUTHORIZED') this.registry.advance(key, 'EXECUTING');
          if (this.registry.state(key) === 'EXECUTING') this.registry.advance(key, 'FAILED');
          await this.deps.journal.append('ATTEMPT_RESULT', intentId, { intentId, idempotencyKey: key, state: 'NOT_LANDED', lifecycle: 'FAILED', txSignature: signature, reason, tracked: true, from: prior, views: summary });
          await this.persistFinality({ intentId, signature, state: 'NOT_LANDED', slot: null, at, reason });
          out.push(update('NOT_LANDED', { note: reason }));
          break;
        }
        case 'UNAVAILABLE':
          if (prior === 'REORG_PENDING') uncertain++;
          out.push(update(prior, { note: 'no RPC view answered' }));
          break;
      }
    }
    const reason = this.localPause.reason ?? '';
    if (this.localPause.active && uncertain === 0 && (reason.startsWith('REORG_PENDING:') || reason.startsWith('RPC_DIVERGENCE:'))) {
      // §14.7: reconcile final chain balances before releasing the pause. A failed read keeps it.
      try {
        const h = await this.deps.custody.holdings(this.deps.guardrails.tradingWalletAddress);
        await this.deps.journal.append('CUSTODY_RECONCILED', 'ops', { slot: h.slot, holdings: h.holdings.map((x) => ({ mint: x.mint, amount: x.amount.toString() })), releasing: reason, at: this.deps.clock.now() });
        await this.clearLocalPause('finality-tracker:custody-reconciled');
      } catch {
        // stays paused until the next tick can read custody
      }
    }
    return out;
  }

  private async persistFinality(u: FinalityPersist): Promise<void> {
    if (!this.deps.persistFinality) return;
    try {
      await this.deps.persistFinality(u);
    } catch {
      // best effort after the journal holds the truth (§15.10); the row is reconciled later
    }
  }

  /**
   * §15.10A: the worker's sequenced position shadow, journaled here so DB-down protection can rest on a
   * durable local copy. Sequences never regress; a stale or replayed shadow is refused, never merged.
   */
  async syncShadow(shadow: PositionRiskShadow): Promise<{ ok: true; sequence: number } | { ok: false; reason: 'SHADOW_REGRESSION'; lastSynced: number }> {
    const last = this.lastShadowSequence();
    if (last !== null && shadow.sequence <= last) return { ok: false, reason: 'SHADOW_REGRESSION', lastSynced: last };
    await this.deps.journal.append('SHADOW_SYNCED', `shadow:${shadow.sequence}`, { sequence: shadow.sequence, asOf: shadow.asOf, positions: shadow.positions.length, shadow: shadow as unknown as JsonRecord });
    return { ok: true, sequence: shadow.sequence };
  }

  /** Total open non-settlement exposure the ledger holds (for the harness and health surfaces). */
  openExposure(): bigint {
    return amountToBigInt(this.ledger.aggregateNonSettlementExposure());
  }
}

