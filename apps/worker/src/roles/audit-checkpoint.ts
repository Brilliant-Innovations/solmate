import type { Instant, Uuid } from '@sol-agent-trader/contracts';
import type { AuditCheckpoint, AuditVerificationInput } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `audit-checkpoint` (blueprint §6.22, §20.25; ADR-0009 P2). Verifies the hash-chained
 * audit ledger, replicates its head outside Postgres and then verifies the ledger against that
 * external copy, so a database-only attacker who rewrites history cannot also rewrite the record
 * the risk-authorizer checks clearances against. Every cycle persists its outcome as an immutable
 * `audit.verifications` row (the Audit Log's "last verified checkpoint"), and a cycle that cannot
 * verify raises one CRITICAL `AUDIT_CHAIN_UNVERIFIED` alert that resolves when a later cycle passes.
 * A broken chain is an error-level event, never a silent skip.
 */

export interface AuditCheckpointRepo {
  /** Verifies the chain and replicates the head; throws when the chain is broken; null on an empty ledger. */
  checkpoint(): Promise<AuditCheckpoint | null>;
  /** The ledger verified against the external replica's latest checkpoint. */
  verify(): Promise<{ ok: true; checkpoint: AuditCheckpoint } | { ok: false; reason: string; detail: string }>;
  /** Persists the cycle outcome (§20.25). Optional so the M2 unit tests and the empty-ledger path stay minimal. */
  record?(v: AuditVerificationInput): Promise<void>;
  openAlertExists?(alertClass: string): Promise<boolean>;
  raise?(n: { id: Uuid; severity: 'CRITICAL'; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant }): Promise<void>;
  resolve?(alertClass: string, at: Instant): Promise<unknown>;
}

export interface AuditCheckpointDeps {
  repo: AuditCheckpointRepo;
  logger: Logger;
  /** Label of the external replica, recorded on every verification row. */
  replica?: string;
  clock: { now(): Instant };
  newId?: () => Uuid;
}

export interface AuditCheckpointReport {
  checkpoint: AuditCheckpoint | null;
  verified: boolean;
  reason: string | null;
}

export const AUDIT_CHAIN_ALERT = 'AUDIT_CHAIN_UNVERIFIED';

export async function runAuditCheckpointCycle(deps: AuditCheckpointDeps): Promise<AuditCheckpointReport> {
  const report = await cycle(deps);
  await persist(deps, report);
  return { checkpoint: report.checkpoint, verified: report.verified, reason: report.reason };
}

async function cycle(deps: AuditCheckpointDeps): Promise<AuditCheckpointReport & { detail?: string; verifiedAgainst?: AuditCheckpoint }> {
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
    return { checkpoint, verified: false, reason: v.reason, detail: v.detail };
  }
  deps.logger.info('audit_checkpoint_cycle', { head: checkpoint.sequence, hash: checkpoint.hash, verifiedAgainst: v.checkpoint.sequence });
  return { checkpoint, verified: true, reason: null, verifiedAgainst: v.checkpoint };
}

async function persist(deps: AuditCheckpointDeps, r: AuditCheckpointReport & { detail?: string; verifiedAgainst?: AuditCheckpoint }): Promise<void> {
  const { repo } = deps;
  const replica = deps.replica ?? 'unknown';
  if (repo.record) {
    if (r.checkpoint) {
      // An empty ledger has nothing to verify and records nothing; every other cycle leaves a row.
      await repo.record({
        ok: r.verified,
        headSequence: r.checkpoint.sequence,
        checkpoint: r.verifiedAgainst ? { sequence: r.verifiedAgainst.sequence, hash: r.verifiedAgainst.hash } : null,
        replica,
        reason: r.verified ? null : (r.reason ?? 'UNKNOWN').slice(0, 64),
        detail: r.verified ? null : (r.detail ?? r.reason),
      });
    } else if (!r.verified) {
      await repo.record({ ok: false, headSequence: null, checkpoint: null, replica, reason: 'CHAIN_BROKEN', detail: r.reason });
    }
  }
  const at = deps.clock.now();
  if (!r.verified) {
    if (repo.raise && repo.openAlertExists && !(await repo.openAlertExists(AUDIT_CHAIN_ALERT))) {
      await repo.raise({
        id: deps.newId?.() ?? (crypto.randomUUID() as Uuid),
        severity: 'CRITICAL',
        alertClass: AUDIT_CHAIN_ALERT,
        summary: `Audit ledger could not be verified against its external checkpoint: ${r.reason}`,
        affected: { head: r.checkpoint?.sequence ?? null, reason: r.reason, detail: r.detail ?? null },
        automatedResponse: null,
        raisedAt: at,
      });
    }
  } else if (repo.resolve) {
    await repo.resolve(AUDIT_CHAIN_ALERT, at);
  }
}
