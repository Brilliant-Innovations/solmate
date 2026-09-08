import { canonicalHash, instantToMs, type CapitalAuthority, type Instant, type Release, type ReleaseAttestation, type Sha256Hex } from '@sol-agent-trader/contracts';

/**
 * Release and attestation verification (blueprint D21, D38, §15.5; INV-17, INV-18). The
 * risk-authorizer signs only against an immutable Release whose digest is the canonical hash of
 * its binding, whose status permits the requested capital authority, and whose operator
 * attestation is present, verified, trusted, unexpired and bound to that exact digest. A
 * database pointer can never substitute a different bundle: the digest is recomputed here.
 */

export type ReleaseRejection =
  | 'RELEASE_DIGEST_MISMATCH'
  | 'RELEASE_STATUS_FORBIDS_AUTHORITY'
  | 'RELEASE_RETIRED'
  | 'RELEASE_UNVERSIONED_AUTONOMY'
  | 'ATTESTATION_MISSING'
  | 'ATTESTATION_RELEASE_MISMATCH'
  | 'ATTESTATION_NOT_VERIFIED'
  | 'ATTESTATION_UNTRUSTED_CREDENTIAL'
  | 'ATTESTATION_WRONG_PURPOSE'
  | 'ATTESTATION_EXPIRED';

export interface ReleaseVerifyInput {
  release: Release;
  attestation: ReleaseAttestation | null;
  capitalAuthority: CapitalAuthority;
  trustedFingerprints: readonly Sha256Hex[];
  now: Instant;
}

export type ReleaseVerdict = { ok: true; digest: Sha256Hex; attestationId: ReleaseAttestation['id'] } | { ok: false; reasons: ReleaseRejection[] };

const LIVE = new Set<CapitalAuthority>(['LIVE_APPROVAL', 'LIVE_AUTO']);

export async function verifyRelease(input: ReleaseVerifyInput): Promise<ReleaseVerdict> {
  const { release, attestation, capitalAuthority, now } = input;
  const reasons: ReleaseRejection[] = [];
  const digest = await canonicalHash(release.binding);
  if (digest !== release.digest) reasons.push('RELEASE_DIGEST_MISMATCH');
  if (release.status === 'RETIRED' || release.retiredAt !== null) reasons.push('RELEASE_RETIRED');
  const live = LIVE.has(capitalAuthority);
  if (live && release.status !== 'ARMED') reasons.push('RELEASE_STATUS_FORBIDS_AUTHORITY');
  if (!live && capitalAuthority === 'PAPER' && release.status === 'DRAFT') reasons.push('RELEASE_STATUS_FORBIDS_AUTHORITY');
  // INV-17: autonomous live strategies bind immutable, versioned skill, guideline and automation sets.
  if (capitalAuthority === 'LIVE_AUTO' && (release.binding.skillVersionId === null || release.binding.guidelineVersionId === null || release.binding.automationSetVersionId === null)) reasons.push('RELEASE_UNVERSIONED_AUTONOMY');

  if (!attestation) reasons.push('ATTESTATION_MISSING');
  else {
    if (attestation.releaseId !== release.id || attestation.releaseDigest !== digest) reasons.push('ATTESTATION_RELEASE_MISMATCH');
    if (!attestation.verificationResult || attestation.operatorRole !== 'admin') reasons.push('ATTESTATION_NOT_VERIFIED');
    if (!input.trustedFingerprints.includes(attestation.credentialFingerprint)) reasons.push('ATTESTATION_UNTRUSTED_CREDENTIAL');
    if (live && attestation.purpose !== 'ARM' && attestation.purpose !== 'RESUME') reasons.push('ATTESTATION_WRONG_PURPOSE');
    if (attestation.expiresAt !== null && instantToMs(attestation.expiresAt) <= instantToMs(now)) reasons.push('ATTESTATION_EXPIRED');
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, digest, attestationId: attestation!.id };
}
