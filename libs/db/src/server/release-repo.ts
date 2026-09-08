import { toInstant, type CapitalAttestation, type Instant, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Release lifecycle persistence (blueprint §12.4, §15.9, D56; execution plan M7). Status moves are
 * written by the worker after the pure lifecycle accepted the event; attestations and capital
 * ceilings are append-only rows the risk-authorizer and the projector read back.
 */

const iso = (v: unknown): Instant => toInstant(new Date(v as string));

export async function loadRelease(sql: Sql, id: Uuid): Promise<Release | null> {
  const [r] = await sql<Record<string, unknown>[]>`select id, digest, binding, status, created_at, promoted_at, retired_at from research.releases where id = ${id}`;
  if (!r) return null;
  return { id: r['id'] as Uuid, digest: r['digest'] as Sha256Hex, binding: r['binding'] as Release['binding'], status: r['status'] as Release['status'], createdAt: iso(r['created_at']), promotedAt: r['promoted_at'] ? iso(r['promoted_at']) : null, retiredAt: r['retired_at'] ? iso(r['retired_at']) : null };
}

export async function listReleases(sql: Sql, limit = 50): Promise<Release[]> {
  const rows = await sql<Record<string, unknown>[]>`select id, digest, binding, status, created_at, promoted_at, retired_at from research.releases order by created_at desc limit ${limit}`;
  return rows.map((r) => ({ id: r['id'] as Uuid, digest: r['digest'] as Sha256Hex, binding: r['binding'] as Release['binding'], status: r['status'] as Release['status'], createdAt: iso(r['created_at']), promotedAt: r['promoted_at'] ? iso(r['promoted_at']) : null, retiredAt: r['retired_at'] ? iso(r['retired_at']) : null }));
}

/** Writes the status the lifecycle produced; refuses to move a row whose status is no longer what the lifecycle saw. */
export async function applyReleaseStatus(sql: Sql, from: Release, to: Release): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update research.releases set status = ${to.status}, promoted_at = ${to.promotedAt}, retired_at = ${to.retiredAt}
    where id = ${from.id} and status = ${from.status} returning id`;
  return rows.length > 0;
}

export async function insertAttestation(sql: Sql, a: ReleaseAttestation): Promise<void> {
  await sql`
    insert into research.release_attestations (id, release_id, release_digest, purpose, operator_id, operator_role, credential_id, credential_fingerprint, challenge, verification_result, attested_at, expires_at)
    values (${a.id}, ${a.releaseId}, ${a.releaseDigest}, ${a.purpose}, ${a.operatorId}, ${a.operatorRole}, ${a.credentialId}, ${a.credentialFingerprint}, ${a.challenge}, ${a.verificationResult}, ${a.attestedAt}, ${a.expiresAt})`;
}

export async function insertCapitalAttestation(sql: Sql, c: CapitalAttestation): Promise<void> {
  await sql`
    insert into ops.capital_attestations (id, account_id, release_id, attestation_id, ceiling_usd, recognized_usd_at_attestation, attested_by, attested_at)
    values (${c.id}, ${c.accountId}, ${c.releaseId}, ${c.attestationId}, ${c.ceilingUsd}, ${c.recognizedUsdAtAttestation}, ${c.attestedBy}, ${c.attestedAt})`;
}

export async function latestCapitalAttestation(sql: Sql, accountId: Uuid): Promise<CapitalAttestation | null> {
  const [r] = await sql<Record<string, unknown>[]>`select * from ops.capital_attestations where account_id = ${accountId} order by attested_at desc limit 1`;
  if (!r) return null;
  return { id: r['id'] as Uuid, accountId: r['account_id'] as Uuid, releaseId: r['release_id'] as Uuid, attestationId: r['attestation_id'] as Uuid, ceilingUsd: Number(r['ceiling_usd']), recognizedUsdAtAttestation: r['recognized_usd_at_attestation'] === null ? null : Number(r['recognized_usd_at_attestation']), attestedBy: r['attested_by'] as Uuid, attestedAt: iso(r['attested_at']) };
}

export interface StepUpEvidenceRow {
  credentialId: string;
  credentialFingerprint: Sha256Hex;
  challenge: string;
  verified: boolean;
  bindingHash: Sha256Hex;
}

/** The verified, unexpired step-up assertion bound to a control request, with the passkey it was made with. */
export async function stepUpEvidenceFor(sql: Sql, requestId: Uuid, now: Instant): Promise<StepUpEvidenceRow | null> {
  const [r] = await sql<{ credential_id: string | null; challenge: string; verified: boolean; binding_hash: string; public_key_cose: string | null }[]>`
    select p.credential_id, c.challenge, a.verified, a.binding_hash, p.public_key_cose
    from ops.step_up_assertions a
      join ops.step_up_challenges c on c.id = a.challenge_id
      left join ops.operator_passkeys p on p.id = a.passkey_id
    where a.control_request_id = ${requestId} and a.verified and a.expires_at > ${now}
    order by a.verified_at desc limit 1`;
  if (!r || !r.credential_id || !r.public_key_cose) return null;
  const [h] = await sql<{ fp: string }[]>`select encode(digest(${r.public_key_cose}, 'sha256'), 'hex') as fp`;
  return { credentialId: r.credential_id, credentialFingerprint: (h?.fp ?? '') as Sha256Hex, challenge: r.challenge, verified: r.verified, bindingHash: r.binding_hash as Sha256Hex };
}

export function releaseDigestOf(release: Pick<Release, 'digest'>): Sha256Hex {
  return release.digest;
}

export { asJson };

