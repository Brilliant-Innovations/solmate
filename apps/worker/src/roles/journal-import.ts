import { randomUUID } from 'node:crypto';
import type { Clock, ExecutorJournalEntry, Instant, Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `journal-import` (blueprint §15.10, §20.25, D22; execution plan M8a). Once Postgres
 * answers again, the executor's local journal is the only record of what happened during the
 * outage. This role pulls the journal from the executor's authenticated API, imports every
 * emergency, pause and shadow record into the hash-chained audit ledger with its original local
 * time, and turns an imported emergency close into the operator review gate: a sticky entry pause
 * that only a step-up RESUME clears, plus a CRITICAL alert that names the action. Normal attempts
 * are already reconciled into the trading tables by the executor itself and are not duplicated.
 */

export interface JournalImportRepo {
  lastImportedSequence(): Promise<number>;
  importEntry(entry: ExecutorJournalEntry): Promise<{ imported: boolean; auditSequence: number | null }>;
  emergencyCorrelationIds(): Promise<string[]>;
  insertEntryPauseOnce(reason: string, ref: string): Promise<boolean>;
  openAlertExists(alertClass: string): Promise<boolean>;
  raise(n: { id: Uuid; severity: 'CRITICAL' | 'HIGH'; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant }): Promise<void>;
}

export interface JournalImportDeps {
  repo: JournalImportRepo;
  executor: { journal(after: number, limit: number): Promise<{ entries: ExecutorJournalEntry[]; head: number | null }> } | null;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number };
  newId?: () => Uuid;
}

export interface JournalImportReport {
  fetched: number;
  imported: number;
  skipped: number;
  emergencyCloses: number;
  reviewGateSet: boolean;
  head: number | null;
  lastImported: number;
  /** The executor's journal head is behind our cursor: it is not the journal the cursor refers to. */
  journalReset: boolean;
}

/** Records worth the ledger: emergency commands, executor pauses, shadow syncs, and every attempt line of an emergency intent. */
const ALWAYS = new Set(['EMERGENCY_COMMAND_RECEIVED', 'EMERGENCY_COMMAND_REJECTED', 'PAUSE_APPLIED', 'PAUSE_CLEARED', 'SHADOW_SYNCED', 'CUSTODY_RECONCILED']);
const ATTEMPT = new Set(['ATTEMPT_PREPARED', 'ATTEMPT_SIGNED', 'ATTEMPT_SUBMITTED', 'ATTEMPT_OBSERVED', 'ATTEMPT_REORG_PENDING', 'ATTEMPT_RESULT', 'EXPOSURE_LEDGER_UPDATED']);

export function selectImportable(entries: readonly ExecutorJournalEntry[], knownEmergency: ReadonlySet<string>): { importable: ExecutorJournalEntry[]; emergency: Set<string> } {
  const emergency = new Set(knownEmergency);
  for (const e of entries) if (e.kind === 'ATTEMPT_PREPARED' && e.payload['emergency'] === true) emergency.add(e.correlationId);
  const importable = entries.filter((e) => ALWAYS.has(e.kind) || (ATTEMPT.has(e.kind) && emergency.has(e.correlationId)));
  return { importable, emergency };
}

