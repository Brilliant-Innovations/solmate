import { addMs, instantToMs, toInstant, type CandleResolution, type Instant } from '@sol-agent-trader/contracts';

export const RESOLUTION_MS: Readonly<Record<CandleResolution, number>> = {
  '15s': 15_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/** Start of the bucket containing `at`. */
export function alignBucket(at: Instant, resolution: CandleResolution): Instant {
  const ms = RESOLUTION_MS[resolution];
  return toInstant(Math.floor(instantToMs(at) / ms) * ms);
}

export function isAligned(at: Instant, resolution: CandleResolution): boolean {
  return instantToMs(at) % RESOLUTION_MS[resolution] === 0;
}

/** Every bucket start in [from, to] inclusive, both aligned. */
export function bucketsBetween(from: Instant, to: Instant, resolution: CandleResolution): Instant[] {
  const ms = RESOLUTION_MS[resolution];
  const start = instantToMs(alignBucket(from, resolution));
  const end = instantToMs(alignBucket(to, resolution));
  const out: Instant[] = [];
  for (let t = start; t <= end; t += ms) out.push(toInstant(t));
  return out;
}

/** The last bucket that is fully closed at `now` (its end is at or before now). */
export function lastClosedBucket(now: Instant, resolution: CandleResolution): Instant {
  const ms = RESOLUTION_MS[resolution];
  return addMs(alignBucket(now, resolution), -ms);
}
