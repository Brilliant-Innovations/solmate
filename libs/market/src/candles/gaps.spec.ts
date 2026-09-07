import fc from 'fast-check';
import { addMs, instantToMs, toInstant, type CandleResolution, type Instant } from '@sol-agent-trader/contracts';
import { findCandleGaps, planBackfill, warmupRange } from './gaps.js';
import { alignBucket, bucketsBetween, lastClosedBucket, RESOLUTION_MS } from './resolution.js';

const T0 = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));

describe('candle gaps and backfill planning (P1 "no obvious candle gaps", D63)', () => {
  it('finds exactly the missing buckets, merged into runs', () => {
    const buckets = bucketsBetween(T0, addMs(T0, 9 * 60_000), '1m');
    const have = buckets.filter((_, i) => ![2, 3, 7].includes(i));
    const gaps = findCandleGaps(have, '1m', T0, addMs(T0, 9 * 60_000));
    expect(gaps).toEqual([
      { resolution: '1m', from: buckets[2], to: buckets[3], missingBuckets: 2 },
      { resolution: '1m', from: buckets[7], to: buckets[7], missingBuckets: 1 },
    ]);
  });

  it('property: gaps ∪ held == every bucket in range, and gaps are disjoint from held', () => {
    fc.assert(
      fc.property(fc.constantFrom<CandleResolution>('15s', '1m', '5m', '1h'), fc.integer({ min: 1, max: 200 }), fc.array(fc.integer({ min: 0, max: 199 }), { maxLength: 200 }), (res, n, heldIdx) => {
        const ms = RESOLUTION_MS[res];
        const to = addMs(T0, (n - 1) * ms);
        const all = bucketsBetween(T0, to, res);
        const held = [...new Set(heldIdx.filter((i) => i < n))].map((i) => all[i] as Instant);
        const gaps = findCandleGaps(held, res, T0, to);
        const covered = new Set<number>(held.map(instantToMs));
        for (const g of gaps) {
          for (let t = instantToMs(g.from); t <= instantToMs(g.to); t += ms) {
            expect(covered.has(t)).toBe(false);
            covered.add(t);
          }
          expect((instantToMs(g.to) - instantToMs(g.from)) / ms + 1).toBe(g.missingBuckets);
        }
        expect(covered.size).toBe(n);
      }),
    );
  });

  it('splits large gaps into provider-sized requests that tile the gap exactly', () => {
    const gap = { resolution: '1m' as const, from: T0, to: addMs(T0, 11_999 * 60_000), missingBuckets: 12_000 };
    const reqs = planBackfill([gap], 5000);
    expect(reqs.map((r) => r.buckets)).toEqual([5000, 5000, 2000]);
    expect(reqs[0]?.from).toBe(T0);
    expect(reqs[2]?.to).toBe(addMs(T0, 12_000 * 60_000));
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]?.from).toBe(reqs[i - 1]?.to);
  });

  it('warm-up ranges end at the last closed bucket, never the open one', () => {
    const now = toInstant(Date.UTC(2026, 8, 6, 12, 7, 30));
    expect(lastClosedBucket(now, '1m')).toBe(toInstant(Date.UTC(2026, 8, 6, 12, 6, 0)));
    expect(alignBucket(now, '5m')).toBe(toInstant(Date.UTC(2026, 8, 6, 12, 5, 0)));
    const r = warmupRange(now, '1m', 60);
    expect(r.to).toBe(toInstant(Date.UTC(2026, 8, 6, 12, 6, 0)));
    expect(r.from).toBe(toInstant(Date.UTC(2026, 8, 6, 11, 7, 0)));
  });
});