export async function runJournalImportCycle(deps: JournalImportDeps): Promise<JournalImportReport> {
  const now = deps.clock.now();
  const newId = deps.newId ?? (() => randomUUID() as Uuid);
  const lastImported = await deps.repo.lastImportedSequence();
  const report: JournalImportReport = { fetched: 0, imported: 0, skipped: 0, emergencyCloses: 0, reviewGateSet: false, head: null, lastImported, journalReset: false };
  if (!deps.executor) return report;
  const page = await deps.executor.journal(lastImported, deps.config.batchSize);
  report.fetched = page.entries.length;
  report.head = page.head;

  /**
   * DEFECT-2 (2026-09-09): the cursor and the journal it indexes live in different places.
   *
   * `lastImported` comes from our own audit ledger in Postgres; the journal it points into lives on
   * the executor's disk. An executor whose journal was reset — a new volume, a wiped
   * `EXECUTOR_JOURNAL_PATH`, a replaced host — restarts its sequences below the cursor. Asking for
   * everything after sequence 500 of a journal that now ends at 3 returns an empty page, and this
   * used to be indistinguishable from "nothing new": the role reported a healthy `fetched: 0` cycle
   * indefinitely while the outage records it exists to import were never read.
   *
   * A head behind the cursor is proof of that, and it is the executor's own report of its state
   * rather than an inference from ours. It is not recoverable here — the records those sequences
   * referred to are gone — so this raises and stops rather than advancing the cursor over a gap.
   */
  if (page.head !== null && page.head < lastImported) {
    report.journalReset = true;
    deps.logger.error('executor_journal_reset', { head: page.head, lastImported, effect: 'journal import stopped; outage records at or below the cursor cannot be imported' });
    if (!(await deps.repo.openAlertExists('EXECUTOR_JOURNAL_RESET'))) {
      await deps.repo.raise({
        id: newId(),
        severity: 'CRITICAL',
        alertClass: 'EXECUTOR_JOURNAL_RESET',
        summary: `The executor's journal head is ${page.head}, behind the import cursor at ${lastImported}: this is not the journal the cursor refers to. Emergency, pause and shadow records the audit ledger has not imported are unrecoverable, and import is stopped until an operator reconciles it (§15.10, §20.25).`.slice(0, 512),
        affected: { assetId: null, strategyVersionId: null, positionId: null, system: 'journal-import', head: page.head, lastImported },
        automatedResponse: null,
        raisedAt: now,
      });
    }
    return report;
  }

  if (page.entries.length === 0) return report;
  const known = new Set(await deps.repo.emergencyCorrelationIds());
  const { importable, emergency } = selectImportable(page.entries, known);
  const closes: { commandId: string; type: string; issuer: string; reason: string; at: Instant }[] = [];
  for (const e of importable) {
    const r = await deps.repo.importEntry(e);
    if (r.imported) report.imported++;
    else report.skipped++;
    if (r.imported && e.kind === 'EMERGENCY_COMMAND_RECEIVED' && e.payload['type'] !== 'PAUSE_NEW_ENTRIES') {
      closes.push({ commandId: String(e.payload['commandId'] ?? e.correlationId), type: String(e.payload['type']), issuer: String(e.payload['issuer'] ?? 'unknown'), reason: String(e.payload['reason'] ?? ''), at: e.at });
    }
  }
  report.emergencyCloses = closes.length;
  report.lastImported = Math.max(lastImported, ...page.entries.map((e) => e.sequence));
  if (closes.length) {
    // §15.10: an emergency action taken while the database was away needs operator review before new entries resume.
    const set = await deps.repo.insertEntryPauseOnce('DB_OUTAGE_EMERGENCY_REVIEW', 'journal-import');
    report.reviewGateSet = set;
    if (!(await deps.repo.openAlertExists('DB_OUTAGE_EMERGENCY_ACTION_IMPORTED'))) {
      await deps.repo.raise({
        id: newId(),
        severity: 'CRITICAL',
        alertClass: 'DB_OUTAGE_EMERGENCY_ACTION_IMPORTED',
        summary: `${closes.length} emergency action(s) recorded by the executor were imported: ${closes.map((c) => `${c.type} by ${c.issuer} at ${c.at}`).join('; ')}. New entries stay paused until an operator reviews and resumes with step-up.`.slice(0, 512),
        affected: { assetId: null, strategyVersionId: null, positionId: null, system: 'journal-import', commandIds: closes.map((c) => c.commandId) },
        automatedResponse: 'PAUSE_NEW_ENTRIES (sticky, operator review)',
        raisedAt: now,
      });
    }
    deps.logger.error('db_outage_emergency_actions_imported', { closes, reviewGateSet: set });
  }
  deps.logger.info('journal_import_cycle', { ...report, emergencyIntents: emergency.size });
  return report;
}
