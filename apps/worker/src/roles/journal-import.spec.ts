import { fixedClock, fixtures, type ExecutorJournalEntry, type Instant, type Sequence, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { runJournalImportCycle, selectImportable, type JournalImportDeps } from './journal-import.js';

const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
let seq = 0;
const entry = (kind: ExecutorJournalEntry['kind'], correlationId: string, payload: Record<string, unknown> = {}): ExecutorJournalEntry => ({ sequence: ++seq as Sequence, at: T0, kind, correlationId, payload, previousHash: 'ab'.repeat(32) as Sha256Hex, hash: `${String(seq).padStart(4, '0')}`.padEnd(64, 'c') as Sha256Hex });

function fake(entries: ExecutorJournalEntry[], over: { executor?: null; alreadyOpen?: boolean } = {}) {
  const imported: ExecutorJournalEntry[] = [];
  const pauses: string[] = [];
  const alerts: { alertClass: string; summary: string }[] = [];
  let n = 0;
  const deps: JournalImportDeps = {
    repo: {
      async lastImportedSequence() { return imported.length ? Math.max(...imported.map((e) => e.sequence)) : -1; },
      async importEntry(e) { if (imported.some((x) => x.hash === e.hash)) return { imported: false, auditSequence: null }; imported.push(e); return { imported: true, auditSequence: 100 + imported.length }; },
      async emergencyCorrelationIds() { return imported.filter((e) => e.kind === 'ATTEMPT_PREPARED' && e.payload['emergency'] === true).map((e) => e.correlationId); },
      async insertEntryPauseOnce(reason) { if (pauses.includes(reason)) return false; pauses.push(reason); return true; },
      async openAlertExists(cls) { return over.alreadyOpen === true || alerts.some((a) => a.alertClass === cls); },
      async raise(a) { alerts.push({ alertClass: a.alertClass, summary: a.summary }); },
    },
    executor: over.executor === null ? null : { async journal(after, limit) { const page = entries.filter((e) => e.sequence > after).slice(0, limit); return { entries: page, head: entries.at(-1)?.sequence ?? null }; } },
    clock: fixedClock(T0),
    logger,
    config: { batchSize: 100 },
    newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-00000000d00d` as Uuid,
  };
  return { deps, imported, pauses, alerts };
}

describe('executor journal import into the audit ledger (§15.10, §20.25)', () => {
  it('selects emergency, pause and shadow records plus every attempt line of an emergency intent, and nothing from ordinary attempts', () => {
    seq = 0;
    const entries = [
      entry('ATTEMPT_PREPARED', 'normal-1', { intentId: 'normal-1' }),
      entry('ATTEMPT_RESULT', 'normal-1', { state: 'FINALIZED' }),
      entry('EMERGENCY_COMMAND_RECEIVED', 'cmd-1', { commandId: 'cmd-1', type: 'EMERGENCY_CLOSE_ALL', issuer: 'POSITION_MONITOR' }),
      entry('ATTEMPT_PREPARED', 'em-1', { emergency: true, commandId: 'cmd-1' }),
      entry('ATTEMPT_SUBMITTED', 'em-1', {}),
      entry('ATTEMPT_RESULT', 'em-1', { state: 'FINALIZED' }),
      entry('PAUSE_APPLIED', 'ops', { reason: 'EMERGENCY_ACTION:cmd-1' }),
      entry('SHADOW_SYNCED', 'shadow:4', { sequence: 4 }),
      entry('RECONCILED_INTO_DB', 'normal-1', {}),
    ];
    const { importable, emergency } = selectImportable(entries, new Set());
    expect(importable.map((e) => `${e.kind}:${e.correlationId}`)).toEqual(['EMERGENCY_COMMAND_RECEIVED:cmd-1', 'ATTEMPT_PREPARED:em-1', 'ATTEMPT_SUBMITTED:em-1', 'ATTEMPT_RESULT:em-1', 'PAUSE_APPLIED:ops', 'SHADOW_SYNCED:shadow:4']);
    expect([...emergency]).toEqual(['em-1']);
    // an emergency intent known from an earlier import keeps its later lines importable
    const later = [entry('ATTEMPT_RESULT', 'em-old', { state: 'NOT_LANDED' })];
    expect(selectImportable(later, new Set(['em-old'])).importable).toHaveLength(1);
    expect(selectImportable(later, new Set()).importable).toHaveLength(0);
  });

  it('imports once per hash, resumes from the last imported sequence, and an imported emergency close sets the sticky review gate and one CRITICAL alert', async () => {
    seq = 0;
    const entries = [
      entry('ATTEMPT_PREPARED', 'normal-1', {}),
      entry('EMERGENCY_COMMAND_RECEIVED', 'cmd-1', { commandId: 'cmd-1', type: 'EMERGENCY_CLOSE_ASSET', issuer: 'POSITION_MONITOR', reason: 'shadow UNREVIEWED_STOP' }),
      entry('ATTEMPT_PREPARED', 'em-1', { emergency: true }),
      entry('ATTEMPT_RESULT', 'em-1', { state: 'FINALIZED' }),
      entry('PAUSE_APPLIED', 'ops', { reason: 'EMERGENCY_ACTION:cmd-1' }),
    ];
    const f = fake(entries);
    const r1 = await runJournalImportCycle(f.deps);
    expect(r1).toMatchObject({ fetched: 5, imported: 4, skipped: 0, emergencyCloses: 1, reviewGateSet: true, head: 5, lastImported: 5 });
    expect(f.pauses).toEqual(['DB_OUTAGE_EMERGENCY_REVIEW']);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]?.summary).toContain('EMERGENCY_CLOSE_ASSET by POSITION_MONITOR');
    // nothing new: nothing fetched past the cursor, gate and alert untouched
    const r2 = await runJournalImportCycle(f.deps);
    expect(r2).toMatchObject({ fetched: 0, imported: 0, emergencyCloses: 0, reviewGateSet: false });
    // a later pause record and a second command: imported, gate already set, alert already open
    entries.push(entry('EMERGENCY_COMMAND_RECEIVED', 'cmd-2', { commandId: 'cmd-2', type: 'EMERGENCY_CLOSE_ALL', issuer: 'OPERATOR_OUT_OF_BAND' }), entry('PAUSE_CLEARED', 'ops', { by: 'operator' }));
    const r3 = await runJournalImportCycle(f.deps);
    expect(r3).toMatchObject({ fetched: 2, imported: 2, emergencyCloses: 1, reviewGateSet: false });
    expect(f.alerts).toHaveLength(1);
    expect(f.pauses).toEqual(['DB_OUTAGE_EMERGENCY_REVIEW']);
  });

  it('a pause-only command sets no review gate; without an executor the role does nothing', async () => {
    seq = 0;
    const f = fake([entry('EMERGENCY_COMMAND_RECEIVED', 'cmd-p', { commandId: 'cmd-p', type: 'PAUSE_NEW_ENTRIES', issuer: 'OPERATOR_OUT_OF_BAND' })]);
    expect(await runJournalImportCycle(f.deps)).toMatchObject({ imported: 1, emergencyCloses: 0, reviewGateSet: false });
    expect(f.pauses).toEqual([]);
    const none = fake([entry('PAUSE_APPLIED', 'ops', {})], { executor: null });
    expect(await runJournalImportCycle(none.deps)).toMatchObject({ fetched: 0, imported: 0 });
  });
});
