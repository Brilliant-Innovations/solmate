import { addMs, canonicalHash, compareInstants, type CapitalAuthority, type Instant, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Release lifecycle and live arming (blueprint §12.4, §15.6, §15.9, D41, D56; ADR-0004; execution
 * plan M7). A Release moves DRAFT → PAPER_VALIDATED → ELIGIBLE_LIVE → ARMED → RETIRED only through
 * events that carry their evidence: paper validation facts, an admin PROMOTE attestation from a
 * verified step-up, an ARM attestation plus a Live Readiness verdict and a capital ceiling. Every
 * step is pure; the worker persists what comes back. Nothing here signs or executes.
 */

export type ReleaseEvent =
  | { type: 'PAPER_VALIDATED'; at: Instant; evidence: { paperCycles: number; minCycles: number; reconciliationClean: boolean } }
  | { type: 'PROMOTE'; at: Instant; attestation: ReleaseAttestation }
  | { type: 'ARM'; at: Instant; attestation: ReleaseAttestation; readinessPermits: boolean; capitalCeilingUsd: number; liveCapabilityEnabled: boolean }
  | { type: 'RETIRE'; at: Instant };

export type ReleaseRejection =
  | { code: 'INVALID_FROM_STATUS'; status: Release['status']; event: ReleaseEvent['type'] }
  | { code: 'PAPER_EVIDENCE_INSUFFICIENT'; missing: string[] }
  | { code: 'ATTESTATION_INVALID'; reasons: string[] }
  | { code: 'LIVE_ARMING_PRECONDITION_FAILED'; missing: string[] };

export type ReleaseResult = { ok: true; release: Release } | { ok: false; rejection: ReleaseRejection };

function attestationReasons(a: ReleaseAttestation, release: Release, purpose: ReleaseAttestation['purpose'], now: Instant): string[] {
  const reasons: string[] = [];
  if (a.releaseId !== release.id || a.releaseDigest !== release.digest) reasons.push('ATTESTATION_RELEASE_MISMATCH');
  if (!a.verificationResult) reasons.push('ATTESTATION_NOT_VERIFIED');
  if (a.operatorRole !== 'admin') reasons.push('ATTESTATION_ROLE_NOT_ADMIN');
  if (a.purpose !== purpose) reasons.push('ATTESTATION_WRONG_PURPOSE');
  if (a.expiresAt !== null && compareInstants(a.expiresAt, now) <= 0) reasons.push('ATTESTATION_EXPIRED');
  return reasons;
}

export function releaseTransition(release: Release, event: ReleaseEvent): ReleaseResult {
  const reject = (rejection: ReleaseRejection): ReleaseResult => ({ ok: false, rejection });
  if (release.status === 'RETIRED' && event.type !== 'RETIRE') return reject({ code: 'INVALID_FROM_STATUS', status: release.status, event: event.type });
  switch (event.type) {
    case 'PAPER_VALIDATED': {
      if (release.status !== 'DRAFT') return reject({ code: 'INVALID_FROM_STATUS', status: release.status, event: event.type });
      const missing: string[] = [];
      if (event.evidence.paperCycles < event.evidence.minCycles) missing.push(`paper cycles ${event.evidence.paperCycles} < ${event.evidence.minCycles}`);
      if (!event.evidence.reconciliationClean) missing.push('reconciliation not clean');
      if (missing.length) return reject({ code: 'PAPER_EVIDENCE_INSUFFICIENT', missing });
      return { ok: true, release: { ...release, status: 'PAPER_VALIDATED' } };
    }
    case 'PROMOTE': {
      if (release.status !== 'PAPER_VALIDATED') return reject({ code: 'INVALID_FROM_STATUS', status: release.status, event: event.type });
      const reasons = attestationReasons(event.attestation, release, 'PROMOTE', event.at);
      if (reasons.length) return reject({ code: 'ATTESTATION_INVALID', reasons });
      return { ok: true, release: { ...release, status: 'ELIGIBLE_LIVE', promotedAt: event.at } };
    }
    case 'ARM': {
      if (release.status !== 'ELIGIBLE_LIVE' && release.status !== 'ARMED') return reject({ code: 'INVALID_FROM_STATUS', status: release.status, event: event.type });
      const reasons = attestationReasons(event.attestation, release, 'ARM', event.at);
      if (reasons.length) return reject({ code: 'ATTESTATION_INVALID', reasons });
      const missing: string[] = [];
      if (!event.liveCapabilityEnabled) missing.push('deployment live capability');
      if (!event.readinessPermits) missing.push('Live Readiness verdict');
      if (!(event.capitalCeilingUsd > 0) || !Number.isFinite(event.capitalCeilingUsd)) missing.push('capital attestation ceiling');
      if (missing.length) return reject({ code: 'LIVE_ARMING_PRECONDITION_FAILED', missing });
      return { ok: true, release: { ...release, status: 'ARMED' } };
    }
    case 'RETIRE':
      return { ok: true, release: { ...release, status: 'RETIRED', retiredAt: event.at } };
  }
}

export interface StepUpEvidence {
  credentialId: string;
  credentialFingerprint: Sha256Hex;
  challenge: string;
  verified: boolean;
}

/** An attestation is a verified admin step-up bound to this exact Release digest; it expires so a stale ceremony cannot arm later. */
export function attestationFromStepUp(input: { id: Uuid; release: Release; purpose: ReleaseAttestation['purpose']; operatorId: Uuid; operatorRole: 'operator' | 'admin' | 'viewer'; stepUp: StepUpEvidence; now: Instant; validityMs: number | null }): { ok: true; attestation: ReleaseAttestation } | { ok: false; reason: 'STEP_UP_NOT_VERIFIED' | 'ROLE_NOT_ADMIN' } {
  if (!input.stepUp.verified) return { ok: false, reason: 'STEP_UP_NOT_VERIFIED' };
  if (input.operatorRole !== 'admin') return { ok: false, reason: 'ROLE_NOT_ADMIN' };
  return {
    ok: true,
    attestation: {
      id: input.id, releaseId: input.release.id, releaseDigest: input.release.digest, purpose: input.purpose, operatorId: input.operatorId, operatorRole: 'admin', credentialId: input.stepUp.credentialId, credentialFingerprint: input.stepUp.credentialFingerprint,
      challenge: input.stepUp.challenge, verificationResult: true, attestedAt: input.now, expiresAt: input.validityMs === null ? null : addMs(input.now, input.validityMs),
    },
  };
}

/** §15.9: every live-arming condition, evaluated for a requested authority; PAPER and OBSERVE need none. */
export function armingPreconditions(input: { requestedAuthority: CapitalAuthority; liveCapabilityEnabled: boolean; release: Release | null; attestation: ReleaseAttestation | null; readinessPermits: boolean; stepUpVerified: boolean; now: Instant }): { ok: true } | { ok: false; missing: string[] } {
  if (input.requestedAuthority !== 'LIVE_APPROVAL' && input.requestedAuthority !== 'LIVE_AUTO') return { ok: true };
  const missing: string[] = [];
  if (!input.liveCapabilityEnabled) missing.push('deployment live capability');
  if (!input.release || input.release.status !== 'ARMED') missing.push('ARMED Release');
  if (!input.attestation || (input.release && attestationReasons(input.attestation, input.release, 'ARM', input.now).length > 0)) missing.push('valid ARM attestation');
  if (!input.readinessPermits) missing.push('Live Readiness verdict');
  if (!input.stepUpVerified) missing.push('operator step-up');
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** A recorded capital ceiling: the value under wallet and custody that live arming attested to (D56). */
export async function capitalAttestationDigest(input: { accountId: Uuid; releaseId: Uuid; ceilingUsd: number; attestationId: Uuid }): Promise<Sha256Hex> {
  return canonicalHash(input);
}
