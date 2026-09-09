import { instantToMs, type Clock, type Instant } from '@sol-agent-trader/contracts';
import { candleVisibleAt, eventVisibleAt, type Bucket, type FirstSeen } from './visibility.js';

/**
 * Look-ahead enforcement (blueprint §18.3, P9 acceptance "a replay test intentionally attempting
 * future evidence fails", INV-13). The visibility rules in `visibility.ts` say what a row's
 * availability time is; this module makes any read that asks for a later moment than the replay
 * clock fail loudly instead of returning an empty or filtered result. A silently empty answer
 * would let a strategy learn "nothing happened yet" from the future; a thrown error cannot be
 * mistaken for evidence.
 *
 * Two shapes cover every reader:
 *   - `guardedRows` for datasets the engine reads directly (events, labels, safety, probes, candles);
 *   - `guardSources` for the skill's context sources and read tools, whose calls carry `asOf`.
 */

export class LookAheadError extends Error {
  constructor(
    readonly reader: string,
    readonly requested: Instant,
    readonly now: Instant,
  ) {
    super(`look-ahead refused: ${reader} asked for ${requested} while the replay clock reads ${now}`);
    this.name = 'LookAheadError';
  }
}

export class DatasetCutoffError extends Error {
  constructor(
    readonly reader: string,
    readonly requested: Instant,
    readonly cutoff: Instant,
  ) {
    super(`dataset cutoff refused: ${reader} asked for ${requested} beyond the run's cutoff ${cutoff}`);
    this.name = 'DatasetCutoffError';
  }
}

export interface GuardContext {
  clock: Clock;
  /** §18.5: no observation after this instant is readable by the run. */
  datasetCutoff: Instant;
}

/** Refuses any request for a moment after the replay clock or after the dataset cutoff. */
export function assertReadable(reader: string, requested: Instant, ctx: GuardContext): void {
  const now = ctx.clock.now();
  if (instantToMs(requested) > instantToMs(now)) throw new LookAheadError(reader, requested, now);
  if (instantToMs(requested) > instantToMs(ctx.datasetCutoff)) throw new DatasetCutoffError(reader, requested, ctx.datasetCutoff);
}

export interface Observed {
  observedAt: Instant;
}

/**
 * Rows first seen at or before `until`, which itself must not lie in the future. Rows observed
 * after the dataset cutoff are dropped even when their source time is inside the window
 * (a backfilled candle observed after the cutoff is not something the run could have known).
 */
export function guardedRows<T extends FirstSeen & Partial<Observed>>(reader: string, rows: readonly T[], until: Instant, ctx: GuardContext): T[] {
  assertReadable(reader, until, ctx);
  const cutoff = instantToMs(ctx.datasetCutoff);
  return rows.filter((r) => eventVisibleAt(r, until) && (r.observedAt === undefined || instantToMs(r.observedAt) <= cutoff));
}

export function guardedCandles<T extends Bucket & Partial<Observed>>(reader: string, candles: readonly T[], resolutionMs: number, availabilityLagMs: number, until: Instant, ctx: GuardContext): T[] {
  assertReadable(reader, until, ctx);
  const cutoff = instantToMs(ctx.datasetCutoff);
  return candles.filter((c) => candleVisibleAt(c, resolutionMs, availabilityLagMs, until) && (c.observedAt === undefined || instantToMs(c.observedAt) <= cutoff));
}

type AnyFn = (...args: never[]) => unknown;

/**
 * Wraps an object of read functions (skill context sources, read tools, provider facades) so that
 * every call whose `asOf` argument lies after the replay clock throws before the underlying read
 * runs. `pickAsOf` names where each method carries its moment; a method it does not know is
 * refused outright, so a new source cannot slip past the guard by omission.
 */
export function guardSources<T extends Record<string, AnyFn>>(sources: T, ctx: GuardContext, pickAsOf: (method: keyof T & string, args: readonly unknown[]) => Instant | null): T {
  const out: Record<string, AnyFn> = {};
  for (const key of Object.keys(sources) as (keyof T & string)[]) {
    const fn = sources[key];
    out[key] = ((...args: unknown[]) => {
      const asOf = pickAsOf(key, args);
      if (asOf === null) throw new LookAheadError(key, ctx.clock.now(), ctx.clock.now());
      assertReadable(key, asOf, ctx);
      return (fn as unknown as (...a: unknown[]) => unknown).apply(sources, args);
    }) as AnyFn;
  }
  return out as T;
}

/**
 * Guard context for the live runtime: the "dataset cutoff" is simply now, re-read on every check,
 * so the same `guardSources` wrapper that protects replay also refuses a live tool call that asks
 * for a moment later than the wall clock (§18.3 across proposer, adversary and every skill tool).
 */
export function liveGuardContext(clock: Clock): GuardContext {
  return {
    clock,
    get datasetCutoff(): Instant {
      return clock.now();
    },
  };
}
