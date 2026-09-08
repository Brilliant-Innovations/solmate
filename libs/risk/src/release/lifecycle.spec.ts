import fc from 'fast-check';
import { addMs, fixtures, type Instant, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { armingPreconditions, attestationFromStepUp, releaseTransition, type ReleaseEvent } from './lifecycle.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const release: Release = { id: IDS.release as Uuid, digest: 'ab'.repeat(32) as Sha256Hex, binding: {} as Release['binding'], status: 'DRAFT', createdAt: T0, promotedAt: null, retiredAt: null };
const stepUp = { credentialId: 'cred-1', credentialFingerprint: 'cd'.repeat(32) as Sha256Hex, challenge: 'c'.repeat(43), verified: true };
const attest = (purpose: ReleaseAttestation['purpose'], patch: Partial<ReleaseAttestation> = {}): ReleaseAttestation => {
  const r = attestationFromStepUp({ id: IDS.attestation as Uuid, release, purpose, operatorId: IDS.operator as Uuid, operatorRole: 'admin', stepUp, now: T0, validityMs: 600_000 });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.attestation, ...patch };
};

describe('release lifecycle and live arming (§12.4, §15.9, D41, D56; ADR-0004)', () => {
  it('walks DRAFT → PAPER_VALIDATED → ELIGIBLE_LIVE → ARMED → RETIRED only with the right evidence at each step', () => {
    const v = releaseTransition(release, { type: 'PAPER_VALIDATED', at: T0, evidence: { paperCycles: 25, minCycles: 20, reconciliationClean: true } });
    expect(v.ok && v.release.status).toBe('PAPER_VALIDATED');
    if (!v.ok) return;
    const p = releaseTransition(v.release, { type: 'PROMOTE', at: T0, attestation: attest('PROMOTE') });
    expect(p.ok && p.release).toMatchObject({ status: 'ELIGIBLE_LIVE', promotedAt: T0 });
    if (!p.ok) return;
    const a = releaseTransition(p.release, { type: 'ARM', at: T0, attestation: attest('ARM'), readinessPermits: true, capitalCeilingUsd: 500, liveCapabilityEnabled: true });
    expect(a.ok && a.release.status).toBe('ARMED');
    if (!a.ok) return;
    const r = releaseTransition(a.release, { type: 'RETIRE', at: addMs(T0, 1) });
    expect(r.ok && r.release).toMatchObject({ status: 'RETIRED', retiredAt: addMs(T0, 1) });
    if (!r.ok) return;
    expect(releaseTransition(r.release, { type: 'ARM', at: T0, attestation: attest('ARM'), readinessPermits: true, capitalCeilingUsd: 1, liveCapabilityEnabled: true })).toMatchObject({ ok: false, rejection: { code: 'INVALID_FROM_STATUS' } });
  });

  it('refuses out-of-order events, thin paper evidence, bad attestations, and arming without readiness, capability or a ceiling', () => {
    expect(releaseTransition(release, { type: 'PROMOTE', at: T0, attestation: attest('PROMOTE') })).toMatchObject({ ok: false, rejection: { code: 'INVALID_FROM_STATUS', status: 'DRAFT' } });
    expect(releaseTransition(release, { type: 'PAPER_VALIDATED', at: T0, evidence: { paperCycles: 3, minCycles: 20, reconciliationClean: false } })).toMatchObject({ ok: false, rejection: { code: 'PAPER_EVIDENCE_INSUFFICIENT', missing: ['paper cycles 3 < 20', 'reconciliation not clean'] } });
    const validated: Release = { ...release, status: 'PAPER_VALIDATED' };
    expect(releaseTransition(validated, { type: 'PROMOTE', at: T0, attestation: attest('ARM') })).toMatchObject({ ok: false, rejection: { code: 'ATTESTATION_INVALID', reasons: ['ATTESTATION_WRONG_PURPOSE'] } });
    expect(releaseTransition(validated, { type: 'PROMOTE', at: T0, attestation: attest('PROMOTE', { releaseDigest: 'ef'.repeat(32) as Sha256Hex }) })).toMatchObject({ ok: false, rejection: { code: 'ATTESTATION_INVALID', reasons: ['ATTESTATION_RELEASE_MISMATCH'] } });
    expect(releaseTransition(validated, { type: 'PROMOTE', at: addMs(T0, 601_000), attestation: attest('PROMOTE') })).toMatchObject({ ok: false, rejection: { code: 'ATTESTATION_INVALID', reasons: ['ATTESTATION_EXPIRED'] } });
    const eligible: Release = { ...release, status: 'ELIGIBLE_LIVE', promotedAt: T0 };
    expect(releaseTransition(eligible, { type: 'ARM', at: T0, attestation: attest('ARM'), readinessPermits: false, capitalCeilingUsd: 0, liveCapabilityEnabled: false })).toMatchObject({ ok: false, rejection: { code: 'LIVE_ARMING_PRECONDITION_FAILED', missing: ['deployment live capability', 'Live Readiness verdict', 'capital attestation ceiling'] } });
    expect(attestationFromStepUp({ id: IDS.attestation as Uuid, release, purpose: 'ARM', operatorId: IDS.operator as Uuid, operatorRole: 'operator', stepUp, now: T0, validityMs: null })).toEqual({ ok: false, reason: 'ROLE_NOT_ADMIN' });
    expect(attestationFromStepUp({ id: IDS.attestation as Uuid, release, purpose: 'ARM', operatorId: IDS.operator as Uuid, operatorRole: 'admin', stepUp: { ...stepUp, verified: false }, now: T0, validityMs: null })).toEqual({ ok: false, reason: 'STEP_UP_NOT_VERIFIED' });
  });

  it('§15.9 arming preconditions: PAPER needs nothing; LIVE needs capability, an ARMED Release with a valid ARM attestation, readiness and step-up', () => {
    expect(armingPreconditions({ requestedAuthority: 'PAPER', liveCapabilityEnabled: false, release: null, attestation: null, readinessPermits: false, stepUpVerified: false, now: T0 })).toEqual({ ok: true });
    const armed: Release = { ...release, status: 'ARMED', promotedAt: T0 };
    expect(armingPreconditions({ requestedAuthority: 'LIVE_APPROVAL', liveCapabilityEnabled: true, release: armed, attestation: attest('ARM'), readinessPermits: true, stepUpVerified: true, now: T0 })).toEqual({ ok: true });
    expect(armingPreconditions({ requestedAuthority: 'LIVE_APPROVAL', liveCapabilityEnabled: false, release: { ...armed, status: 'ELIGIBLE_LIVE' }, attestation: attest('PROMOTE'), readinessPermits: false, stepUpVerified: false, now: T0 })).toEqual({ ok: false, missing: ['deployment live capability', 'ARMED Release', 'valid ARM attestation', 'Live Readiness verdict', 'operator step-up'] });
  });

  it('property: no sequence of events reaches ARMED without a PROMOTE and an ARM attestation for this release, readiness and capability', () => {
    const eventArb: fc.Arbitrary<ReleaseEvent> = fc.oneof(
      fc.record({ paperCycles: fc.integer({ min: 0, max: 40 }), clean: fc.boolean() }).map((e) => ({ type: 'PAPER_VALIDATED' as const, at: T0, evidence: { paperCycles: e.paperCycles, minCycles: 20, reconciliationClean: e.clean } })),
      fc.constantFrom<ReleaseAttestation['purpose']>('PROMOTE', 'ARM', 'RESUME').map((purpose) => ({ type: 'PROMOTE' as const, at: T0, attestation: attest(purpose) })),
      fc.record({ purpose: fc.constantFrom<ReleaseAttestation['purpose']>('PROMOTE', 'ARM', 'RESUME'), ready: fc.boolean(), cap: fc.boolean(), ceiling: fc.integer({ min: 0, max: 1000 }) }).map((e) => ({ type: 'ARM' as const, at: T0, attestation: attest(e.purpose), readinessPermits: e.ready, capitalCeilingUsd: e.ceiling, liveCapabilityEnabled: e.cap })),
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 8 }), (events) => {
        let r = release;
        let sawPromote = false;
        let sawArm = false;
        for (const e of events) {
          const out = releaseTransition(r, e);
          if (!out.ok) continue;
          if (e.type === 'PROMOTE') sawPromote = true;
          if (e.type === 'ARM') {
            sawArm = true;
            expect(e.attestation.purpose).toBe('ARM');
            expect(e.readinessPermits && e.liveCapabilityEnabled && e.capitalCeilingUsd > 0).toBe(true);
          }
          r = out.release;
        }
        if (r.status === 'ARMED') expect(sawPromote && sawArm).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
