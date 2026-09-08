import { ControlRequestKind, PasskeyRegistrationEvidence, StepUpEvidence, stepUpRequired, type Clock, type Instant, type OperatorPasskey, type StepUpChallenge, type Uuid } from '@sol-agent-trader/contracts';
import type { ConsumeOutcome, NewPasskey, PendingControlRequest } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { verifyPasskeyRegistration, verifyStepUp, type ControlRequestUnderReview, type RegistrationVerdict, type RelyingParty, type StepUpVerdict } from '../step-up/verify.js';

/**
 * Worker role `operator-security` (blueprint §5.7, §20.26, D41; ADR-0006 and its amendment).
 * Three jobs, all deterministic and fail-closed:
 *
 * 1. Verify the passkey assertion (`payload.stepUp`) carried by any pending control request and
 *    record the verdict by consuming the challenge atomically (ops.consume_step_up_challenge), so
 *    the owning role's `stepUpVerifiedFor(requestId)` check has a fact to read. The same function
 *    is called lazily by those roles before they decide, which removes the ordering race.
 * 2. REGISTER_PASSKEY: a first passkey needs only the fresh-TOTP challenge the database issued;
 *    every later one needs an assertion from an existing passkey over the same challenge. A
 *    verified attestation becomes an ops.operator_passkeys row (the database trigger raises the
 *    CRITICAL alert); a first passkey enters its cooling period.
 * 3. REVOKE_PASSKEY: REQUIRED step-up, then a dated revocation of the operator's own passkey.
 *
 * The browser never writes passkeys, challenges or assertions; it files evidence in a request.
 */

export interface OperatorSecurityRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  loadPendingRequest(id: Uuid): Promise<PendingControlRequest | null>;
  loadChallenge(id: Uuid): Promise<StepUpChallenge | null>;
  loadPasskeyByCredentialId(credentialId: string): Promise<OperatorPasskey | null>;
  activePasskeys(userId: Uuid): Promise<number>;
  consume(input: { challengeId: Uuid; passkeyId: Uuid | null; verified: boolean; failureReason: string | null; controlRequestId: Uuid | null }): Promise<ConsumeOutcome>;
  recordUse(passkeyId: Uuid, newSignCount: number, at: Instant): Promise<void>;
  insertPasskey(p: NewPasskey): Promise<{ ok: true; id: Uuid } | { ok: false; reason: 'DUPLICATE_CREDENTIAL' }>;
  revokePasskey(id: Uuid, userId: Uuid, at: Instant): Promise<boolean>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
  raise?(n: { id: Uuid; severity: 'HIGH'; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant }): Promise<void>;
}

/** The WebAuthn verifiers, injectable so the orchestration is unit-testable without real authenticators. */
export interface StepUpVerifiers {
  stepUp: typeof verifyStepUp;
  registration: typeof verifyPasskeyRegistration;
}

export interface OperatorSecurityDeps {
  repo: OperatorSecurityRepo;
  rp: RelyingParty;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number };
  verifiers?: StepUpVerifiers;
  newId?: () => Uuid;
}

export interface OperatorSecurityReport {
  verified: number;
  verificationFailed: number;
  registered: number;
  revoked: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

export type StepUpOutcome =
  | { status: 'NO_EVIDENCE' }
  | { status: 'ALREADY_RECORDED' }
  | { status: 'VERIFIED'; passkeyId: Uuid }
  | { status: 'FAILED'; reason: string; detail?: string };

const SELF_KINDS: ControlRequestKind[] = ['REGISTER_PASSKEY', 'REVOKE_PASSKEY'];

/**
 * Verifies `payload.stepUp` of one pending request exactly once. Idempotent: a challenge that is
 * already consumed reports ALREADY_RECORDED and the assertion row stands. A request without
 * evidence is left to its owning role, which rejects REQUIRED kinds as STEP_UP_REQUIRED.
 */
export async function verifyRequestStepUp(deps: OperatorSecurityDeps, req: PendingControlRequest): Promise<StepUpOutcome> {
  const verifiers = deps.verifiers ?? { stepUp: verifyStepUp, registration: verifyPasskeyRegistration };
  const parsed = StepUpEvidence.safeParse(req.payload['stepUp']);
  if (!parsed.success) return { status: 'NO_EVIDENCE' };
  const evidence = parsed.data;
  const now = deps.clock.now();
  const challenge = await deps.repo.loadChallenge(evidence.challengeId);
  if (!challenge) return { status: 'FAILED', reason: 'UNKNOWN_CHALLENGE' };
  if (challenge.consumedAt !== null) return { status: 'ALREADY_RECORDED' };
  const passkey = await deps.repo.loadPasskeyByCredentialId(evidence.credentialId);
  const request: ControlRequestUnderReview = { requestedBy: req.requestedBy, kind: req.kind, payload: req.payload };
  const verdict: StepUpVerdict = await verifiers.stepUp({ request, evidence, challenge, passkey, now, rp: deps.rp });
  const consumed = await deps.repo.consume({
    challengeId: challenge.id,
    passkeyId: passkey?.id ?? null,
    verified: verdict.verified,
    failureReason: verdict.verified ? null : `${verdict.reason}${verdict.detail ? `: ${verdict.detail.slice(0, 200)}` : ''}`,
    controlRequestId: req.id,
  });
  if (!consumed.ok) return { status: 'FAILED', reason: 'CHALLENGE_UNAVAILABLE' };
  if (!verdict.verified) {
    deps.logger.warn('step_up_failed', { requestId: req.id, kind: req.kind, by: req.requestedBy, reason: verdict.reason, detail: verdict.detail ?? null });
    return { status: 'FAILED', reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}) };
  }
  await deps.repo.recordUse(verdict.passkeyId, verdict.newSignCount, now);
  deps.logger.info('step_up_verified', { requestId: req.id, kind: req.kind, by: req.requestedBy, passkeyId: verdict.passkeyId, assertionId: consumed.assertionId });
  return { status: 'VERIFIED', passkeyId: verdict.passkeyId };
}

