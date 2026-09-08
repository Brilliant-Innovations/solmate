import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMs, toInstant, type Instant } from '@sol-agent-trader/contracts';
import { ExecutorJournal, FencingError, JournalCorruptError } from './journal.js';

const T0 = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));

describe('executor durable journal (§15.10, D12; ADR-0009 P4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solmate-journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('entries are hash-chained and survive a restart; a signed-not-submitted attempt is recovered as unresolved and its nonce stays used', async () => {
    const path = join(dir, 'executor.journal');
    let t = T0;
    const clock = () => (t = addMs(t, 1) as Instant);
    const j = await ExecutorJournal.open(path, 'executor-A', clock);
    await j.append('ATTEMPT_PREPARED', 'intent-1', { intentId: 'i1', idempotencyKey: 'entry:c1' });
    await j.append('ATTEMPT_SIGNED', 'intent-1', { nonce: 'ab'.repeat(16), signedTxHash: 'cd'.repeat(32), expectedTxSignature: 'sig1' });
    j.release();
    // process dies here, before submit; a new process reopens the same journal
    const again = await ExecutorJournal.open(path, 'executor-B', clock);
    expect(again.all()).toHaveLength(2);
    expect(again.all()[1]!.previousHash).toBe(again.all()[0]!.hash);
    expect(again.unresolvedAttempts()).toEqual([{ correlationId: 'intent-1', lastKind: 'ATTEMPT_SIGNED', signedTxHash: 'cd'.repeat(32), expectedTxSignature: 'sig1' }]);
    expect(again.usedNonces().has('ab'.repeat(16) as never)).toBe(true);
    await again.append('ATTEMPT_RESULT', 'intent-1', { state: 'NOT_LANDED', lifecycle: 'FAILED' });
    expect(again.unresolvedAttempts()).toEqual([]);
    expect(again.all()[2]!.sequence).toBe(2);
  });

  it('fencing: a second executor cannot open a held journal; a stale holder that lost the fence cannot append', async () => {
    const path = join(dir, 'executor.journal');
    const a = await ExecutorJournal.open(path, 'executor-A', () => T0);
    await expect(ExecutorJournal.open(path, 'executor-B', () => T0)).rejects.toThrow(FencingError);
    a.release();
    const b = await ExecutorJournal.open(path, 'executor-B', () => T0);
    await b.append('PAUSE_APPLIED', 'ops', { by: 'B' });
    // A comes back from the dead and tries to write: its token is superseded
    await expect(a.append('PAUSE_CLEARED', 'ops', { by: 'A' })).rejects.toThrow(FencingError);
    expect((await ExecutorJournal.load(path)).map((e) => e.payload['by'])).toEqual(['B']);
  });

  it('a truncated, reordered or edited line is detected as corruption on load rather than trusted', async () => {
    const path = join(dir, 'executor.journal');
    const j = await ExecutorJournal.open(path, 'executor-A', () => T0);
    await j.append('PAUSE_APPLIED', 'ops', { n: 1 });
    await j.append('PAUSE_CLEARED', 'ops', { n: 2 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines[1]}\n${lines[0]}\n`);
    await expect(ExecutorJournal.load(path)).rejects.toThrow(JournalCorruptError);
    writeFileSync(path, `${lines[0]}\n${lines[1]!.replace('"n":2', '"n":3')}\n`);
    await expect(ExecutorJournal.load(path)).rejects.toThrow(JournalCorruptError);
    writeFileSync(path, `${lines[0]}\n`);
    expect(await ExecutorJournal.load(path)).toHaveLength(1);
  });
});
