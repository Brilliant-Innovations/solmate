import type { Instant, OperatorPasskey, StepUpChallenge, Uuid, WebAuthnTransport } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';
import type { PendingControlRequest } from './session-repo.js';

/**
 * Step-up storage (ADR-0006, §5.7, D41). The worker is the only writer: challenges are consumed
 * and assertions recorded through ops.consume_step_up_challenge() so a challenge can never be
 * used twice, passkeys are inserted only after the SimpleWebAuthn verifier accepted the
 * attestation, and revocation is a dated flag, never a delete. The browser reads its own rows
 * under RLS and writes nothing here.
 */

interface ChallengeRow {
  id: string;
  user_id: string;
  kind: StepUpChallenge['kind'];
  binding_hash: string;
  challenge: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_cose: string;
  sign_count: string | number;
  transports: string[];
  aaguid: string | null;
  backed_up: boolean;
  label: string;
  created_at: string;
  usable_from: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const iso = (s: string): Instant => new Date(s).toISOString() as Instant;

function toChallenge(r: ChallengeRow): StepUpChallenge {
  return { id: r.id as Uuid, userId: r.user_id as Uuid, kind: r.kind, bindingHash: r.binding_hash as StepUpChallenge['bindingHash'], challenge: r.challenge, issuedAt: iso(r.issued_at), expiresAt: iso(r.expires_at), consumedAt: r.consumed_at ? iso(r.consumed_at) : null };
}

function toPasskey(r: PasskeyRow): OperatorPasskey {
  return {
    id: r.id as Uuid,
    userId: r.user_id as Uuid,
    credentialId: r.credential_id,
    publicKeyCose: r.public_key_cose,
    signCount: Number(r.sign_count),
    transports: (r.transports ?? []) as WebAuthnTransport[],
    aaguid: r.aaguid,
    backedUp: r.backed_up,
    label: r.label,
    createdAt: iso(r.created_at),
    usableFrom: iso(r.usable_from),
    lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
    revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
  };
}

export async function loadStepUpChallenge(sql: Sql, id: Uuid): Promise<StepUpChallenge | null> {
  const [r] = await sql<ChallengeRow[]>`select id, user_id, kind, binding_hash, challenge, issued_at, expires_at, consumed_at from ops.step_up_challenges where id = ${id}`;
  return r ? toChallenge(r) : null;
}

export async function loadPasskeyByCredentialId(sql: Sql, credentialId: string): Promise<OperatorPasskey | null> {
  const [r] = await sql<PasskeyRow[]>`select * from ops.operator_passkeys where credential_id = ${credentialId}`;
  return r ? toPasskey(r) : null;
}

export async function loadPasskey(sql: Sql, id: Uuid): Promise<OperatorPasskey | null> {
  const [r] = await sql<PasskeyRow[]>`select * from ops.operator_passkeys where id = ${id}`;
  return r ? toPasskey(r) : null;
}

/** Non-revoked passkeys of an operator; cooling ones count (they exist, they just cannot authorise REQUIRED kinds yet). */
export async function activePasskeyCount(sql: Sql, userId: Uuid): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ops.operator_passkeys where user_id = ${userId} and revoked_at is null`;
  return r?.n ?? 0;
}

/** True when a verified or failed assertion already exists for this challenge (it was consumed). */
export async function challengeConsumed(sql: Sql, challengeId: Uuid): Promise<boolean> {
  const [r] = await sql<{ consumed: boolean }[]>`select consumed_at is not null as consumed from ops.step_up_challenges where id = ${challengeId}`;
  return r?.consumed ?? true;
}

export type ConsumeOutcome = { ok: true; assertionId: Uuid; expiresAt: Instant } | { ok: false; reason: 'CHALLENGE_UNAVAILABLE' };

/** Atomic consume + assertion record (review R2-04); a second caller gets CHALLENGE_UNAVAILABLE. */
export async function consumeStepUpChallenge(sql: Sql, input: { challengeId: Uuid; passkeyId: Uuid | null; verified: boolean; failureReason: string | null; controlRequestId: Uuid | null }): Promise<ConsumeOutcome> {
  try {
    const [a] = await sql<{ id: string; expires_at: string }[]>`
      select id, expires_at from ops.consume_step_up_challenge(${input.challengeId}, ${input.passkeyId}, ${input.verified}, ${input.failureReason}, ${input.controlRequestId})`;
    if (!a) return { ok: false, reason: 'CHALLENGE_UNAVAILABLE' };
    return { ok: true, assertionId: a.id as Uuid, expiresAt: iso(a.expires_at) };
  } catch (err) {
    if (err instanceof Error && /CHALLENGE_UNAVAILABLE/.test(err.message)) return { ok: false, reason: 'CHALLENGE_UNAVAILABLE' };
    throw err;
  }
}

export async function recordPasskeyUse(sql: Sql, passkeyId: Uuid, newSignCount: number, at: Instant): Promise<void> {
  await sql`update ops.operator_passkeys set sign_count = greatest(sign_count, ${newSignCount}), last_used_at = ${at} where id = ${passkeyId}`;
}

export interface NewPasskey {
  userId: Uuid;
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  transports: WebAuthnTransport[];
  aaguid: string | null;
  backedUp: boolean;
  label: string;
  usableFrom: Instant;
}

/** Inserts a verified passkey; the database trigger raises the CRITICAL OPERATOR_PASSKEY_REGISTERED alert. Duplicate credential ids surface as DUPLICATE. */
export async function insertPasskey(sql: Sql, p: NewPasskey): Promise<{ ok: true; id: Uuid } | { ok: false; reason: 'DUPLICATE_CREDENTIAL' }> {
  try {
    const [r] = await sql<{ id: string }[]>`
      insert into ops.operator_passkeys (user_id, credential_id, public_key_cose, sign_count, transports, aaguid, backed_up, label, usable_from)
      values (${p.userId}, ${p.credentialId}, ${p.publicKeyCose}, ${p.signCount}, ${p.transports}, ${p.aaguid}, ${p.backedUp}, ${p.label}, ${p.usableFrom})
      returning id`;
    return { ok: true, id: r!.id as Uuid };
  } catch (err) {
    if (err instanceof Error && /23505|duplicate key/.test(err.message)) return { ok: false, reason: 'DUPLICATE_CREDENTIAL' };
    throw err;
  }
}

/** Revokes one of the operator's own passkeys; returns false when it is not theirs or already revoked. */
export async function revokePasskey(sql: Sql, id: Uuid, userId: Uuid, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`update ops.operator_passkeys set revoked_at = ${at} where id = ${id} and user_id = ${userId} and revoked_at is null returning id`;
  return rows.length > 0;
}

/** One pending request by id, for the owning roles' lazy step-up check. */
export async function loadPendingControlRequest(sql: Sql, id: Uuid): Promise<PendingControlRequest | null> {
  const [r] = await sql<{ id: string; requested_by: string; kind: PendingControlRequest['kind']; payload: Record<string, unknown>; created_at: string }[]>`
    select id, requested_by, kind, payload, created_at from ops.control_requests where id = ${id} and state = 'PENDING'`;
  return r ? { id: r.id as Uuid, requestedBy: r.requested_by as Uuid, kind: r.kind, payload: r.payload, createdAt: iso(r.created_at) } : null;
}
