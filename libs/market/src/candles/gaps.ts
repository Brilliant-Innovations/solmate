import { addMs, instantToMs, toInstant, type CandleGap, type CandleResolution, type Instant } from '@sol-agent-trader/contracts';
import { bucketsBetween, RESOLUTION_MS } from './resolution.js';

/**
 * Gap detection and backfill planning (P1 acceptance "reconnect/backfill prevents obvious candle
 * gaps"; D63 backfill tagging). Pure functions over bucket times.
 */

/** Missing buckets in [from, to] given the bucket times we already hold, merged into runs. */
export function findCandleGaps(existing: readonly Instant[], resolution: CandleResolution, from: Instant, to: Instant): CandleGap[] {
  const have = new Set(existing.map((i) => instantToMs(i)));
  const ms = RESOLUTION_MS[resolution];
  const gaps: CandleGap[] = [];
  let runStart: number | null = null;
  let runCount = 0;
  const close = (lastMissing: number) => {
    if (runStart !== null) gaps.push({ resolution, from: toInstant(runStart), to: toInstant(lastMissing), missingBuckets: runCount });
    runStart = null;
    runCount = 0;
  };
  let prev = 0;
  for (const b of bucketsBetween(from, to, resolution)) {
    const t = instantToMs(b);
    if (have.has(t)) close(prev);
    else {
      if (runStart === null) runStart = t;
      runCount++;
    }
    prev = t;
  }
  close(prev);
  return gaps.filter((g) => g.missingBuckets > 0 && instantToMs(g.to) - instantToMs(g.from) === (g.missingBuckets - 1) * ms);
}

export interface BackfillRequest {
  resolution: CandleResolution;
  /** Inclusive first bucket start. */
  from: Instant;
  /** Exclusive end: the start of the bucket after the last wanted one. */
  to: Instant;
  buckets: number;
}

/** Split gaps into provider requests of at most `maxItems` buckets each. */
export function planBackfill(gaps: readonly CandleGap[], maxItems: number): BackfillRequest[] {
  if (!(maxItems > 0)) throw new RangeError('maxItems must be > 0');
  const out: BackfillRequest[] = [];
  for (const g of gaps) {
    const ms = RESOLUTION_MS[g.resolution];
    let start = instantToMs(g.from);
    let remaining = g.missingBuckets;
    while (remaining > 0) {
      const n = Math.min(remaining, maxItems);
      out.push({ resolution: g.resolution, from: toInstant(start), to: toInstant(start + n * ms), buckets: n });
      start += n * ms;
      remaining -= n;
    }
  }
  return out;
}

/** Warm-up requirement (D63): the range of closed buckets an indicator needs before `now`. */
export function warmupRange(now: Instant, resolution: CandleResolution, lookbackBuckets: number): { from: Instant; to: Instant } {
  const ms = RESOLUTION_MS[resolution];
  const lastClosed = Math.floor(instantToMs(now) / ms) * ms - ms;
  return { from: toInstant(lastClosed - (lookbackBuckets - 1) * ms), to: addMs(toInstant(lastClosed), 0) };
}
