import type { AuditCheckpoint, Instant, Sequence, Sha256Hex } from '@sol-agent-trader/contracts';
import { chainStandingCacheKey } from './audit.js';

/**
 * DEFECT-3 (2026-09-09). The risk-authorizer caches its chain-standing verdict, and that verdict is a
 * statement about two stores at once: the ledger in Postgres and the external checkpoint replica the
 * worker writes (ADR-0009 P2). It used to be keyed on the ledger head hash alone, so while the ledger
 * was quiet the replica could be truncated, deleted or replaced without the cached `ok: true` ever
 * being revisited — the control could not see the thing it exists to check.
 *
 * These cases are about identity only. The TTL that bounds a matching key is the caller's, and the
 * verification itself is covered by `audit.integration.spec.ts`.
 */
const HEAD_A = 'aa'.repeat(32);
const HEAD_B = 'bb'.repeat(32);
const cp = (sequence: number, hash: string): AuditCheckpoint => ({ sequence: sequence as Sequence, hash: hash as Sha256Hex, checkpointedAt: '2026-09-05T12:00:00.000Z' as Instant, replicatedTo: [] });

describe('chain-standing cache identity (ADR-0009 P2, DEFECT-3)', () => {
  it('is stable only while both stores are unchanged', () => {
    const key = chainStandingCacheKey(HEAD_A, cp(10, HEAD_A));
    expect(chainStandingCacheKey(HEAD_A, cp(10, HEAD_A))).toBe(key);
    // the ledger moved
    expect(chainStandingCacheKey(HEAD_B, cp(10, HEAD_A))).not.toBe(key);
    // the replica advanced to a new checkpoint
    expect(chainStandingCacheKey(HEAD_A, cp(11, HEAD_A))).not.toBe(key);
    // the replica kept its sequence but its content changed: a rewritten or replaced file
    expect(chainStandingCacheKey(HEAD_A, cp(10, HEAD_B))).not.toBe(key);
  });

  it('a replica that has gone missing keys differently from one that is present, so its loss cannot hide behind a quiet ledger', () => {
    // The case that motivated the fix: the ledger head does not move, and under the old key that was
    // the whole key, so a deleted or unreadable replica returned the previous verdict indefinitely.
    expect(chainStandingCacheKey(HEAD_A, null)).not.toBe(chainStandingCacheKey(HEAD_A, cp(10, HEAD_A)));
    // and an absent replica is at least self-consistent, so it does not thrash the cache
    expect(chainStandingCacheKey(HEAD_A, null)).toBe(chainStandingCacheKey(HEAD_A, null));
  });

  it('does not let a sequence/hash boundary collide: 1|"0:x" and 10|"" are different keys', () => {
    // Cheap guard against a delimiter mistake turning two distinct states into one cache entry.
    expect(chainStandingCacheKey(HEAD_A, cp(1, '0'))).not.toBe(chainStandingCacheKey(HEAD_A, cp(10, '')));
  });
});
