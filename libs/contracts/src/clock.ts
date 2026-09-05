import { Instant } from './primitives.js';

/**
 * Point-in-time clock (blueprint §18.2). Production uses `systemClock`; replay supplies a
 * simulated clock from `libs/replay`. Strategy, agent, signal and replay code must read time
 * from a Clock and never call `Date.now()` directly (lint rule `no-restricted-properties`).
 */
export interface Clock {
  /** Current instant as an ISO 8601 UTC string. */
  now(): Instant;
  /** Current instant as epoch milliseconds. */
  nowMs(): number;
}

export function toInstant(value: Date | number): Instant {
  const d = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) throw new RangeError('toInstant: invalid date');
  return Instant.parse(d.toISOString());
}

export function instantToMs(instant: Instant): number {
  return Date.parse(instant);
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareInstants(a: Instant, b: Instant): number {
  return instantToMs(a) - instantToMs(b);
}

export function addMs(instant: Instant, ms: number): Instant {
  return toInstant(instantToMs(instant) + ms);
}

export const systemClock: Clock = {
  now: () => toInstant(Date.now()),
  nowMs: () => Date.now(),
};

/** A clock frozen at one instant. Useful for tests and for stamping a whole batch consistently. */
export function fixedClock(at: Instant): Clock {
  const ms = instantToMs(at);
  return { now: () => at, nowMs: () => ms };
}
