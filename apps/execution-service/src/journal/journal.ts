import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalHash, ExecutorJournalEntry, type ExecutorJournalKind, type Instant, type JsonRecord, type Nonce, type Sequence, type Sha256Hex } from '@sol-agent-trader/contracts';

/**
 * Executor-local durable journal (blueprint §15.10, D12, D22; ADR-0009 P4; INV-04, INV-23).
 * Append-only JSON lines, hash-chained through `canonicalHash`, fsync-free by design but written
 * before any network submission so a process that dies after signing still knows what it signed.
 * A fencing token in a sidecar file makes the journal single-writer: a second executor that
 * opens the same journal with a different token is refused unless the previous holder released
 * it, and a stale holder that comes back finds its token superseded and stops writing.
 */

export const GENESIS_HASH = '0'.repeat(64) as Sha256Hex;

export interface JournalLock {
  token: string;
  acquiredAt: Instant;
  released: boolean;
}

export class FencingError extends Error {
  constructor(readonly holder: string, readonly attempted: string) {
    super(`journal is fenced by ${holder}; ${attempted} may not write`);
    this.name = 'FencingError';
  }
}

export class JournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptError';
  }
}

export class ExecutorJournal {
  private entries: ExecutorJournalEntry[] = [];
  private constructor(
    readonly path: string,
    readonly token: string,
    private readonly now: () => Instant,
  ) {}

  /** Opens (creating if absent), validates the chain, acquires the fence. */
  static async open(path: string, token: string, now: () => Instant): Promise<ExecutorJournal> {
    mkdirSync(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as JournalLock;
      if (!lock.released && lock.token !== token) throw new FencingError(lock.token, token);
    }
    writeFileSync(lockPath, JSON.stringify({ token, acquiredAt: now(), released: false } satisfies JournalLock));
    const j = new ExecutorJournal(path, token, now);
    j.entries = await ExecutorJournal.load(path);
    return j;
  }

  /** Replays the file and re-derives every hash: a line edited in place, reordered or dropped fails here, never later. */
  static async load(path: string): Promise<ExecutorJournalEntry[]> {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    const out: ExecutorJournalEntry[] = [];
    let previous = GENESIS_HASH;
    let expectedSeq = 0;
    for (const line of lines) {
      const parsed = ExecutorJournalEntry.safeParse(JSON.parse(line));
      if (!parsed.success) throw new JournalCorruptError(`malformed entry after sequence ${expectedSeq - 1}`);
      const e = parsed.data;
      if (e.sequence !== expectedSeq) throw new JournalCorruptError(`sequence gap: expected ${expectedSeq}, found ${e.sequence}`);
      if (e.previousHash !== previous) throw new JournalCorruptError(`chain broken at sequence ${e.sequence}`);
      const { hash, ...body } = e;
      if (hash !== (await canonicalHash(body))) throw new JournalCorruptError(`hash mismatch at sequence ${e.sequence}`);
      out.push(e);
      previous = e.hash;
      expectedSeq++;
    }
    return out;
  }

  private assertFenced(): void {
    const lockPath = `${this.path}.lock`;
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as JournalLock;
    if (lock.token !== this.token) throw new FencingError(lock.token, this.token);
  }

  async append(kind: ExecutorJournalKind, correlationId: string, payload: JsonRecord): Promise<ExecutorJournalEntry> {
    this.assertFenced();
    const previousHash = this.entries.at(-1)?.hash ?? GENESIS_HASH;
    const body = { sequence: this.entries.length as Sequence, at: this.now(), kind, correlationId, payload, previousHash };
    const hash = await canonicalHash(body);
    const entry: ExecutorJournalEntry = { ...body, hash };
    // The line is durable before the caller may submit anything (D12).
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    return entry;
  }

  release(): void {
    const lockPath = `${this.path}.lock`;
    writeFileSync(lockPath, JSON.stringify({ token: this.token, acquiredAt: this.now(), released: true } satisfies JournalLock));
  }

  all(): readonly ExecutorJournalEntry[] {
    return this.entries;
  }

  /** Nonces this executor has already acted on: replay protection survives restarts. */
  usedNonces(): Set<Nonce> {
    const out = new Set<Nonce>();
    for (const e of this.entries) {
      const n = e.payload['nonce'];
      if (typeof n === 'string' && (e.kind === 'ATTEMPT_SIGNED' || e.kind === 'ATTEMPT_SUBMITTED')) out.add(n as Nonce);
    }
    return out;
  }

  /** Attempts signed or submitted with no result yet: what a restart must reconcile before new work (§21.3). */
  unresolvedAttempts(): { correlationId: string; lastKind: ExecutorJournalKind; signedTxHash: string | null; expectedTxSignature: string | null }[] {
    const last = new Map<string, ExecutorJournalEntry>();
    for (const e of this.entries) if (e.kind === 'ATTEMPT_SIGNED' || e.kind === 'ATTEMPT_SUBMITTED' || e.kind === 'ATTEMPT_RESULT') last.set(e.correlationId, e);
    return [...last.values()]
      .filter((e) => e.kind !== 'ATTEMPT_RESULT')
      .map((e) => ({ correlationId: e.correlationId, lastKind: e.kind, signedTxHash: (e.payload['signedTxHash'] as string | null) ?? null, expectedTxSignature: (e.payload['expectedTxSignature'] as string | null) ?? null }));
  }
}
