import { randomBytes, randomUUID } from 'node:crypto';
import { type CapitalAttestation, type Clock, type ControlRequestKind, type Instant, type Nonce, type Release, type ReleaseAttestation, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type SigningKeyPair, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import type { PendingControlRequest, StepUpEvidenceRow, TradeIntentState } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { attestationFromStepUp, buildApprovalGrant, releaseTransition, signApprovalGrant } from '@sol-agent-trader/risk';

/**
 * Worker role `approvals` (blueprint §12.4, §15.6, §15.9, §20.8, §20.23, D41, D56; execution plan
 * M7). Resolves the operator's authority-widening control requests:
 * - APPROVE_AUTHORIZATION / REJECT_AUTHORIZATION → a signed LIVE_APPROVAL grant bound to the
 *   verified authorization (step-up required for exposure increases), or a cancelled intent;
 * - PROMOTE_RELEASE → an admin PROMOTE attestation from a verified step-up moves a PAPER_VALIDATED
 *   Release to ELIGIBLE_LIVE (a DRAFT Release is first validated from paper evidence);
 * - ARM_RELEASE → an admin ARM attestation plus the Live Readiness verdict, deployment live
 *   capability and a capital ceiling move an ELIGIBLE_LIVE Release to ARMED and record the ceiling
 *   (D56). Readiness is a hook that answers false until M8a computes it, so arming fails closed.
 * Every refusal is recorded with its reason. Nothing here executes or changes the runtime mode.
 */

export interface ApprovalsRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  stepUpVerified(requestId: Uuid, now: Instant): Promise<boolean>;
  stepUpEvidence(requestId: Uuid, now: Instant): Promise<StepUpEvidenceRow | null>;
  loadAuthorization(intentId: Uuid): Promise<{ envelope: SignedRiskAuthorizedIntent } | null>;
  insertApproval(envelope: SignedApprovalGrant): Promise<void>;
  setIntentState(intentId: Uuid, state: TradeIntentState): Promise<void>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
  approverRole(userId: Uuid): Promise<'operator' | 'admin' | null>;
  loadRelease(id: Uuid): Promise<Release | null>;
  applyReleaseStatus(from: Release, to: Release): Promise<boolean>;
  insertAttestation(a: ReleaseAttestation): Promise<void>;
  insertCapitalAttestation(c: CapitalAttestation): Promise<void>;
  /** Paper evidence for DRAFT → PAPER_VALIDATED: cleared cycles under the Release's strategy and reconciliation cleanliness. */
  paperEvidence(release: Release): Promise<{ paperCycles: number; reconciliationClean: boolean }>;
  /** Recognized wallet/custody value in USD at arming, for the capital attestation record. */
  recognizedUsd(accountId: Uuid): Promise<number | null>;
}

export interface ApprovalsDeps {
  repo: ApprovalsRepo;
  authorizerKeys: readonly VerificationKey[];
  signing: SigningKeyPair;
  /** Live Readiness verdict for a Release (M8a); false until it exists (§15.9 fail closed). */
  readinessPermits: (releaseId: Uuid) => Promise<boolean>;
  liveCapabilityEnabled: boolean;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number; maxValidityMs: number; attestationValidityMs: number; minPaperCycles: number };
}

