import { amountToBigInt, instantToMs, type Amount, type Clock, type ExecutionRequest, type ExecutorGuardrails, type Fill, type IdempotencyKey, type Instant, type JsonRecord, type MintAddress, type Order, type OrderAttempt, type ProtectionMode, type RiskAuthorizedIntent, type SignedApprovalGrant, type SigningRequest, type SignatureResult, type TradeIntent, type TradingWalletSigner, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import { LiveExecutionAdapter, proveDead, type ChainObserver, type DetailedExecution, type LiveAdapterOptions } from '@sol-agent-trader/execution';
import { verifyAuthority, type AuthorityRejection } from '../authority/verify.js';
import { modeGate, type ModeFacts } from '../authority/mode-gate.js';
import { checkCaps, type CapRejection } from '../caps/check.js';
import { ExecutorExposureLedger, type ExposureEvent } from '../caps/exposure-ledger.js';
import { ExecutorJournal } from '../journal/journal.js';
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
  signer: TradingWalletSigner;
  chain: ChainObserver;
  clock: Clock;
  newId: () => Uuid;
  /** Read fresh every time; the gate is consulted at verification and again immediately before submit (P3). */
  modeFacts: () => ModeFacts;
  /** Everything the live adapter needs except the hooks this pipeline owns. */
  adapter: Omit<LiveAdapterOptions, 'signer' | 'clock' | 'newId' | 'journal' | 'beforeSubmit' | 'proveDead' | 'awaitFinalized' | 'currentBlockHeight'>;
  /** How long to wait for finality before returning CONFIRMED_PROVISIONAL to the caller. */
  awaitFinalized: (signature: string, lastValidBlockHeight: number | null) => Promise<{ slot: number } | null>;
  maxSkewMs: number;
  signerRetries?: number;
  probe?: (boundary: Boundary) => void;
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

  constructor(private readonly deps: PipelineDeps) {
    this.registry = IdempotencyRegistry.fromJournal(deps.journal.all());
    this.ledger = ExecutorExposureLedger.replay(deps.journal.all().filter((e) => e.kind === 'EXPOSURE_LEDGER_UPDATED').map((e) => e.payload as unknown as ExposureEvent));
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
      mode: this.deps.modeFacts(),
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

    const journal = this.deps.journal;
    const deps = this.deps;
    let signedAttempt: OrderAttempt | null = null;
    const adapter = new LiveExecutionAdapter({
      ...deps.adapter,
      signer: withRetry(deps.signer, deps.signerRetries ?? 2),
      clock: deps.clock,
      newId: deps.newId,
      journal: async ({ attempt }: { order: Order; attempt: OrderAttempt }) => {
        signedAttempt = attempt;
        await journal.append('ATTEMPT_SIGNED', intent.id, { intentId: intent.id, idempotencyKey: key, nonce: authorized.nonce, signedTxHash: attempt.signedTxHash, expectedTxSignature: attempt.expectedTxSignature, lastValidBlockHeight: attempt.lastValidBlockHeight, jupiterRequestId: attempt.jupiterRequestId });
        this.probe('AFTER_SIGNED_JOURNAL');
      },
      beforeSubmit: async () => {
        const gate = modeGate(deps.modeFacts(), authorized.exposureEffect);
        if (!gate.allowed) return { allowed: false, reason: `MODE_GATE_${gate.reason}` };
        await journal.append('ATTEMPT_SUBMITTED', intent.id, { intentId: intent.id, idempotencyKey: key, nonce: authorized.nonce, path: request.executionPath, expectedTxSignature: signedAttempt?.expectedTxSignature ?? null, signedTxHash: signedAttempt?.signedTxHash ?? null, lastValidBlockHeight: signedAttempt?.lastValidBlockHeight ?? null });
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

    const execution = await adapter.executeDetailed(request);
    this.probe('AFTER_RESPONSE');
    await this.record(intent.id, key, execution.attempt.state, execution.fill, execution.result.txSignature, execution.result.rejectionReasons, authorized);
    return { outcome: 'EXECUTED', execution };
  }

  private async record(intentId: Uuid, key: IdempotencyKey, state: OrderAttempt['state'], fill: Fill | null, signature: string | null, reasons: string[], authorized: RiskAuthorizedIntent): Promise<void> {
    const at = this.deps.clock.now();
    if (state === 'FINALIZED') {
      await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: (fill?.inputAmount ?? authorized.maxInputAmount) as Amount });
      this.registry.advance(key, 'COMPLETED');
      await this.deps.journal.append('ATTEMPT_RESULT', intentId, { intentId, idempotencyKey: key, state, lifecycle: 'COMPLETED', txSignature: signature, fillId: fill?.id ?? null, inputAmount: fill?.inputAmount ?? null, outputAmount: fill?.outputAmount ?? null });
      return;
    }
    if (state === 'CONFIRMED_PROVISIONAL') {
      // Exposure is real once confirmed; the lifecycle stays EXECUTING until finality (INV-22).
      await this.ledgerEvent(intentId, { kind: 'ENTRY_CONFIRMED', at, intentId, costBasis: authorized.maxInputAmount });
      return;
    }
    if (state === 'SUBMITTED') return; // unresolved on purpose: recovery decides from chain truth
    // PREPARED (refused pre-submit) or NOT_LANDED (proven dead): nothing is open.
    await this.ledgerEvent(intentId, { kind: 'ENTRY_RELEASED', at, intentId, reason: reasons[0] ?? state });
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

  /** Total open non-settlement exposure the ledger holds (for the harness and health surfaces). */
  openExposure(): bigint {
    return amountToBigInt(this.ledger.aggregateNonSettlementExposure());
  }
}

