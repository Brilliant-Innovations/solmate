import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toInstant, type IdempotencyKey, type Uuid } from '@sol-agent-trader/contracts';
import { ExecutorJournal } from '../journal/journal.js';
import { IdempotencyRegistry } from './intents.js';

const T0 = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const KEY = 'entry:cycle-1' as IdempotencyKey;
const I1 = '00000001-0000-4000-8000-000000000000' as Uuid;
const I2 = '00000002-0000-4000-8000-000000000000' as Uuid;

describe('executor idempotency over the durable journal (D12, §6.13; INV-04)', () => {
  it('a redelivered key after a crash finds the original claim whatever its state, so a second entry can never be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solmate-idem-'));
    try {
      const path = join(dir, 'executor.journal');
      const j = await ExecutorJournal.open(path, 'A', () => T0);
      const live = new IdempotencyRegistry();
      expect(live.claim(I1, KEY)).toEqual({ outcome: 'CREATED', state: 'CREATED', intentId: I1 });
      await j.append('ATTEMPT_PREPARED', 'i1', { intentId: I1, idempotencyKey: KEY });
      await j.append('ATTEMPT_SUBMITTED', 'i1', { intentId: I1, idempotencyKey: KEY, nonce: 'ab'.repeat(16) });
      // crash; redelivery on a new process
      const rebuilt = IdempotencyRegistry.fromJournal(await ExecutorJournal.load(path));
      expect(rebuilt.claim(I2, KEY)).toEqual({ outcome: 'DUPLICATE', state: 'EXECUTING', intentId: I1 });
      await j.append('ATTEMPT_RESULT', 'i1', { intentId: I1, idempotencyKey: KEY, lifecycle: 'COMPLETED' });
      const done = IdempotencyRegistry.fromJournal(await ExecutorJournal.load(path));
      expect(done.state(KEY)).toBe('COMPLETED');
      expect(done.claim(I2, KEY).outcome).toBe('DUPLICATE');
      expect(done.advance(KEY, 'EXECUTING')).toBe(false); // terminal states never move
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
