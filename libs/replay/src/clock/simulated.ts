import { instantToMs, toInstant, type Clock, type Instant } from '@sol-agent-trader/contracts';

/**
 * Replay clock (blueprint §18.2). Strategy, signal, risk and skill code read time from a `Clock`;
 * production supplies the wall clock and replay supplies this one. Simulated time only moves
 * forward: a step backwards would let a later read pretend to be earlier, so it is an error, not
 * a no-op.
 */
export class ReplayClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayClockError';
  }
}

export class SimulatedClock implements Clock {
  private ms: number;

  constructor(start: Instant) {
    this.ms = instantToMs(start);
  }

  now(): Instant {
    return toInstant(this.ms);
  }

  nowMs(): number {
    return this.ms;
  }

  /** Moves to `instant`; equal is allowed (re-reading the same moment), earlier is refused. */
  advanceTo(instant: Instant): void {
    const target = instantToMs(instant);
    if (target < this.ms) throw new ReplayClockError(`replay clock cannot move backwards: ${this.now()} → ${instant}`);
    this.ms = target;
  }

  advanceBy(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new ReplayClockError(`replay clock cannot advance by ${ms}ms`);
    this.ms += ms;
  }
}

/** Every instant from `from` to `to` inclusive at `stepMs` spacing; the engine's tick schedule. */
export function* ticks(from: Instant, to: Instant, stepMs: number): Generator<Instant> {
  if (stepMs <= 0) throw new ReplayClockError(`tick step must be positive, got ${stepMs}`);
  const end = instantToMs(to);
  for (let t = instantToMs(from); t <= end; t += stepMs) yield toInstant(t);
}
