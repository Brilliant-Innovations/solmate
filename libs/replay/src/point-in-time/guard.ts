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

/**
 * How a row's observation time is treated (blueprint §18.1 fidelity levels).
 *
 *   `SOURCE_TIME` — Level A, reconstructed history. A row is visible from its source time (bucket
 *   close plus availability lag, or first-seen). `observedAt` bounds the run only at the dataset
 *   cutoff. This is honest about what it is: a reconstruction, not a recording of what the system
 *   knew.
 *
 *   `OBSERVED_TIME` — Level B, captured market. A row is visible only once the system had actually
 *   observed it, so a backfilled candle written an hour after its bucket is invisible for that hour.
 *
 * Comparing `observedAt` only against the dataset cutoff — which the role sets to request time,
 * always at or after the window end — can never reject anything the source-time clause already
 * accepted, so a Level B label bought nothing (adversarial review 2026-09-09, H-1). Against the
 * hosted evidence window, 98% of 1m candles were observed more than five minutes after their
 * bucket and 77% more than an hour after, so the distinction is the whole difference between the
 * two levels rather than an edge case.
 */
export type ObservationDiscipline = 'SOURCE_TIME' | 'OBSERVED_TIME';

export interface GuardContext {
  clock: Clock;
  /** §18.5: no observation after this instant is readable by the run. */
  datasetCutoff: Instant;
  /** §18.1: whether a row is visible from its source time or only from when it was observed. */
  observationDiscipline: ObservationDiscipline;
}

/** The fidelity level a run declares decides the discipline; nothing else may set it. */
export function disciplineFor(fidelity: 'A_HISTORICAL' | 'B_CAPTURED' | 'C_LIVE_PAPER'): ObservationDiscipline {
  return fidelity === 'A_HISTORICAL' ? 'SOURCE_TIME' : 'OBSERVED_TIME';
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
 * A row's observation time never lets it be read before the run's dataset cutoff, and under
 * `OBSERVED_TIME` never before the simulated moment either. A row with no `observedAt` is bounded
 * by its source time alone — the dataset loader is what decides whether that is acceptable for the
 * declared fidelity level.
 */
function observationVisible(observedAt: Instant | undefined, until: Instant, ctx: GuardContext): boolean {
  if (observedAt === undefined) return true;
  const at = instantToMs(observedAt);
  if (at > instantToMs(ctx.datasetCutoff)) return false;
  return ctx.observationDiscipline === 'SOURCE_TIME' || at <= instantToMs(until);
}

/**
 * Rows first seen at or before `until`, which itself must not lie in the future. Rows observed
 * after the dataset cutoff are dropped even when their source time is inside the window
 * (a backfilled candle observed after the cutoff is not something the run could have known), and
 * under `OBSERVED_TIME` rows observed after `until` are dropped as well.
 */
export function guardedRows<T extends FirstSeen & Partial<Observed>>(reader: string, rows: readonly T[], until: Instant, ctx: GuardContext): T[] {
  assertReadable(reader, until, ctx);
  return rows.filter((r) => eventVisibleAt(r, until) && observationVisible(r.observedAt, until, ctx));
}

export function guardedCandles<T extends Bucket & Partial<Observed>>(reader: string, candles: readonly T[], resolutionMs: number, availabilityLagMs: number, until: Instant, ctx: GuardContext): T[] {
  assertReadable(reader, until, ctx);
  return candles.filter((c) => candleVisibleAt(c, resolutionMs, availabilityLagMs, until) && observationVisible(c.observedAt, until, ctx));
}

/**
 * How much of a candle series the observation discipline actually hides, so a run can report
 * whether its dataset supports the fidelity level it claims instead of asserting it. `hidden` is
 * the count of candles whose observation lands after the moment their source time would have made
 * them visible.
 */
export function observationLagReport<T extends Bucket & Partial<Observed>>(candles: readonly T[], resolutionMs: number, availabilityLagMs: number): { total: number; withObservedAt: number; lateObserved: number; medianLagMs: number | null; maxLagMs: number | null } {
  const lags: number[] = [];
  let withObservedAt = 0;
  for (const c of candles) {
    if (c.observedAt === undefined) continue;
    withObservedAt++;
    const availableAt = instantToMs(c.bucketTime) + resolutionMs + availabilityLagMs;
    const lag = instantToMs(c.observedAt) - availableAt;
    if (lag > 0) lags.push(lag);
  }
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    total: candles.length,
    withObservedAt,
    lateObserved: lags.length,
    medianLagMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
    maxLagMs: sorted.length ? sorted[sorted.length - 1]! : null,
  };
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
    // Live reads what it has actually observed by definition, so the strict discipline is the
    // right one and costs nothing: a row observed after now cannot exist.
    observationDiscipline: "OBSERVED_TIME",
  };
}
