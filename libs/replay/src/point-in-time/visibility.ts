import { instantToMs, type Instant } from '@sol-agent-trader/contracts';

/**
 * Point-in-time visibility (blueprint §18.3; INV-13 "No strategy sees evidence from the future in
 * replay"). Every replay read passes through these rules with the simulated clock:
 *   - an event is visible only once `firstSeenAt <= now` (source time never makes it visible earlier);
 *   - a candle bucket is visible only after its close plus the configured availability lag;
 *   - a label or security record is visible only after it was first observed;
 *   - revised metadata never replaces what was known at the time (callers keep the original row).
 * The rules are pure so the same code guards the production query layer and the replay harness.
 */

export interface FirstSeen {
  firstSeenAt: Instant;
}

export function eventVisibleAt<T extends FirstSeen>(event: T, now: Instant): boolean {
  return instantToMs(event.firstSeenAt) <= instantToMs(now);
}

export function visibleEvents<T extends FirstSeen>(events: readonly T[], now: Instant): T[] {
  return events.filter((e) => eventVisibleAt(e, now));
}

export interface Bucket {
  bucketTime: Instant;
}

/** A bucket is closed at bucketTime + resolutionMs and available availabilityLagMs after that. */
export function candleVisibleAt<T extends Bucket>(candle: T, resolutionMs: number, availabilityLagMs: number, now: Instant): boolean {
  return instantToMs(candle.bucketTime) + resolutionMs + availabilityLagMs <= instantToMs(now);
}

export function visibleCandles<T extends Bucket>(candles: readonly T[], resolutionMs: number, availabilityLagMs: number, now: Instant): T[] {
  return candles.filter((c) => candleVisibleAt(c, resolutionMs, availabilityLagMs, now));
}

export interface ObservedLabel {
  firstSeenAt: Instant;
}

/** A wallet label or security read counts only from when it was first observed; a later classification is not evidence for an earlier decision. */
export function labelVisibleAt<T extends ObservedLabel>(label: T, now: Instant): boolean {
  return instantToMs(label.firstSeenAt) <= instantToMs(now);
}
