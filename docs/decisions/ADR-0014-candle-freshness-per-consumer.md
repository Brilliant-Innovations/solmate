# ADR-0014 — `CANDLES` freshness is one number standing in for three consumers with different tolerances

**Status:** Proposed — operator decision required, nothing implemented
**Date:** 2026-09-09
**Class (§31 taxonomy):** DEFECT (a class-level bound blocks entries on a criterion the entry path does not depend on, while the criterion it does depend on has no per-asset check at all)
**Blueprint text affected:** §21.1, §21.2
**§31-protected decision affected:** "critical stale data fails closed for entries" — this proposal must not weaken it, and §"Why this is not the forbidden shortcut" below is the part to attack.
**Supersedes in part:** ADR-0011 (the `CANDLES` row of `FRESHNESS_REQUIREMENTS` only; everything else in ADR-0011 stands)

## Why this ADR exists at all, and the objection to answer first

ADR-0011 was written because of operator review item 12: *"unacceptable shortcut: widening freshness
limits merely to fit the purchased tier."* It records the §31 decision as **"strengthened, not
weakened."**

This ADR proposes changing a freshness bound in a session that has just measured a budget shortfall.
That is exactly the shape ADR-0011 exists to forbid, and the burden of proof is therefore on this
document. **If the reasoning below does not stand on its own with the budget removed from the page,
reject it.** The operator's instruction was explicit: the reason has to be that the bound was wrong,
not that it is expensive.

## Context — what was measured

`FRESHNESS_REQUIREMENTS` (`libs/contracts/src/policy/freshness.ts`) carries one row for candles,
identical across all three speed tiers:

```
{ dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' }
```

Until 2026-09-09 that row could never fire — DEFECT-4, the evaluator measured call recency rather than
datum age. It now fires. Which makes it worth asking what it is protecting, and the answer differs by
consumer. Verified in code, not assumed:

| Consumer | What it actually reads | Its own tolerance | Does the 90 s candle bound protect it? |
| --- | --- | --- | --- |
| **Execution price** at swap time | live Jupiter quote | `DEFAULT_RISK_POLICY.maxQuoteAgeMs` = **15 s**, enforced as `QUOTE_STALE` (`libs/risk/src/rules/entry.ts:115`), plus `maxSlippageBps` | **No.** Independent, and stricter. |
| **Position exit monitoring** | `deps.exitQuote(...)` — a live exit quote at the full quantity, the executable mark (§17.2, `position-monitor.ts:81`) | same quote bounds | **No.** The safety-critical continuous price is a quote, not a candle. |
| **Trailing-stop high-water mark** | `repo.highSince(assetId, openedAt, now)` — candles | none recorded | **Partly, and in the loosening direction** — see below. |
| **Signal inputs** (features, momentum trigger) | candles | shortest analytic window `minReturn15m` = **15 min**; `candidateTtlMs` = **10 min**; strategy `maxCandidateAgeMs` 20–45 min | **This is the only consumer the bound is really about.** |

Two of the three things a reader would assume the candle bound protects are protected by something
else, and something stricter.

## The part that argues *against* simply relaxing it

Three findings cut the other way and belong in the record:

1. **90 s is probably not arbitrary.** The momentum trigger's shortest window is `minReturn15m`, and
   15 min ÷ 10 = 90 s. That is a conventional 10%-of-window tolerance, and if it was chosen that way
   it is a *derived* number that simply was not written down as derived. Nobody should relax it
   without knowing whether that is where it came from.
2. **The trailing high does use candles, with a safety consequence.** `highSince` feeds
   `high = Math.max(candleHigh ?? 0, price, averageEntryPrice)` and the trailing level is a fraction
   below that high. A stale candle **understates** the high, which puts the trailing stop **lower** —
   looser protection, not tighter. It is bounded by the current price and the entry, so it is a
   degradation rather than a hole, but it is a genuine candle-dependent safety path that the
   three-way decomposition misses.
3. **The class-level row cannot express the thing that matters.** `ops.provider_health` is one row per
   `(provider, dataClass)`. It can say "the candle feed has stopped" — the failure that has now
   happened twice — and it cannot say "this one asset is 8 hours stale while others are current."
   After the WP1b narrowing, the newest-across-the-set reading will usually be minutes old and
   `HEALTHY`, while an individual asset may be an hour stale and still produce a candidate. **The
   entry path has no per-asset input-age check whatsoever.** That is a hole, and it is a hole in the
   strengthening direction.

## Decision proposed

Not a number. A shape, with the numbers to be derived and then fixed by the operator:

1. **Split the `CANDLES` requirement by consumer** rather than by speed tier alone. At minimum:
   `SIGNAL_INPUT` (features and triggers), and `TRAILING_HIGH` (position protection). Execution and
   exit marking are removed from the candle bound's stated scope because they never depended on it —
   this is a documentation correction, not a relaxation.
2. **Derive `SIGNAL_INPUT` from the trigger, in the open.** The two candidate derivations are
   `shortest analytic window ÷ 10` (= 90 s, today's value) and `≤ candidateTtlMs` (= 10 min, on the
   argument that inputs older than the TTL make a candidate's effective evidence age exceed the bound
   already chosen to limit it). **This ADR does not choose between them**; it asks that whichever is
   chosen be recorded with its derivation, so the next session cannot re-litigate it from cost.
3. **Add a per-asset input-age check at the candidate**, which does not exist today, and let it carry
   `BLOCK`. This is the strengthening half and it should land regardless of what happens to the
   number: a per-class health row was never able to do this job.
4. **Leave `effectOnEntries: BLOCK` in place throughout.** Nothing here proposes that stale data stop
   failing closed.

## Why this is not the forbidden shortcut

The test ADR-0011 sets is whether the limit is being widened *to fit the tier*. Three checks:

- **Two of the four consumers are unaffected either way.** Execution and exit marking are bounded by
  a 15 s live quote regardless of what the candle row says. No budget outcome changes that.
- **The proposal adds an entry-blocking check that does not exist** (per-asset input age) and keeps
  every existing `BLOCK`. A pure cost-motivated change would not do that.
- **It refuses to pick the number.** The cost-motivated version of this document would arrive at 45
  minutes, because that is what `maxCandidateAgeMs` allows and what the tier affords. 45 minutes is
  not proposed, and on the evidence above it is not defensible: `maxCandidateAgeMs` bounds how long a
  candidate may *sit*, which is a different quantity from how old its inputs were when it was made.

The honest residual: this ADR was written in a session that wanted the budget to be smaller, and a
reviewer should weigh it accordingly.

## Consequences if accepted

- `FRESHNESS_REQUIREMENTS` gains per-consumer candle rows; `libs/market/src/freshness/evaluate.ts`
  and the candidate gate change; contract lock regenerates.
- A per-asset input-age check at the candidate is new work and new refusals — expect fewer candidates.
- The budget consequence is a **side effect and not a justification**: the tier that affords a given
  refresh interval follows from whatever `SIGNAL_INPUT` is set to, over however many assets the
  evaluation universe holds.

## Consequences if rejected

Also acceptable, and the operator should be comfortable with either. Keeping 90 s means REST polling
on Lite can hold roughly one asset genuinely fresh and about five at the degraded bound, so the
evaluation universe is single digits or the architecture changes to a streaming tier. That is a real
constraint honestly stated, and a small universe kept genuinely fresh produces better evidence than a
large one on stale data.

Item 3 — the per-asset check — should land in either case.
