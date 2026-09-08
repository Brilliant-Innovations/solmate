import type { AuditCheckpoint } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `audit-checkpoint` (blueprint §6.22, §20.25; ADR-0009 P2). Verifies the hash-chained
 * audit ledger, replicates its head outside Postgres and then verifies the ledger against that
 * external copy, so a database-only attacker who rewrites history cannot also rewrite the record
 * the risk-authorizer checks clearances against. A broken chain is an error-level event, never a
 * silent skip.
 */

export interface AuditCheckpointRepo {
  /** Verifies the chain and replicates the head; throws when the chain is broken; null on an empty ledger. */
  checkpoint(): Promise<AuditCheckpoint | null>;
  /** The ledger verified against the external replica's latest checkpoint. */
  verify(): Promise<{ ok: true; checkpoint: AuditCheckpoint } | { ok: false; reason: string; detail: string }>;
}

export interface AuditCheckpointDeps {
  repo: AuditCheckpointRepo;
  logger: Logger;
}

export interface AuditCheckpointReport {
  checkpoint: AuditCheckpoint | null;
  verified: boolean;
  reason: string | null;
}

export async function runAuditCheckpointCycle(deps: AuditCheckpointDeps): Promise<AuditCheckpointReport> {
  let checkpoint: AuditCheckpoint | null;
  try {
    checkpoint = await deps.repo.checkpoint();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.error('audit_chain_broken', { reason });
    return { checkpoint: null, verified: false, reason };
  }
  if (!checkpoint) {
    deps.logger.info('audit_checkpoint_cycle', { ledger: 'empty' });
    return { checkpoint: null, verified: true, reason: null };
  }
  const v = await deps.repo.verify();
  if (!v.ok) {
    deps.logger.error('audit_checkpoint_unverified', { reason: v.reason, detail: v.detail, head: checkpoint.sequence });
    return { checkpoint, verified: false, reason: v.reason };
  }
  deps.logger.info('audit_checkpoint_cycle', { head: checkpoint.sequence, hash: checkpoint.hash, verifiedAgainst: v.checkpoint.sequence });
  return { checkpoint, verified: true, reason: null };
}
