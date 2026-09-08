import { addMs, fixedClock, fixtures, generateSigningKeyPair, type CapitalAttestation, type Instant, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest, StepUpEvidenceRow } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runApprovalsCycle, type ApprovalsDeps, type ApprovalsRepo } from './approvals.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const release = (status: Release['status']): Release => ({ id: IDS.release as Uuid, digest: 'ab'.repeat(32) as Sha256Hex, binding: {} as Release['binding'], status, createdAt: T0, promotedAt: status === 'DRAFT' || status === 'PAPER_VALIDATED' ? null : T0, retiredAt: null });
const evidence: StepUpEvidenceRow = { credentialId: 'cred', credentialFingerprint: 'cd'.repeat(32) as Sha256Hex, challenge: 'c'.repeat(43), verified: true, bindingHash: 'ef'.repeat(32) as Sha256Hex };
const request = (kind: 'PROMOTE_RELEASE' | 'ARM_RELEASE', payload: Record<string, unknown>): PendingControlRequest => ({ id: IDS.message as Uuid, requestedBy: IDS.operator as Uuid, kind, payload, createdAt: T0 });

function fake(over: { release?: Release | null; role?: 'operator' | 'admin' | null; evidence?: StepUpEvidenceRow | null; paper?: { paperCycles: number; reconciliationClean: boolean }; conflicts?: { mint: string; sleeves: number }[]; requests: PendingControlRequest[] }) {
  const attestations: ReleaseAttestation[] = [];
  const capital: CapitalAttestation[] = [];
  const statuses: { from: Release['status']; to: Release['status'] }[] = [];
  const resolutions: { state: string; resolution: Record<string, unknown> }[] = [];
  let current = over.release === undefined ? release('DRAFT') : over.release;
  const repo: ApprovalsRepo = {
    async listPending() { return over.requests; },
    async stepUpVerified() { return over.evidence !== null; },
    async stepUpEvidence() { return over.evidence === undefined ? evidence : over.evidence; },
    async loadAuthorization() { return null; },
    async insertApproval() { throw new Error('not used'); },
    async setIntentState() { throw new Error('not used'); },
    async resolve(_id, state, resolution) { resolutions.push({ state, resolution }); return true; },
    async approverRole() { return over.role === undefined ? 'admin' : over.role; },
    async loadRelease() { return current; },
    async applyReleaseStatus(from, to) { if (!current || current.status !== from.status) return false; statuses.push({ from: from.status, to: to.status }); current = to; return true; },
    async insertAttestation(a) { attestations.push(a); },
    async insertCapitalAttestation(c) { capital.push(c); },
    async paperEvidence() { return over.paper ?? { paperCycles: 30, reconciliationClean: true }; },
    async recognizedUsd() { return 120; },
    async sleeveConflicts() { return over.conflicts ?? []; },
  };
  return { repo, attestations, capital, statuses, resolutions, current: () => current };
}
async function deps(repo: ApprovalsRepo, over: Partial<ApprovalsDeps> = {}): Promise<ApprovalsDeps> {
  return { repo, authorizerKeys: [], signing: await generateSigningKeyPair(), readinessPermits: async () => false, liveCapabilityEnabled: false, clock: fixedClock(addMs(T0, 1_000)), logger, config: { batchSize: 10, maxValidityMs: 120_000, attestationValidityMs: 600_000, minPaperCycles: 20 }, ...over };
}

