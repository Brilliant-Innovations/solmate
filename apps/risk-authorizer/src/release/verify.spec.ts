import { addMs, canonicalHash, fixtures, toInstant, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { verifyRelease } from './verify.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const FP = 'ab'.repeat(32) as Sha256Hex;

async function release(over: Partial<Release['binding']> = {}, status: Release['status'] = 'ARMED'): Promise<Release> {
  const binding: Release['binding'] = {
    strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: 'skill@1' as VersionId, guidelineVersionId: 'guide@1' as VersionId, automationSetVersionId: 'auto@1' as VersionId,
    proposerModelPolicyVersion: null, adversaryModelPolicyVersion: 'adv@1' as VersionId, riskPolicyVersion: 'risk-v1' as VersionId, cohortPolicyVersion: 'cohorts@1' as VersionId,
    freshnessPolicyVersion: 'fresh@1' as VersionId, executorPolicyRef: 'exec@1' as VersionId, contractSetDigest: 'cd'.repeat(32) as Sha256Hex, ...over,
  };
  return { id: fixtures.IDS.release as Uuid, digest: await canonicalHash(binding), binding, status, createdAt: NOW, promotedAt: NOW, retiredAt: null };
}
const attestation = (r: Release, over: Partial<ReleaseAttestation> = {}): ReleaseAttestation => ({
  id: fixtures.IDS.attestation as Uuid, releaseId: r.id, releaseDigest: r.digest, purpose: 'ARM', operatorId: fixtures.IDS.operator as Uuid, operatorRole: 'admin', credentialId: 'cred', credentialFingerprint: FP, challenge: 'c'.repeat(32), verificationResult: true, attestedAt: NOW, expiresAt: addMs(NOW, 3_600_000), ...over,
});

describe('release and attestation verification (D21, D38, INV-17, INV-18)', () => {
  it('an armed, attested release with a matching recomputed digest is accepted for live authority', async () => {
    const r = await release();
    const v = await verifyRelease({ release: r, attestation: attestation(r), capitalAuthority: 'LIVE_APPROVAL', trustedFingerprints: [FP], now: NOW });
    expect(v).toEqual({ ok: true, digest: r.digest, attestationId: fixtures.IDS.attestation });
  });

  it('INV-18: a tampered binding, a wrong-digest attestation, an untrusted, unverified, expired or missing attestation each refuse', async () => {
    const r = await release();
    const tampered = { ...r, binding: { ...r.binding, riskPolicyVersion: 'risk-v2' as VersionId } }; // digest no longer matches the binding
    const cases: [Release, ReleaseAttestation | null, string][] = [
      [tampered, attestation(tampered), 'RELEASE_DIGEST_MISMATCH'],
      [r, attestation(r, { releaseDigest: 'ee'.repeat(32) as Sha256Hex }), 'ATTESTATION_RELEASE_MISMATCH'],
      [r, attestation(r, { credentialFingerprint: 'ff'.repeat(32) as Sha256Hex }), 'ATTESTATION_UNTRUSTED_CREDENTIAL'],
      [r, attestation(r, { verificationResult: false }), 'ATTESTATION_NOT_VERIFIED'],
      [r, attestation(r, { expiresAt: NOW }), 'ATTESTATION_EXPIRED'],
      [r, attestation(r, { purpose: 'PROMOTE' }), 'ATTESTATION_WRONG_PURPOSE'],
      [r, null, 'ATTESTATION_MISSING'],
      [{ ...r, status: 'ELIGIBLE_LIVE' }, attestation(r), 'RELEASE_STATUS_FORBIDS_AUTHORITY'],
      [{ ...r, status: 'RETIRED', retiredAt: NOW }, attestation(r), 'RELEASE_RETIRED'],
    ];
    for (const [rel, att, reason] of cases) {
      const v = await verifyRelease({ release: rel, attestation: att, capitalAuthority: 'LIVE_APPROVAL', trustedFingerprints: [FP], now: NOW });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
  });

  it('INV-17: LIVE_AUTO needs versioned skill, guideline and automation set; paper needs a promoted release but no ARM attestation purpose', async () => {
    const unversioned = await release({ skillVersionId: null });
    const v = await verifyRelease({ release: unversioned, attestation: attestation(unversioned), capitalAuthority: 'LIVE_AUTO', trustedFingerprints: [FP], now: NOW });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toEqual(['RELEASE_UNVERSIONED_AUTONOMY']);
    const paper = await release({}, 'PAPER_VALIDATED');
    expect((await verifyRelease({ release: paper, attestation: attestation(paper, { purpose: 'PROMOTE' }), capitalAuthority: 'PAPER', trustedFingerprints: [FP], now: NOW })).ok).toBe(true);
    const draft = await release({}, 'DRAFT');
    const d = await verifyRelease({ release: draft, attestation: attestation(draft, { purpose: 'PROMOTE' }), capitalAuthority: 'PAPER', trustedFingerprints: [FP], now: NOW });
    expect(d.ok).toBe(false);
  });
});
