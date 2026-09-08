import { randomUUID } from 'node:crypto';
import { toInstant, type ExecutorJournalEntry, type Sequence, type Sha256Hex } from '@sol-agent-trader/contracts';
import { importedEmergencyCorrelationIds, importJournalEntry, insertEntryPauseOnce, lastImportedJournalSequence } from './journal-import-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();
const hex = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') as Sha256Hex;

describe.skipIf(!url)('executor journal import into the audit ledger (§15.10, §20.25)', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'journal-import-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('imports an entry once with origin EMERGENCY_JOURNAL_IMPORT, keeps the original local time next to the import time, and the review-gate pause is set once', async () => {
    const localAt = toInstant(Date.UTC(2026, 8, 8, 3, 0, 0));
    const before = await lastImportedJournalSequence(sql);
    const seq = (before + 1) as Sequence;
    const corr = `em-${randomUUID().slice(0, 8)}`;
    const entry: ExecutorJournalEntry = { sequence: seq, at: localAt, kind: 'ATTEMPT_PREPARED', correlationId: corr, payload: { emergency: true, commandId: randomUUID() }, previousHash: hex(), hash: hex() };
    const first = await importJournalEntry(sql, entry, 'test-holder');
    expect(first.imported).toBe(true);
    const again = await importJournalEntry(sql, entry, 'test-holder');
    expect(again).toEqual({ imported: false, auditSequence: null });
    expect(await lastImportedJournalSequence(sql)).toBe(seq);
    expect(await importedEmergencyCorrelationIds(sql)).toContain(corr);

    const [audit] = await sql<{ origin: string; original_local_at: Date; imported_at: Date | null; actor: string; action_class: string }[]>`
      select origin, original_local_at, imported_at, actor, action_class from audit.events where sequence = ${first.auditSequence}`;
    expect(audit).toMatchObject({ origin: 'EMERGENCY_JOURNAL_IMPORT', actor: 'EXECUTOR', action_class: 'ATTEMPT_PREPARED' });
    expect(audit?.original_local_at.toISOString()).toBe(new Date(localAt).toISOString());
    expect(audit?.imported_at).not.toBeNull();
    expect(audit!.imported_at!.getTime()).toBeGreaterThan(audit!.original_local_at.getTime());

    const reason = `DB_OUTAGE_EMERGENCY_REVIEW_TEST_${randomUUID().slice(0, 6)}`;
    expect(await insertEntryPauseOnce(sql, reason, 'WORKER', 'journal-import')).toBe(true);
    expect(await insertEntryPauseOnce(sql, reason, 'WORKER', 'journal-import')).toBe(false);
    await sql`update ops.entry_pauses set cleared_at = now(), cleared_by_ref = 'test' where reason = ${reason}`;
  });
});
