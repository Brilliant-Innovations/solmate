import { randomBytes } from 'node:crypto';
import { type Clock, type ControlRequestKind, type Instant, type Nonce, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type SigningKeyPair, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import type { PendingControlRequest, TradeIntentState } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { buildApprovalGrant, signApprovalGrant } from '@sol-agent-trader/risk';

/**
 * Worker role `approvals` (blueprint §15.6, §20.8, §20.23, D41; execution plan M7). Resolves the
 * operator's APPROVE_AUTHORIZATION / REJECT_AUTHORIZATION control requests. An approval becomes a
 * signed grant only when the stored authorization verifies against the pinned authorizer keys, is
 * unexpired, names the requested intent, and (for exposure-increasing intents) the request carries a
 * verified step-up assertion. The grant binds to the recomputed authorization hash, nonce and an
 * expiry never later than the intent's own. A rejection cancels the intent. Nothing here executes.
 */

export interface ApprovalsRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  stepUpVerified(requestId: Uuid, now: Instant): Promise<boolean>;
  loadAuthorization(intentId: Uuid): Promise<{ envelope: SignedRiskAuthorizedIntent } | null>;
  insertApproval(envelope: SignedApprovalGrant): Promise<void>;
  setIntentState(intentId: Uuid, state: TradeIntentState): Promise<void>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
  approverRole(userId: Uuid): Promise<'operator' | 'admin' | null>;
}

export interface ApprovalsDeps {
  repo: ApprovalsRepo;
  authorizerKeys: readonly VerificationKey[];
  signing: SigningKeyPair;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number; maxValidityMs: number };
}

export interface ApprovalsReport {
  requests: number;
  granted: number;
  rejected: number;
  cancelled: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

export async function runApprovalsCycle(deps: ApprovalsDeps): Promise<ApprovalsReport> {
  const now = deps.clock.now();
  const report: ApprovalsReport = { requests: 0, granted: 0, rejected: 0, cancelled: 0, refused: {}, errors: [] };
  const requests = await deps.repo.listPending(['APPROVE_AUTHORIZATION', 'REJECT_AUTHORIZATION'], deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const intentId = typeof req.payload['intentId'] === 'string' ? (req.payload['intentId'] as Uuid) : null;
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('approval_refused', { requestId: req.id, kind: req.kind, intentId, reason });
    };
    try {
      if (!intentId) {
        await refuse('MALFORMED_PAYLOAD');
        continue;
      }
      if (req.kind === 'REJECT_AUTHORIZATION') {
        await deps.repo.setIntentState(intentId, 'CANCELLED');
        await deps.repo.resolve(req.id, 'ACCEPTED', { intentId, cancelled: true }, now);
        report.cancelled++;
        deps.logger.info('authorization_rejected_by_operator', { requestId: req.id, intentId, by: req.requestedBy });
        continue;
      }
      const role = await deps.repo.approverRole(req.requestedBy);
      if (!role) {
        await refuse('NOT_AN_APPROVER');
        continue;
      }
      const stored = await deps.repo.loadAuthorization(intentId);
      if (!stored) {
        await refuse('NOTHING_TO_APPROVE');
        continue;
      }
      const stepUp = (await deps.repo.stepUpVerified(req.id, now)) ? `step-up:${req.id}` : null;
      const built = await buildApprovalGrant({ authorization: stored.envelope, authorizerKeys: deps.authorizerKeys, intentId, approver: { id: req.requestedBy, role }, stepUpAssertionRef: stepUp, now, nonce: randomBytes(16).toString('hex') as Nonce, maxValidityMs: deps.config.maxValidityMs });
      if (!built.ok) {
        await refuse(built.reason);
        continue;
      }
      const envelope = await signApprovalGrant(built.grant, deps.signing, now);
      await deps.repo.insertApproval(envelope);
      await deps.repo.resolve(req.id, 'ACCEPTED', { intentId, authorizationHash: built.grant.authorizationHash, expiresAt: built.grant.expiresAt, stepUp: stepUp !== null }, now);
      report.granted++;
      deps.logger.info('approval_granted', { requestId: req.id, intentId, authorizationHash: built.grant.authorizationHash, expiresAt: built.grant.expiresAt, role, stepUp: stepUp !== null, keyId: envelope.keyId });
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (report.requests > 0) deps.logger.info('approvals_cycle', { ...report, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('approval_failed', e);
  return report;
}
