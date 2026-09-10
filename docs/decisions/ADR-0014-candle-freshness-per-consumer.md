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

**The divisor is a convention, not a result, and a reviewer should know which.** It is fitted to a
single observed pair — (90 s, 15 min) — and one point determines a ratio, not a law. Nothing here
establishes that a tenth is the right fraction for a four-hour window; it establishes only that the
value already in the codebase is consistent with a tenth of the momentum window. Keeping it is
reasonable and it is what this ADR proposes, but it is adopted, not derived, and if a reviewer wants
it changed the argument should be about error tolerance in the indicators, not about this ADR's
arithmetic. Stated here so it is accepted knowingly rather than discovered later.

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
  five-minute window. **A cost-motivated document does not make the system more expensive, and this one
  does — twice.** It tightens the screening bound past what the current architecture can satisfy at
  any price, and it opens an exit-path question whose complete answer costs $99–199/month for a
  handful of positions. Every number in it moves away from the cheap outcome. That is the strongest
  evidence available that the derivation drove the conclusion rather than the reverse, and it is
  stated here explicitly because the first draft of this ADR *was* written under budget pressure and
  had to be withdrawn.
- **It withdraws its own original claim** that 90 s was wrong, on an argument the operator supplied.
- **It rejects both cheaper candidates** — 45 min and `candidateTtlMs` — as category errors.
- **The per-asset check it adds creates new refusals**, and landed before the decision rather than
  after it.

The honest residual is unchanged: this began in a session that wanted the budget to be smaller.

## The arithmetic that makes 30 s unsatisfiable, not merely expensive

Check this in thirty seconds rather than taking it on trust. A bucket is usable only once closed
(`libs/signals/src/features/engine.ts`, both `newestClosedBar` and `contiguousClosedBars`):

```ts
if (t + MINUTE <= cutoff)   // t is the bucket's start
```

So for the newest usable bucket, `t <= now − 60_000`, and input age is defined as `now − t`.
Therefore:

> **With 1-minute candles, input age is ≥ 60 s always.** Generally, with resolution `R`, minimum
> input age is exactly `R`.

A bound `B` is therefore satisfiable only when `R ≤ B`, and no request rate, provider tier or amount
of money changes that — it is a property of bucketing, not of budget. Two consequences:

- **`EARLY_ACCELERATION`'s derived 30 s bound cannot be met on 1m candles at any price.** Applied as
  written it would refuse 100% of candidates, permanently. This is the architecture finding, and it
  should be read before anyone tries to run S0 under the function, not discovered afterwards.
- Holding age ≤ `B` additionally requires refreshing at least every `B − R`, which is the part money
  *can* buy. Both conditions bind; the first one is the one that cannot be bought.

15 s candles (`R = 15_000`) already exist in the codebase and would make 30 s reachable. They are
classified `POSITION` only (`RESOLUTIONS` in `market-ingest.ts`), which is the next section.

## What happens when the requirement cannot be met

The requirement does not change because the data cannot meet it. It gets **recorded as unmet**.

Explicitly rejected: reshaping the formula as `max(R, window ÷ 10)` so the bound becomes satisfiable
by construction. That would make every deployment compliant by definition and is the rationalization
pattern wearing a derivation — the same shape as widening a limit to fit a tier, which is what
ADR-0011 exists to forbid.

So every decision records **three quantities**, not a boolean:

| Quantity | Meaning |
| --- | --- |
| `requiredInputAgeMs` | the derived bound for the consuming trigger (window ÷ 10) |
| `attainedInputAgeMs` | `now − newestInputAt`, what the data actually was |
| ratio | `attained ÷ required` — 1.0 or below is compliant, above it is degraded and by how much |

`EARLY_ACCELERATION` on 1m candles then runs at a ratio of roughly **2.0** — a declared, measured
degradation attached to every decision it produced, rather than a silent pass or a permanent refusal.
Evaluation can stratify on the ratio instead of being blocked by a stratum that is structurally empty,
and the degradation is visible on the decisions themselves rather than reconstructed afterwards.

**A third option, which is fail-closed and should be weighed before the second.** The choice is not
only "silent pass or permanent refusal": a trigger whose data cannot support it need not run. Not
running `EARLY_ACCELERATION` on 1m data refuses nothing at decision time, weakens no `BLOCK`, and
needs no degradation accounting — the trigger is simply not enabled on a deployment that cannot feed
it. That is the conservative reading and it is available.