export interface ApprovalsReport {
  requests: number;
  granted: number;
  rejected: number;
  cancelled: number;
  promoted: number;
  armed: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

const KINDS: ControlRequestKind[] = ['APPROVE_AUTHORIZATION', 'REJECT_AUTHORIZATION', 'PROMOTE_RELEASE', 'ARM_RELEASE'];

export async function runApprovalsCycle(deps: ApprovalsDeps): Promise<ApprovalsReport> {
  const now = deps.clock.now();
  const report: ApprovalsReport = { requests: 0, granted: 0, rejected: 0, cancelled: 0, promoted: 0, armed: 0, refused: {}, errors: [] };
  const requests = await deps.repo.listPending(KINDS, deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('control_request_refused', { requestId: req.id, kind: req.kind, reason, ...extra });
    };
    try {
      switch (req.kind) {
        case 'APPROVE_AUTHORIZATION':
        case 'REJECT_AUTHORIZATION':
          await handleApproval(deps, report, req, now, refuse);
          break;
        case 'PROMOTE_RELEASE':
        case 'ARM_RELEASE':
          await handleRelease(deps, report, req, now, refuse);
          break;
        default:
          await refuse('UNSUPPORTED_KIND');
      }
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (report.requests > 0) deps.logger.info('approvals_cycle', { ...report, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('approval_failed', e);
  return report;
}

type Refuse = (reason: string, extra?: Record<string, unknown>) => Promise<void>;

async function handleApproval(deps: ApprovalsDeps, report: ApprovalsReport, req: PendingControlRequest, now: Instant, refuse: Refuse): Promise<void> {
  const intentId = typeof req.payload['intentId'] === 'string' ? (req.payload['intentId'] as Uuid) : null;
  if (!intentId) return refuse('MALFORMED_PAYLOAD');
  if (req.kind === 'REJECT_AUTHORIZATION') {
    await deps.repo.setIntentState(intentId, 'CANCELLED');
    await deps.repo.resolve(req.id, 'ACCEPTED', { intentId, cancelled: true }, now);
    report.cancelled++;
    deps.logger.info('authorization_rejected_by_operator', { requestId: req.id, intentId, by: req.requestedBy });
    return;
  }
  const role = await deps.repo.approverRole(req.requestedBy);
  if (!role) return refuse('NOT_AN_APPROVER');
  const stored = await deps.repo.loadAuthorization(intentId);
  if (!stored) return refuse('NOTHING_TO_APPROVE');
  const stepUp = (await deps.repo.stepUpVerified(req.id, now)) ? `step-up:${req.id}` : null;
  const built = await buildApprovalGrant({ authorization: stored.envelope, authorizerKeys: deps.authorizerKeys, intentId, approver: { id: req.requestedBy, role }, stepUpAssertionRef: stepUp, now, nonce: randomBytes(16).toString('hex') as Nonce, maxValidityMs: deps.config.maxValidityMs });
  if (!built.ok) return refuse(built.reason);
  const envelope = await signApprovalGrant(built.grant, deps.signing, now);
  await deps.repo.insertApproval(envelope);
  await deps.repo.resolve(req.id, 'ACCEPTED', { intentId, authorizationHash: built.grant.authorizationHash, expiresAt: built.grant.expiresAt, stepUp: stepUp !== null }, now);
  report.granted++;
  deps.logger.info('approval_granted', { requestId: req.id, intentId, authorizationHash: built.grant.authorizationHash, expiresAt: built.grant.expiresAt, role, stepUp: stepUp !== null, keyId: envelope.keyId });
}

async function handleRelease(deps: ApprovalsDeps, report: ApprovalsReport, req: PendingControlRequest, now: Instant, refuse: Refuse): Promise<void> {
  const releaseId = typeof req.payload['releaseId'] === 'string' ? (req.payload['releaseId'] as Uuid) : null;
  if (!releaseId) return refuse('MALFORMED_PAYLOAD');
  const role = await deps.repo.approverRole(req.requestedBy);
  if (role !== 'admin') return refuse('ROLE_NOT_ADMIN');
  let release = await deps.repo.loadRelease(releaseId);
  if (!release) return refuse('RELEASE_NOT_FOUND');
  const evidence = await deps.repo.stepUpEvidence(req.id, now);
  if (!evidence) return refuse('STEP_UP_REQUIRED');
  const purpose: ReleaseAttestation['purpose'] = req.kind === 'ARM_RELEASE' ? 'ARM' : 'PROMOTE';
  const made = attestationFromStepUp({ id: randomUUID() as Uuid, release, purpose, operatorId: req.requestedBy, operatorRole: role, stepUp: evidence, now, validityMs: deps.config.attestationValidityMs });
  if (!made.ok) return refuse(made.reason);

  if (req.kind === 'PROMOTE_RELEASE') {
    if (release.status === 'DRAFT') {
      const paper = await deps.repo.paperEvidence(release);
      const validated = releaseTransition(release, { type: 'PAPER_VALIDATED', at: now, evidence: { ...paper, minCycles: deps.config.minPaperCycles } });
      if (!validated.ok) return refuse(validated.rejection.code, { detail: validated.rejection });
      if (!(await deps.repo.applyReleaseStatus(release, validated.release))) return refuse('RELEASE_CHANGED_UNDERNEATH');
      release = validated.release;
    }
    const promoted = releaseTransition(release, { type: 'PROMOTE', at: now, attestation: made.attestation });
    if (!promoted.ok) return refuse(promoted.rejection.code, { detail: promoted.rejection });
    await deps.repo.insertAttestation(made.attestation);
    if (!(await deps.repo.applyReleaseStatus(release, promoted.release))) return refuse('RELEASE_CHANGED_UNDERNEATH');
    report.promoted++;
    await deps.repo.resolve(req.id, 'ACCEPTED', { releaseId, status: promoted.release.status, attestationId: made.attestation.id }, now);
    deps.logger.info('release_promoted', { requestId: req.id, releaseId, digest: release.digest, status: promoted.release.status, attestationId: made.attestation.id, by: req.requestedBy });
    return;
  }

  const accountId = typeof req.payload['accountId'] === 'string' ? (req.payload['accountId'] as Uuid) : null;
  const ceilingUsd = typeof req.payload['capitalCeilingUsd'] === 'number' ? (req.payload['capitalCeilingUsd'] as number) : NaN;
  if (!accountId || !(ceilingUsd > 0)) return refuse('MALFORMED_PAYLOAD', { needs: ['accountId', 'capitalCeilingUsd > 0'] });
  const readinessPermits = await deps.readinessPermits(releaseId);
  const armed = releaseTransition(release, { type: 'ARM', at: now, attestation: made.attestation, readinessPermits, capitalCeilingUsd: ceilingUsd, liveCapabilityEnabled: deps.liveCapabilityEnabled });
  if (!armed.ok) return refuse(armed.rejection.code, { detail: armed.rejection });
  const recognized = await deps.repo.recognizedUsd(accountId);
  await deps.repo.insertAttestation(made.attestation);
  await deps.repo.insertCapitalAttestation({ id: randomUUID() as Uuid, accountId, releaseId, attestationId: made.attestation.id, ceilingUsd, recognizedUsdAtAttestation: recognized, attestedBy: req.requestedBy, attestedAt: now });
  if (!(await deps.repo.applyReleaseStatus(release, armed.release))) return refuse('RELEASE_CHANGED_UNDERNEATH');
  report.armed++;
  await deps.repo.resolve(req.id, 'ACCEPTED', { releaseId, status: 'ARMED', attestationId: made.attestation.id, capitalCeilingUsd: ceilingUsd, recognizedUsd: recognized }, now);
  deps.logger.info('release_armed', { requestId: req.id, releaseId, digest: release.digest, attestationId: made.attestation.id, capitalCeilingUsd: ceilingUsd, recognizedUsd: recognized, by: req.requestedBy });
}
