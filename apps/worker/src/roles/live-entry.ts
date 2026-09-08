import { checkApprovalBinding, compareInstants, type ActivityState, type CapitalAuthority, type Clock, type ExecutionRequest, type Instant, type ProtectionMode, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { AuthorizedIntentRow, EntryCandidateRow, TradeIntentState } from '@sol-agent-trader/db/server';
import type { AuthorizeOutcome } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `live-entry` (blueprint §13.7, §15.3–15.6, §20.8, D38, D41; execution plan M7 "full
 * intent path"). For a LIVE account: every cleared ENTER cycle is handed to the risk-authorizer,
 * which alone decides and signs; every unexpired authorization is executed once its mode allows it
 * (LIVE_AUTO directly, LIVE_APPROVAL only with a bound, unexpired, step-up-backed grant); an
 * authorization that expires unexecuted is recorded as EXPIRED_BY_LATENCY. The worker never sizes,
 * signs or approves anything here: it moves envelopes between the services that do.
 */

export interface LiveEntryRepo {
  listAwaitingAuthorization(strategyVersionIds: VersionId[], limit: number): Promise<EntryCandidateRow[]>;
  listAuthorizedAwaitingExecution(accountId: Uuid, now: Instant, limit: number): Promise<AuthorizedIntentRow[]>;
  approvalFor(intentId: Uuid): Promise<SignedApprovalGrant | null>;
  setIntentState(intentId: Uuid, state: TradeIntentState): Promise<void>;
  sessionGate(accountId: Uuid): Promise<{ activity: ActivityState; paused: boolean; authority: CapitalAuthority } | null>;
}

export interface LiveEntryDeps {
  repo: LiveEntryRepo;
  authorizer: { authorize(req: { actionCycleId: Uuid; accountId: Uuid }): Promise<AuthorizeOutcome> };
  executor: { execute(request: ExecutionRequest, protectionMode: ProtectionMode): Promise<Record<string, unknown>> };
  clock: Clock;
  logger: Logger;
  account: { id: Uuid };
  strategyVersionIds: VersionId[];
  config: { batchSize: number; protectionMode: ProtectionMode };
}

export interface LiveEntryReport {
  gate: 'CLOSED' | 'LIVE_APPROVAL' | 'LIVE_AUTO';
  awaitingAuthorization: number;
  authorized: number;
  denied: Record<string, number>;
  awaitingApproval: number;
  executed: Record<string, number>;
  expiredByLatency: number;
  errors: { ref: string; error: string }[];
}

const ENTRY_ACTIVITY = new Set<ActivityState>(['ACTIVE', 'EVENT_WINDOW']);

export async function runLiveEntryCycle(deps: LiveEntryDeps): Promise<LiveEntryReport> {
  const now = deps.clock.now();
  const report: LiveEntryReport = { gate: 'CLOSED', awaitingAuthorization: 0, authorized: 0, denied: {}, awaitingApproval: 0, executed: {}, expiredByLatency: 0, errors: [] };
  const gate = await deps.repo.sessionGate(deps.account.id);
  const live = gate !== null && !gate.paused && ENTRY_ACTIVITY.has(gate.activity) && (gate.authority === 'LIVE_APPROVAL' || gate.authority === 'LIVE_AUTO');
  report.gate = live ? (gate.authority as 'LIVE_APPROVAL' | 'LIVE_AUTO') : 'CLOSED';

  // 1. Authorization: only while the gate is open; the authorizer re-checks the same facts itself (D38).
  if (live) {
    const awaiting = await deps.repo.listAwaitingAuthorization(deps.strategyVersionIds, deps.config.batchSize);
    report.awaitingAuthorization = awaiting.length;
    for (const row of awaiting) {
      try {
        const out = await deps.authorizer.authorize({ actionCycleId: row.cycle.id, accountId: deps.account.id });
        if (out.kind === 'AUTHORIZED') {
          report.authorized++;
          deps.logger.info('live_entry_authorized', { cycleId: row.cycle.id, intentId: out.intentId, asset: row.asset.symbol, maxInputAmount: out.envelope.payload.maxInputAmount, expiresAt: out.envelope.payload.expiresAt, projectionSequence: out.projectionSequence });
        } else {
          for (const code of out.denial.reasonCodes) report.denied[code] = (report.denied[code] ?? 0) + 1;
          deps.logger.info('live_entry_denied', { cycleId: row.cycle.id, asset: row.asset.symbol, reasonCodes: out.denial.reasonCodes, detail: out.denial.detail });
        }
      } catch (err) {
        report.errors.push({ ref: `authorize:${row.cycle.id}`, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 2. Execution of what is authorized: expiry first, then the mode gate, then the executor.
  const pending = await deps.repo.listAuthorizedAwaitingExecution(deps.account.id, now, deps.config.batchSize);
  for (const row of pending) {
    try {
      const p = row.envelope.payload;
      if (compareInstants(now, row.intent.expiresAt) >= 0 || compareInstants(now, p.expiresAt) >= 0) {
        await deps.repo.setIntentState(row.intent.id, 'EXPIRED');
        report.expiredByLatency++;
        deps.logger.warn('live_entry_expired_by_latency', { intentId: row.intent.id, cycleId: row.intent.actionCycleId, intentExpiresAt: row.intent.expiresAt, authorizationExpiresAt: p.expiresAt });
        continue;
      }
      if (!live) continue; // the gate closed after authorization: nothing executes until it reopens or the authorization expires (ADR-0009 P3 is enforced again by the executor)
      let approval: SignedApprovalGrant | null = null;
      if (gate.authority === 'LIVE_APPROVAL') {
        approval = await deps.repo.approvalFor(row.intent.id);
        const binding = approval ? checkApprovalBinding({ grant: approval.payload, authorizationHash: row.authorizationHash, intentId: row.intent.id, now, usedNonces: new Set(), requireStepUp: row.intent.exposureEffect === 'INCREASE' }) : null;
        if (!approval || !binding || !binding.ok) {
          report.awaitingApproval++;
          if (binding && !binding.ok) deps.logger.warn('live_entry_approval_unbound', { intentId: row.intent.id, reason: binding.reason });
          continue;
        }
      }
      const request: ExecutionRequest = { intent: row.intent, capitalAuthority: p.capitalAuthority, authorization: row.envelope, approvalHash: approval?.payloadHash ?? null, executionPath: 'JUPITER_ORDER', requestedAt: now };
      const result = await deps.executor.execute(request, deps.config.protectionMode);
      const outcome = String(result['outcome'] ?? 'UNKNOWN');
      report.executed[outcome] = (report.executed[outcome] ?? 0) + 1;
      deps.logger.info('live_entry_executed', { intentId: row.intent.id, cycleId: row.intent.actionCycleId, outcome, state: (result['execution'] as { attempt?: { state?: string } } | undefined)?.attempt?.state ?? null, reasons: result['reasons'] ?? null });
    } catch (err) {
      report.errors.push({ ref: `execute:${row.intent.id}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.logger.info('live_entry_cycle', { ...report, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('live_entry_failed', e);
  return report;
}

export type { SignedRiskAuthorizedIntent, TradeIntent };