Which matters because **recording-and-continuing does weaken a block for that trigger**, and the
weakening should be named rather than absorbed into the reporting change. A reader should be able to
see that this ADR proposes letting a trigger run outside its own stated tolerance, however well
measured. The two options also interact with the evaluation's control-arm choice below: if the
baseline is defined on the momentum trigger, `EARLY_ACCELERATION` is not in the comparison at all and
the question is moot for evaluation purposes, though not for live operation.

## Consequence for the evaluation's control arm

Recorded here because the derivation forces it, not because it is a freshness question.

If `EARLY_ACCELERATION` runs at ratio ~2.0 on 1m data while the LLM strategies read momentum at 90 s —
which the 60 s floor *does* satisfy — then a comparison of S0 against S1–S4 puts a **degraded control
against a clean treatment**, and any difference between them is confounded by data quality rather than
attributable to the thing being tested. That is not a small confound: it is the whole measurement.

Defining the evaluation's control arm on the momentum trigger compares like with like. That is a
change to what "S0" means in the comparison and it belongs in `EVALUATION.md` as a stated choice with
its reasoning, not as an incidental configuration decision discovered in a config file later.

## The exit path, which nobody derived a bound for

The same derivation applied to a consumer it was never applied to. This section is why ADR-0014 covers
the exit path rather than leaving it to a separate ADR: the reasoning is identical, only the consumer
differs.

`highSince` feeds `rHigh`, which gates whether the trailing stop activates at all. **A correction to
the record first:** an understated high cannot move the stop *down* — `evaluateExitPolicy` raises only
(`trailed > stop`) from the persisted stop, and `tightenStop` refuses anything at or below the stored
level. The stop is already monotonic in two independent places, and a proposal to persist a separate
high-water mark was built, found to be redundant against exactly that, and reverted on 2026-09-10. The
damage is a stop that **fails to rise**, not one that falls.

What the exit path's tolerance derives from is different from a screening trigger's lookback. The
monitor marks from a **live exit quote every cycle**, so any peak at a cycle boundary is already
captured by `price`. Candles add exactly one thing: peaks that occur *between* cycles. So the bound is
the monitor's own cadence:

- `POSITION_MONITOR_INTERVAL_MS` defaults to **30 s** (min 10 s).
- Resolution must satisfy `R ≤ interval`, or intra-cycle peaks exist that no bucket can reveal. 1m
  candles fail this by a factor of two; 15 s candles satisfy it.
- Held positions are single digits by construction, and `POSITION` priority is already the
  classification 15 s candles carry — so this is not a wide-universe problem and the 1m arithmetic
  above does not bind here.

**Its cost, stated rather than assumed.** "Affordable because the set is small" is too quick. One
OHLCV request covers up to 1000 buckets, so cost is per *refresh*, not per bucket: 45 CU each. At a
30 s refresh that is 2,880/day/position = **3.89 M CU/month per held position** — Starter ($99) for
one or two positions, Premium ($199) by three. Real money for a small set.

**The cheaper alternative, which should be weighed first.** The mark already comes from a Jupiter exit
quote, which costs no Birdeye compute units at all. Shortening `POSITION_MONITOR_INTERVAL_MS` toward
its 10 s floor samples that mark three times more often and attacks the "peaks between cycles"
residual directly, for nothing on this budget. It does not capture a peak *within* 10 s, which 15 s
candles also would not.

So the exit-path decision is a genuine three-way choice, and this ADR does not make it: accept the
residual, shorten the monitor interval (cheap, partial), or buy 15 s candles for held positions
(complete to 15 s, and priced above). Whichever is chosen, it should be recorded with the derivation
rather than inherited from the screening number, which is how the exit path came to have no bound of
its own.

**But it does propose an order**, because two of the three are not independent:

1. **Shorten `POSITION_MONITOR_INTERVAL_MS`** toward its 10 s floor. Free on this budget, and at 10 s
   it is a *strictly better* cadence than 15 s candles would provide.
2. **Re-run the measurement** — the same 1,677 asset-hour method, against the new cadence — and see
   what residual is left.
3. **Then** decide whether the residual justifies Premium.

Buying a tier to close a gap that has not been re-measured after a free fix is the wrong order, and it
is the same error as the run-rate arithmetic that opened WP1: acting on a number whose denominator had
not been checked.

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