describe('release promotion and arming through control requests (§12.4, §15.9, D41, D56)', () => {
  it('PROMOTE_RELEASE validates a DRAFT from paper evidence then promotes with an admin PROMOTE attestation from a verified step-up', async () => {
    const f = fake({ requests: [request('PROMOTE_RELEASE', { releaseId: IDS.release })] });
    const report = await runApprovalsCycle(await deps(f.repo));
    expect(report).toMatchObject({ requests: 1, promoted: 1, refused: {}, errors: [] });
    expect(f.statuses).toEqual([{ from: 'DRAFT', to: 'PAPER_VALIDATED' }, { from: 'PAPER_VALIDATED', to: 'ELIGIBLE_LIVE' }]);
    expect(f.attestations[0]).toMatchObject({ releaseId: IDS.release, releaseDigest: 'ab'.repeat(32), purpose: 'PROMOTE', operatorId: IDS.operator, operatorRole: 'admin', credentialId: 'cred', verificationResult: true, expiresAt: addMs(T0, 601_000) });
    expect(f.resolutions[0]).toMatchObject({ state: 'ACCEPTED', resolution: { releaseId: IDS.release, status: 'ELIGIBLE_LIVE' } });
    expect(f.current()?.promotedAt).toBe(addMs(T0, 1_000));
  });

  it('refuses promotion without step-up, for a non-admin, with thin paper evidence, or for an unknown Release', async () => {
    const cases: Array<[string, Parameters<typeof fake>[0], string]> = [
      ['no step-up', { evidence: null, requests: [request('PROMOTE_RELEASE', { releaseId: IDS.release })] }, 'STEP_UP_REQUIRED'],
      ['operator, not admin', { role: 'operator', requests: [request('PROMOTE_RELEASE', { releaseId: IDS.release })] }, 'ROLE_NOT_ADMIN'],
      ['thin paper evidence', { paper: { paperCycles: 2, reconciliationClean: true }, requests: [request('PROMOTE_RELEASE', { releaseId: IDS.release })] }, 'PAPER_EVIDENCE_INSUFFICIENT'],
      ['unknown release', { release: null, requests: [request('PROMOTE_RELEASE', { releaseId: IDS.release })] }, 'RELEASE_NOT_FOUND'],
      ['malformed payload', { requests: [request('PROMOTE_RELEASE', {})] }, 'MALFORMED_PAYLOAD'],
    ];
    for (const [label, over, reason] of cases) {
      const f = fake(over);
      const report = await runApprovalsCycle(await deps(f.repo));
      expect(report.refused, label).toEqual({ [reason]: 1 });
      expect(f.attestations, label).toEqual([]);
      expect(f.statuses, label).toEqual([]);
    }
  });

  it('ARM_RELEASE fails closed without the readiness verdict or live capability, and arms with both plus a capital ceiling that is recorded', async () => {
    const armReq = request('ARM_RELEASE', { releaseId: IDS.release, accountId: IDS.account, capitalCeilingUsd: 250 });
    const blocked = fake({ release: release('ELIGIBLE_LIVE'), requests: [armReq] });
    const r1 = await runApprovalsCycle(await deps(blocked.repo));
    expect(r1.refused).toEqual({ LIVE_ARMING_PRECONDITION_FAILED: 1 });
    expect(blocked.resolutions[0]?.resolution).toMatchObject({ reason: 'LIVE_ARMING_PRECONDITION_FAILED', detail: { missing: ['deployment live capability', 'Live Readiness verdict'] } });
    expect(blocked.attestations).toEqual([]);
    expect(blocked.capital).toEqual([]);
    const ready = fake({ release: release('ELIGIBLE_LIVE'), requests: [armReq] });
    const r2 = await runApprovalsCycle(await deps(ready.repo, { readinessPermits: async () => true, liveCapabilityEnabled: true }));
    expect(r2).toMatchObject({ armed: 1, refused: {} });
    expect(ready.statuses).toEqual([{ from: 'ELIGIBLE_LIVE', to: 'ARMED' }]);
    expect(ready.attestations[0]).toMatchObject({ purpose: 'ARM', releaseId: IDS.release });
    expect(ready.capital[0]).toMatchObject({ accountId: IDS.account, releaseId: IDS.release, attestationId: ready.attestations[0]?.id, ceilingUsd: 250, recognizedUsdAtAttestation: 120, attestedBy: IDS.operator });
    // a DRAFT cannot be armed straight away, and a missing ceiling is malformed
    const draft = fake({ requests: [armReq] });
    expect((await runApprovalsCycle(await deps(draft.repo, { readinessPermits: async () => true, liveCapabilityEnabled: true }))).refused).toEqual({ INVALID_FROM_STATUS: 1 });
    // ADR-0007: a mint held under two sleeves refuses arming before readiness is even asked
    const twoSleeves = fake({ release: release('ELIGIBLE_LIVE'), conflicts: [{ mint: 'So11111111111111111111111111111111111111112', sleeves: 2 }], requests: [armReq] });
    const r3 = await runApprovalsCycle(await deps(twoSleeves.repo, { readinessPermits: async () => true, liveCapabilityEnabled: true }));
    expect(r3.refused).toEqual({ SINGLE_SLEEVE_PER_MINT: 1 });
    expect(twoSleeves.resolutions[0]?.resolution).toMatchObject({ reason: 'SINGLE_SLEEVE_PER_MINT', conflicts: [{ sleeves: 2 }] });
    expect(twoSleeves.attestations).toEqual([]);
    const noCeiling = fake({ release: release('ELIGIBLE_LIVE'), requests: [request('ARM_RELEASE', { releaseId: IDS.release, accountId: IDS.account })] });
    expect((await runApprovalsCycle(await deps(noCeiling.repo, { readinessPermits: async () => true, liveCapabilityEnabled: true }))).refused).toEqual({ MALFORMED_PAYLOAD: 1 });
  });
});
