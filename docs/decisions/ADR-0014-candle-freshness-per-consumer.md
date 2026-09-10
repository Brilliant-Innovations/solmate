# ADR-0014 — Candle freshness is a function of the consuming trigger's window, not a constant per data class

**Status:** Proposed — operator decision required. Item 3 (the per-asset check) was implemented separately on 2026-09-09 because it holds under every option here.
**Date:** 2026-09-09 (revised the same day; the first draft's central claim is withdrawn — see "What this ADR no longer claims")
**Class (§31 taxonomy):** DEFECT (a class-level constant cannot express a per-trigger, per-asset quantity; the entry path has no per-asset input-age check at all)
**Blueprint text affected:** §21.1, §21.2
**§31-protected decision affected:** "critical stale data fails closed for entries" — this proposal **tightens** it. See "Why this is not the forbidden shortcut."
**Refines:** ADR-0011 (the `CANDLES` row of `FRESHNESS_REQUIREMENTS`; everything else in ADR-0011 stands unchanged)

## What this ADR no longer claims

The first draft argued that 90 s was the wrong number and that the bound should be re-derived, in a
session that had just measured a budget shortfall. The operator's response killed that argument and it
is withdrawn rather than edited away:

> The 15 min ÷ 10 derivation is strong, and it weakens my "the number is wrong" position
> considerably. But I don't think either candidate number is right, because both are constants.

**90 seconds stands for momentum.** What is wrong is not the value but its *type*: a constant per data
class, where the principled quantity is a function of the window the consuming trigger actually reads.

`candidateTtlMs` (10 min) is also rejected as a candidate, on the operator's reasoning: ten minutes is
how long a made candidate may *sit*, which is the same category error this ADR already rejects for
forty-five minutes. It measures the wrong thing, just less wrongly.

## The proposed quantity

> Input-age tolerance = (shortest analytic window the consuming trigger reads) ÷ 10.

Not because a tenth is magic, but because it is the tolerance already implicit in today's value, and
making it explicit is what lets it vary correctly: a 10% error on a four-hour window is a different
number from 10% of fifteen minutes.

Computed from the trigger policies as they stand (`libs/contracts/src/policy/candidates.ts`):

| Trigger | Shortest window it reads | Derived tolerance | vs today's flat 90 s |
| --- | --- | --- | --- |
| `EARLY_ACCELERATION` | `minReturnAccel5m` — 5 min | **30 s** | **stricter** |
| `MOMENTUM_CONTINUATION` | `minReturn15m` — 15 min | **90 s** | unchanged |
| `CATALYST_RESPONSE` | `minReturn15m` — 15 min | **90 s** | unchanged |
| `HOLDER_LIQUIDITY_EXPANSION` (hybrid) | `alignmentWindowMs` — 30 min | **180 s** | looser |

The deployment's effective bound is the strictest trigger in force. S0 runs both
`MOMENTUM_CONTINUATION` and `EARLY_ACCELERATION`, so **applying this function tightens the effective
candle bound from 90 s to 30 s.**

That is the answer to the question of whether this is cost-motivated. It is not: the principled shape
makes the system *more* expensive, not less. Any relief the slower triggers get is a consequence of
the derivation rather than a motive for it, which is the only form of relief worth having.

## Evidence: the fourth consumer, measured

The first draft noted that `highSince` reads candles for the trailing high-water mark and that a stale
candle understates the high, putting the trailing stop lower — "bounded, but bounded by *you lose
more*". That is now a number rather than a description.

Method: at each hourly instant `T` across the observation window, for every eligible asset, compare
the high we **knew** (candles with `observed_at <= T`, which is what `highSince` reads) against the
high that was **true** (candles whose bucket had closed by `T`). 1,677 (asset, hour) observations:

| | |
| --- | --- |
| Knew nothing at all — `highSince` returns null, `high` falls back to `max(price, entry)` | **170 (10.1%)** |
| Mean shortfall in the trailing high | 0.62% |
| Shortfall > 1% | 110 (6.6%) |
| Shortfall > 5% | 52 (3.1%) |
| **Worst observed shortfall** | **56.01%** |

Because the trailing level is a fixed fraction below that high, a 56% understated high puts the
trailing stop 56% lower than the policy intends — the position runs that much further down before the
stop fires. It is bounded by the current price and the entry, so it is a degradation and not a hole,
but the bound is "you lose more", and it was reached in this dataset.

Caveats stated rather than buried: hourly sample points, 43 eligible assets, a 2.17-day window, and
the ingestion that produced it was the broken one. The shape is evidence; the exact percentages are
not a forecast.

## Decision proposed

1. **Replace the single `CANDLES` row with a per-consumer requirement**, the signal-input leg derived
   by the function above from the trigger bound to the Release, and the trailing-high leg treated as
   its own requirement rather than inheriting the signal number by accident.
2. **Remove execution price and exit marking from the candle bound's stated scope.** They are bounded
   by a live quote at `maxQuoteAgeMs` 15 s (`QUOTE_STALE`, `libs/risk/src/rules/entry.ts:115`) and by
   `exitQuote` at the full quantity respectively, and read no candles. This is a documentation
   correction; nothing changes in behaviour.
3. **~~Add a per-asset input-age check at the candidate.~~ Done 2026-09-09**, ahead of this decision,
   because it holds whether the bound lands at 30 s, 90 s or ten minutes — and because it gets *more*
   necessary after the WP1b narrowing, not less: a class-level row reading newest-across-the-set is
   easiest to satisfy when the set is small and one asset is active.
4. **Keep every existing `effectOnEntries: BLOCK`.** Nothing here proposes that stale data stop
   failing closed.

## Why this is not the forbidden shortcut

ADR-0011 exists because of operator review item 12 — *"unacceptable shortcut: widening freshness
limits merely to fit the purchased tier"* — and records the §31 decision as strengthened, not
weakened. Four checks:

- **The proposal tightens the effective bound**, 90 s → 30 s, because `EARLY_ACCELERATION` reads a
  five-minute window. A cost-motivated document does not do that.
- **It withdraws its own original claim** that 90 s was wrong, on an argument the operator supplied.
- **It rejects both cheaper candidates** — 45 min and `candidateTtlMs` — as category errors.
- **The per-asset check it adds creates new refusals**, and landed before the decision rather than
  after it.

The honest residual is unchanged: this began in a session that wanted the budget to be smaller.

## A gap this exposed: no §24.6 invariant owns freshness

`node tools/check-invariant-map.mjs` reported **28 of 28 mapped and green throughout** the entire
period in which `BIRDEYE:CANDLES` reported HEALTHY over five-hour-old data and ADR-0011's `BLOCK`
could not fire. It was not wrong: none of the blueprint's 28 invariants owns
`libs/market/src/freshness/`, `libs/strategies/src/s0/gate.ts` or `libs/signals/src/features/engine.ts`.
There is no invariant of the form *"no decision is taken on inputs older than the bound for their
class"* — the property that just failed for a day.

Adding a 29th is not this session's to do: the set is blueprint §24.6 and the checker enforces its
size, correctly. It is recorded here because a green invariant map was one of the reasons this went
unnoticed, and because review #1 should know that the map's greenness says nothing about freshness.

## Consequences if accepted

The uncomfortable conclusion, stated plainly: for momentum, **90 seconds stands; REST polling cannot
meet it at scale; and the answer is a single-digit universe or an architecture change, not a relaxed
bound.** With `EARLY_ACCELERATION` in force it is 30 s, which is harder still. `FRESHNESS_REQUIREMENTS`
gains per-consumer rows keyed by the Release's trigger set; the contract lock regenerates.

## Consequences if rejected

The flat 90 s stays, `EARLY_ACCELERATION` continues to run on a bound three times looser than its own
window justifies, and the trailing-high leg keeps inheriting a number that was never derived for it.
The per-asset check (item 3) stays either way.