/** For the owning roles: make sure any evidence on this request has been judged before they read `stepUpVerifiedFor`. */
export async function ensureStepUpJudged(deps: OperatorSecurityDeps, requestId: Uuid): Promise<StepUpOutcome> {
  const req = await deps.repo.loadPendingRequest(requestId);
  if (!req) return { status: 'NO_EVIDENCE' };
  return verifyRequestStepUp(deps, req);
}

export async function runOperatorSecurityCycle(deps: OperatorSecurityDeps): Promise<OperatorSecurityReport> {
  const report: OperatorSecurityReport = { verified: 0, verificationFailed: 0, registered: 0, revoked: 0, refused: {}, errors: [] };
  const now = deps.clock.now();
  const pending = await deps.repo.listPending(ControlRequestKind.options as unknown as ControlRequestKind[], deps.config.batchSize);

  // 1. Evidence on every other kind: judge it so the owning role can act on a recorded fact.
  for (const req of pending) {
    if (SELF_KINDS.includes(req.kind)) continue;
    if (req.payload['stepUp'] === undefined) continue;
    try {
      const outcome = await verifyRequestStepUp(deps, req);
      if (outcome.status === 'VERIFIED') report.verified++;
      else if (outcome.status === 'FAILED') report.verificationFailed++;
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2 & 3. Passkey lifecycle requests.
  for (const req of pending) {
    if (!SELF_KINDS.includes(req.kind)) continue;
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('operator_security_refused', { requestId: req.id, kind: req.kind, reason, by: req.requestedBy, ...extra });
    };
    try {
      const role = await deps.repo.operatorRole(req.requestedBy);
      if (role !== 'operator' && role !== 'admin') {
        await refuse('NOT_AN_OPERATOR', { role });
        continue;
      }
      if (req.kind === 'REGISTER_PASSKEY') {
        const r = await registerPasskey(deps, req, now);
        if (r.ok) {
          report.registered++;
          await deps.repo.resolve(req.id, 'ACCEPTED', { passkeyId: r.passkeyId, usableFrom: r.usableFrom, label: r.label }, now);
          deps.logger.info('passkey_registered', { requestId: req.id, by: req.requestedBy, passkeyId: r.passkeyId, usableFrom: r.usableFrom, first: r.first });
        } else {
          await refuse(r.reason, r.detail ? { detail: r.detail } : {});
        }
        continue;
      }
      // REVOKE_PASSKEY
      const passkeyId = req.payload['passkeyId'];
      if (typeof passkeyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(passkeyId)) {
        await refuse('MALFORMED_PAYLOAD');
        continue;
      }
      if (stepUpRequired(req.kind, req.payload)) {
        const outcome = await verifyRequestStepUp(deps, req);
        if (outcome.status === 'NO_EVIDENCE') {
          await refuse('STEP_UP_REQUIRED');
          continue;
        }
        if (outcome.status === 'FAILED') {
          await refuse(outcome.reason, outcome.detail ? { detail: outcome.detail } : {});
          continue;
        }
      }
      const done = await deps.repo.revokePasskey(passkeyId as Uuid, req.requestedBy, now);
      if (!done) {
        await refuse('NOT_OWN_PASSKEY');
        continue;
      }
      report.revoked++;
      await deps.repo.resolve(req.id, 'ACCEPTED', { passkeyId }, now);
      deps.logger.info('passkey_revoked', { requestId: req.id, by: req.requestedBy, passkeyId });
      if (deps.repo.raise) {
        await deps.repo.raise({
          id: deps.newId?.() ?? (crypto.randomUUID() as Uuid),
          severity: 'HIGH',
          alertClass: 'OPERATOR_PASSKEY_REVOKED',
          summary: `Passkey ${passkeyId.slice(0, 8)} revoked by operator ${req.requestedBy.slice(0, 8)}`,
          affected: { system: `operator-security:${req.requestedBy}`, passkeyId },
          automatedResponse: null,
          raisedAt: now,
        });
      }
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
      deps.logger.error('operator_security_failed', { requestId: req.id, kind: req.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

type RegisterResult = { ok: true; passkeyId: Uuid; usableFrom: Instant; label: string; first: boolean } | { ok: false; reason: string; detail?: string };

async function registerPasskey(deps: OperatorSecurityDeps, req: PendingControlRequest, now: Instant): Promise<RegisterResult> {
  const verifiers = deps.verifiers ?? { stepUp: verifyStepUp, registration: verifyPasskeyRegistration };
  const label = req.payload['label'];
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 64) return { ok: false, reason: 'MALFORMED_PAYLOAD', detail: 'label must be 1..64 characters' };
  const parsed = PasskeyRegistrationEvidence.safeParse(req.payload['registration']);
  if (!parsed.success) return { ok: false, reason: 'MALFORMED_REGISTRATION', detail: parsed.error.issues.map((i) => i.path.join('.') || i.message).slice(0, 3).join(', ') };
  const registration = parsed.data;
  const challenge = await deps.repo.loadChallenge(registration.challengeId);
  if (!challenge) return { ok: false, reason: 'UNKNOWN_CHALLENGE' };
  if (challenge.consumedAt !== null) return { ok: false, reason: 'CHALLENGE_CONSUMED' };
  const activePasskeys = await deps.repo.activePasskeys(req.requestedBy);
  const request: ControlRequestUnderReview = { requestedBy: req.requestedBy, kind: req.kind, payload: req.payload };

  // A further passkey must be authorised by an existing one, over this same challenge (R2-01).
  let existing: StepUpVerdict | null = null;
  let existingPasskey: OperatorPasskey | null = null;
  if (activePasskeys > 0) {
    const ev = StepUpEvidence.safeParse(req.payload['stepUp']);
    if (!ev.success) {
      await deps.repo.consume({ challengeId: challenge.id, passkeyId: null, verified: false, failureReason: 'STEP_UP_REQUIRED', controlRequestId: req.id });
      return { ok: false, reason: 'STEP_UP_REQUIRED' };
    }
    if (ev.data.challengeId !== challenge.id) return { ok: false, reason: 'CHALLENGE_MISMATCH', detail: 'stepUp and registration must use the same challenge' };
    existingPasskey = await deps.repo.loadPasskeyByCredentialId(ev.data.credentialId);
    existing = await verifiers.stepUp({ request, evidence: ev.data, challenge, passkey: existingPasskey, now, rp: deps.rp });
  }

  const verdict: RegistrationVerdict = await verifiers.registration({ request, response: registration.response, challenge, activePasskeys, existingPasskeyVerdict: existing, now, rp: deps.rp });
  const consumed = await deps.repo.consume({
    challengeId: challenge.id,
    passkeyId: existing?.verified ? existing.passkeyId : null,
    verified: verdict.verified,
    failureReason: verdict.verified ? null : `${verdict.reason}${verdict.detail ? `: ${verdict.detail.slice(0, 200)}` : ''}`,
    controlRequestId: req.id,
  });
  if (!consumed.ok) return { ok: false, reason: 'CHALLENGE_UNAVAILABLE' };
  if (!verdict.verified) return { ok: false, reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}) };
  if (existing?.verified) await deps.repo.recordUse(existing.passkeyId, existing.newSignCount, now);

  const inserted = await deps.repo.insertPasskey({
    userId: req.requestedBy,
    credentialId: verdict.credential.credentialId,
    publicKeyCose: verdict.credential.publicKeyCose,
    signCount: verdict.credential.signCount,
    transports: verdict.credential.transports,
    aaguid: verdict.credential.aaguid,
    backedUp: verdict.credential.backedUp,
    label: label.trim(),
    usableFrom: verdict.credential.usableFrom,
  });
  if (!inserted.ok) return { ok: false, reason: inserted.reason };
  return { ok: true, passkeyId: inserted.id, usableFrom: verdict.credential.usableFrom, label: label.trim(), first: activePasskeys === 0 };
}
