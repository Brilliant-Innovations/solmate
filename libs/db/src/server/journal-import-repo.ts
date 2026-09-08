import type { ExecutorJournalEntry, Instant, JsonRecord, Uuid } from '@sol-agent-trader/contracts';
import { writeAuditEvent } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Executor-journal import (§15.10, §20.25): once Postgres is back, the worker copies the executor's
 * emergency, pause and shadow records into the hash-chained audit ledger with origin
 * EMERGENCY_JOURNAL_IMPORT, keeping the original local time. Each journal hash is imported once.
 */

export async function lastImportedJournalSequence(sql: Sql): Promise<number> {
  const [r] = await sql<{ s: string | number | null }[]>`select max(journal_sequence) as s from ops.executor_journal_imports`;
  return r?.s === null || r?.s === undefined ? -1 : Number(r.s);
}

/** Imports one entry atomically with its audit row; returns false when its hash was imported before. */
export async function importJournalEntry(sql: Sql, entry: ExecutorJournalEntry, actorRef: string): Promise<{ imported: boolean; auditSequence: number | null }> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [exists] = await t<{ id: string }[]>`select id from ops.executor_journal_imports where journal_hash = ${entry.hash}`;
    if (exists) return { imported: false, auditSequence: null };
    const audit = await writeAuditEvent(t, {
      actor: 'EXECUTOR',
      actorRef,
      actionClass: entry.kind,
      entity: { type: 'executor_journal', id: String(entry.sequence) },
      afterSummary: { correlationId: entry.correlationId, ...entry.payload } as JsonRecord,
      origin: 'EMERGENCY_JOURNAL_IMPORT',
      liveImpacting: true,
      originalLocalAt: entry.at,
    });
    await t`
      insert into ops.executor_journal_imports (journal_sequence, journal_hash, kind, correlation_id, payload, original_local_at, audit_sequence)
      values (${entry.sequence}, ${entry.hash}, ${entry.kind}, ${entry.correlationId}, ${t.json(asJson(entry.payload))}, ${entry.at}, ${audit.sequence})`;
    return { imported: true, auditSequence: audit.sequence as number };
  }) as Promise<{ imported: boolean; auditSequence: number | null }>;
}

/** Correlation ids of emergency intents already imported, so their later ATTEMPT_* lines are recognised as emergency records. */
export async function importedEmergencyCorrelationIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ correlation_id: string }[]>`select distinct correlation_id from ops.executor_journal_imports where kind = 'ATTEMPT_PREPARED' and (payload ->> 'emergency')::boolean`;
  return rows.map((r) => r.correlation_id);
}

/** The operator review gate (§15.10): a sticky pause that only a step-up RESUME clears, set once per reason. */
export async function insertEntryPauseOnce(sql: Sql, reason: string, setBy: 'WORKER' | 'WATCHDOG', ref: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    insert into ops.entry_pauses (reason, set_by, set_by_ref)
    select ${reason}, ${setBy}, ${ref} where not exists (select 1 from ops.entry_pauses where cleared_at is null and reason = ${reason})
    returning id`;
  return rows.length > 0;
}

export type { Instant, Uuid };
