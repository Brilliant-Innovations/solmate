import type { Clock, Instant, Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker restart recovery (blueprint §21.3; execution plan M7). Before any entry or monitoring
 * loop accepts work the worker: loads what the database believes is open, re-reads chain and
 * custody truth through one reconciliation pass, settles intents whose attempts already reached a
 * terminal state, expires authorizations that outlived their validity (EXPIRED_BY_LATENCY), and
 * only then resumes. "Never assume database OPEN means the chain position is still open": a
 * reconciliation mismatch pauses entries through the reconciliation role's own path (D9), and an
 * EXECUTING intent with an attempt still in flight is left to the executor journal, never guessed.
 */

export interface RecoveryFacts {
  openPositions: number;
  openLots: number;
  intents: Record<string, number>;
  inFlightAttempts: number;
}

export interface RecoveryRepo {
  facts(accountId: Uuid): Promise<RecoveryFacts>;
  /** Intents in AUTHORIZED/APPROVED/CREATED whose own expiry passed: EXPIRED, returning their ids. */
  expireStaleIntents(accountId: Uuid, now: Instant): Promise<Uuid[]>;
  /** EXECUTING intents whose newest attempt is terminal: COMPLETED (FINALIZED) or FAILED (NOT_LANDED). */
  settleFromAttempts(accountId: Uuid): Promise<{ intentId: Uuid; state: 'COMPLETED' | 'FAILED' }[]>;
  /** EXECUTING intents with no attempt at all past their expiry (the process died before the adapter ran): FAILED. */
  failOrphanedExecuting(accountId: Uuid, now: Instant): Promise<Uuid[]>;
}

export interface RecoveryDeps {
  repo: RecoveryRepo;
  /** One reconciliation pass over chain and custody truth; null when the worker has no RPC. */
  reconcile: (() => Promise<{ accounts: number; clean: number; mismatch: number; unavailable: number; paused: number }>) | null;
  account: { id: Uuid };
  clock: Clock;
  logger: Logger;
}

export interface RecoveryReport {
  before: RecoveryFacts;
  reconciliation: { accounts: number; clean: number; mismatch: number; unavailable: number; paused: number } | 'SKIPPED_NO_RPC' | { error: string };
  expiredByLatency: Uuid[];
  settled: { intentId: Uuid; state: 'COMPLETED' | 'FAILED' }[];
  orphanedExecuting: Uuid[];
  after: RecoveryFacts;
  /** New work may start; false only when reconciliation itself could not run at all and the book has open exposure. */
  resume: boolean;
}

export async function runStartupRecovery(deps: RecoveryDeps): Promise<RecoveryReport> {
  const now = deps.clock.now();
  const before = await deps.repo.facts(deps.account.id);
  deps.logger.info('recovery_loaded', { accountId: deps.account.id, ...before });

  let reconciliation: RecoveryReport['reconciliation'];
  if (!deps.reconcile) reconciliation = 'SKIPPED_NO_RPC';
  else {
    try {
      reconciliation = await deps.reconcile();
    } catch (err) {
      reconciliation = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const settled = await deps.repo.settleFromAttempts(deps.account.id);
  const expiredByLatency = await deps.repo.expireStaleIntents(deps.account.id, now);
  const orphanedExecuting = await deps.repo.failOrphanedExecuting(deps.account.id, now);
  const after = await deps.repo.facts(deps.account.id);

  const reconciled = typeof reconciliation === 'object' && !('error' in reconciliation);
  const hasExposure = after.openPositions > 0 || after.inFlightAttempts > 0;
  const resume = reconciled || reconciliation === 'SKIPPED_NO_RPC' || !hasExposure;
  const report: RecoveryReport = { before, reconciliation, expiredByLatency, settled, orphanedExecuting, after, resume };
  deps.logger[resume ? 'info' : 'error']('recovery_complete', { accountId: deps.account.id, reconciliation, expiredByLatency: expiredByLatency.length, settled, orphanedExecuting, after, resume });
  for (const id of expiredByLatency) deps.logger.warn('intent_expired_by_latency', { intentId: id, at: now, recovered: true });
  return report;
}
