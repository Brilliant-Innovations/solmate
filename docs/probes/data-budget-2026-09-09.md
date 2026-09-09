# WP1 — data budget truth (2026-09-09)

Measured from `ops.provider_spend`, `market.candles`, `core.asset_eligibility` and
`signals.feature_snapshots` on the hosted project. No planner code changed in this package.

**Read the reconciliation first.** The premise this work package started from — that the planner is
leaving ~83% of a purchased allowance unspent — is wrong, and it was wrong because of an arithmetic
error of mine. The real finding is worse and points somewhere else.

## What the ledger actually says

`ops.provider_spend` holds one cumulative row per provider-month. There is no daily history in it, so
"CU per day" below is derived from the observation window in `market.candles`, not read from the
ledger. That limitation is itself worth recording: **we cannot currently plot spend over time**, only
a running total and an endpoint split.

| | |
| --- | --- |
| Tier | `BIRDEYE_TIER=LITE` — 2,500,000 CU/month, 15 rps |
| Used, 2026-09 | **129,514 CU** |
| Observation window | 2026-09-07T15:12:37Z → 2026-09-09T19:18:42Z = **52.1 h (2.171 days)** |
| Implied run rate | **59,656 CU/day → ~1.79 M/month → 71.6% of the Lite allowance** |

CU by endpoint:

| Endpoint | CU | Share | Unit cost |
| --- | ---: | ---: | --- |
| `ohlcv_v3` | 93,915 | 72.5% | 45 |
| `token_security` | 15,575 | 12.0% | 25 |
| `token_trending` | 10,325 | 8.0% | 25 |
| `token_overview` | 9,660 | 7.5% | 15 |
| `multi_price` | 39 | 0.03% | ⌈3·n^0.8⌉ |

## The reconciliation

Three numbers were in tension. All three are now explained, and only one of them was wrong.

**1. `docs/costs.md` (M4): "≈2,300 CU/hour ≈1.7 M CU/month" as configured.** Correct. Observed is
1.79 M/month, within 5% of that projection. The projection has been right all along.

**2. `CHANGELOG` 2026-09-08: "continuous 1m candles for ~20 eligible assets cost about 3× the monthly
allowance."** Correct arithmetic, describing a regime we do not run. 20 assets refreshed every 5
minutes = 20 × (43,200/5) × 45 CU = **7.78 M/month = 3.1× Lite**. The companion line in
`m5a-pipeline-evidence-2026-09-08.md` — "the allowance permits roughly one refresh per asset every
15–20 minutes" — is also correct: 20 assets at 15 min = 2.59 M ≈ the 2.5 M allowance. Both describe a
**20-asset** universe.

**3. "≈430 k/month run rate, ~17% of the tier, 83% unspent."** Wrong, and mine. It divided
month-to-date CU by elapsed *calendar* days (9) when ingestion had only run for 2.171 days. Correcting
the denominator moves the answer from 17% to **71.6%**. There is no large unspent allowance.

So we are **neither tier-limited nor leaving the tier unspent. We are universe-limited** — and the
budget is being consumed largely by requests that return nothing.

## Where the money goes

`ohlcvV3` charges 45 CU per request for ≤1000 items. 93,915 / 45 = **2,087 requests**, exactly
integer, so every OHLCV call this month was a ≤1000-item call.

Requests that actually wrote a candle row, counted as distinct `(asset_id, observed_at::second)`
groups: **457**.

> **~78% of OHLCV spend produced no new candle.** 1,630 of 2,087 requests wrote nothing.

That is the single largest lever in this report and it costs nothing to pull. The M4 fix added
per-asset backoff for exactly this ("the same few dead tokens whose fetches add nothing"), doubling
from the cycle interval to a 6-hour cap. It is not keeping up: the tracked set is far larger than the
one it was tuned against.

(Method note: a request returning ~35 candles writes them all with one `observed_at` second, so the
group count is a good proxy for productive requests. It would undercount only if two requests for the
same asset landed in the same second, which at 5-minute cadence they cannot.)

## What that buys in freshness

Candles: 72,711 rows, 181 distinct assets. Eligible universe: **43** (242 hard-rejected).

Per-asset 1m refreshes across the 52.1 h window:

| Group | Assets | Mean refreshes | Effective interval |
| --- | ---: | ---: | --- |
| Eligible | 43 | 6.5 | **one per 8.0 h** |
| Not eligible | 137 | 1.2 | one per ~43 h |

The stalest-first priority ordering *is* working — eligible assets get 5.4× the attention of
ineligible ones. The absolute rate is the problem: the M5a projection was 15–20 minutes per asset and
the reality is eight hours.

Age of a 1m candle when it was written (`observed_at − bucket_time`), n = 72,098:

| Band | n | Share | Cumulative |
| --- | ---: | ---: | ---: |
| ≤ 1 min | 182 | 0.3% | 0.3% |
| ≤ 5 min | 1,277 | 1.8% | **2.1%** |
| ≤ 15 min | 2,971 | 4.1% | 6.2% |
| ≤ 60 min | 12,153 | 16.9% | 23.1% |
| ≤ 3 h | 29,332 | 40.7% | 63.8% |
| > 3 h | 26,183 | 36.3% | 100% |

**97.9% of 1m candles were already more than five minutes stale when written**, independently
reproducing the M10 batch-4 correction on a different window.

## The finding nobody was looking for

`FEATURES_INTERVAL_MS=60000`. The feature engine wrote **48,105 snapshots** across 43–49 assets in the
same window in which the candles beneath them refreshed **once per eight hours**.

> The feature engine runs roughly 200× more often than its inputs change. Outside the few minutes
> after each refresh, every snapshot recomputes identical candle data and stamps a fresh `as_of` on it.

This is why cold features do not look cold from inside the system. `signals.feature_snapshots.as_of`
records when the feature was *computed*, not how old the data underneath it was, and nothing on the
row carries input age. The same gap runs through the candidate gate: `maxCandidateAgeMs` bounds how
long a candidate may sit before it is stale (S1 20 min, S4 30 min, S2/S3 45 min), and says nothing
about the age of the candle that produced it. A candidate created from an eight-hour-old candle is
zero seconds old and passes.

**This is a WP2 prerequisite, not just a budget issue.** Any evaluation that reads `as_of` as evidence
of freshness will systematically overstate it, and the paper record would inherit the same flaw the
M10 evidence window had.

Volume for scale: 24 candidates over the window (15 on the 8th, 9 on the 9th).

## Why the planner leaves the universe starved

Not backoff, not priority ordering, not cycle interval. Arithmetic:

- `cuBudgetPerCycle = floor(2,500,000 × 0.9 / 8,640 cycles) = **260 CU**` at a 5-minute interval.
- 260 CU ÷ 45 = **≈5 OHLCV requests per cycle**, before `token_overview`/`token_security` take their share.
- `trackedLimit = 100` (`rps > 1`), and **181** distinct assets received candles across the window.
- A full rotation of 100 tracked assets at 5 requests/cycle takes 20 cycles = **100 minutes** — and
  that is the floor, achieved only if every request were productive. At 78% waste it becomes ~7.6 h,
  which is what the data shows.

The observed 961 requests/day against a 1,440/day ceiling reflects the worker not being up
continuously during this window, which is also why the run rate below should be treated as
provisional.

## Recommendation

**Spend what we own before buying more, because the free fixes change which tier is needed.**

**Step 1 — stop paying for nothing (no tier change).** Make the backoff actually evict: an asset whose
OHLCV fetch has written nothing for N consecutive attempts should leave the tracked set until
eligibility re-promotes it, rather than decaying to a 6-hour retry and staying in rotation forever. At
today's spend this alone multiplies productive requests by ~4.5×.

**Step 2 — track the universe we trade (no tier change).** 181 assets received candles; 43 are
eligible. Serve eligible + held only. Combined with step 1, the current Lite spend delivers ~961
productive requests/day over 43 assets = **one refresh per ~65 minutes**.

**Step 3 — re-measure for a full week with the worker continuously up**, then decide the tier. The
present window is 2.171 days with several restarts.

**Step 4 — ~~the tier decision, with the numbers~~ WITHDRAWN. See the correction at the end of this
file.** The table below is wrong twice over and is kept only so the errors are visible: it compares
OHLCV-only cost against the whole allowance while ignoring ~492 k/month of non-OHLCV overhead, and
every figure in its "Refresh" column is derived from `maxCandidateAgeMs`, which this same document
says is the wrong requirement. Do not price a tier from it.

CU/month = assets × (43,200/R) × 45:

| Universe | Refresh | CU/month | Cheapest tier |
| --- | --- | ---: | --- |
| 43 eligible | 65 min (steps 1+2, free) | 1.29 M | **Lite $39** ✓ |
| 43 eligible | 45 min (S2/S3) | 1.86 M | Lite $39 ✓ |
| 43 eligible | 30 min (S4) | 2.79 M | Starter $99 |
| 43 eligible | 20 min (S1) | 4.18 M | Starter $99 |
| 43 eligible | 5 min | 16.7 M | Premium $199 |
| 20 assets | 20 min | 1.94 M | Lite $39 ✓ |
| 20 assets | 5 min | 7.78 M | Starter $99 |

~~Reading it: **Lite already covers S2 and S3 once steps 1–2 are done.**~~ **False, and the operator
caught it: 65 minutes is larger than 45.** The two figures were not even the same quantity — 65 min is
what today's *observed spend* would deliver at zero waste, while 45 min is what the *allowance* would
permit. Both then rest on the wrong requirement column. Corrected below.

**Caveat on that mapping, stated rather than buried:** the table treats `maxCandidateAgeMs` as the
required candle-refresh interval. That is an assumption. The honest requirement is whatever data age
each trigger's lookback tolerates, and nothing currently records it. **WP2 must pin the real
per-strategy input-freshness requirement**, because the tier decision follows from it.

## What this changes for the sequence

Steps 1 and 2 are the operator-gated WP1b. They are code-only, cost nothing, and should land before
any paper evaluation begins — a run started on eight-hour-old candles produces exactly the evidence
that has to be discarded later. The recording gap (no input age on a feature snapshot) should land
with them, or the evaluation cannot tell warm from cold after the fact.

---

# Correction, and DEFECT-4 — the freshness gate measures the wrong quantity

The operator caught an inconsistency in step 4 ("~65 min is enough for S2/S3 at 45 min"; 65 > 45) and
asked for it to be re-derived before it informed a purchase. Re-deriving it found a second error, and
then answering the operator's own question — *does the existing freshness gate already refuse
stale-input candidates?* — found a defect that makes the whole tier table beside the point.

## Two arithmetic errors, both mine

1. **65 vs 45 are different quantities.** 65 min is what *today's observed spend* (59,656 CU/day)
   would deliver over 43 assets at zero waste. 45 min is what the *full allowance* would permit.
   Comparing them as if they were the same thing produced a claim that is false on its face.
2. **The tier table charged OHLCV against the whole allowance.** Non-OHLCV endpoints
   (`token_security`, `token_overview`, `token_trending`) ran at ~492 k CU/month in the observed
   window and scale with universe and eligibility cadence, not with refresh interval. Including them,
   and the planner's own 0.9 safety factor, Lite fully utilised and perfectly efficient over 43
   eligible assets yields **≈48 minutes**, not 45 — so even the corrected row would not have met
   S2/S3.

## The requirement column was wrong, and the real one is far stricter

`maxCandidateAgeMs` bounds how long a *candidate* may sit before it is stale. The founded requirement
is `FRESHNESS_REQUIREMENTS` (ADR-0011, `libs/contracts/src/policy/freshness.ts`), and for candles it
is identical across all three speed tiers:

```
{ dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK' }
```

**90 seconds fresh, 5 minutes degraded, blocking entries beyond that** — not 20–45 minutes. What that
costs by REST polling, including the ~492 k/month overhead and the 0.9 factor:

| Universe | Target | OHLCV CU/month | Cheapest tier |
| --- | --- | ---: | --- |
| 43 eligible | 90 s (fresh) | 55.7 M | Business $499 |
| 43 eligible | 5 min (degraded floor) | 16.7 M | Premium $199 |
| 20 assets | 5 min | 7.8 M | Starter $99 |
| ~5 assets | 5 min | 1.9 M | **Lite $39** |
| ~1 asset | 90 s | 1.3 M | **Lite $39** |

So the honest statement is not "Lite versus Starter". It is: **REST polling on Lite can hold roughly
one asset genuinely fresh, or about five at the degraded bound.** Meeting ADR-0011 for a useful
universe requires Premium or above — which is exactly where Birdeye's WebSocket stream begins, as
`libs/market/src/birdeye/tiers.ts` already notes ("REST first, WebSocket when the tier allows").
The gap is architectural, not a $60 purchase.

This independently confirms the operator's instinct to hold the tier, for a stronger reason than the
one given: no affordable tier fixes this by polling harder.

## DEFECT-4 — `HEALTHY` means "the call succeeded", not "the data is current"

The operator's question was whether the existing gate already refuses candidates built on stale
inputs, in which case cold features would mean *fewer* decisions rather than *wrong* ones. Measured on
the hosted project:

| `ops.provider_health` for `BIRDEYE:CANDLES` | Reality for the same 43 eligible assets |
| --- | --- |
| `state: HEALTHY` | newest 1m candle **232–347 min old**, mean **307 min** |
| `freshness_age_ms: 2306` (2.3 s) | **0 of 43** meet the 90 s fresh bound |
| `effect_on_entries: NONE` | **0 of 43** meet even the 5 min degraded bound |

The cause is one line, `libs/market/src/freshness/evaluate.ts:34`:

```ts
const age = input.lastSuccessAt === null ? null : Math.max(0, instantToMs(input.now) - instantToMs(input.lastSuccessAt));
```

`age` is the time since the last successful **provider call**, never the age of the newest **datum**.
The worker calls OHLCV every cycle and the call succeeds — it just returns nothing new 78% of the
time — so `lastSuccessAt` is always seconds old, the class is always `HEALTHY`, and `effectOnEntries`
is therefore always `NONE`. `entriesBlocked()` filters on `effectOnEntries === 'BLOCK'`, so
`FEEDS_STALE` can never be raised for candles no matter how old they get.

**The answer to the operator's question is no.** The gate does not refuse stale-input candidates, and
it cannot, because it is not measuring input age. Cold features therefore produce *wrong* decisions,
not merely fewer of them. The two `QUALIFIED` candidates in this window were qualified against candles
already hours old, with the feed reporting healthy throughout. The 20 rejections were
`ELIGIBILITY_STALE` — a different clock, on a 10-minute cadence — and one was `FEATURES_STALE`, which
almost never fires because `feature_snapshots.as_of` is recomputed every 60 s regardless of input age.

**This was already observed once and misdiagnosed.** The 2026-09-08 M4 entry records the exact
symptom — "`WARMUP_SUFFICIENT` never passed because 1m candles for every eligible asset had stopped
hours earlier **while CANDLES reported HEALTHY**". The fix that followed corrected the planner
starvation, which was the cause of the missing data. Nobody fixed the alarm that failed to announce
it, so it is still reporting HEALTHY today, five hours stale, a day later.

It is the same family as DEFECT-1 through 3 one more time: a cheap local proxy — "did our call
succeed?" — standing in for the expensive real question — "is the data current?" — and the two
diverging silently the moment the provider starts returning empty pages.

## What this changes

- **Hold the tier.** Confirmed, and for the stronger reason above.
- **DEFECT-4 goes into WP1b ahead of everything else.** Recording input age on a feature snapshot is
  necessary but not sufficient; the freshness evaluator has to take the newest datum's timestamp, not
  the call's. Until it does, every entry-blocking freshness requirement in ADR-0011 is inert for
  candles, and no paper evidence collected under it can be trusted to have been gated.
- **The eviction and narrowing fixes stay first in implementation order** but are no longer the
  headline: they raise the refresh rate, while DEFECT-4 is what lets a stale rate pass unnoticed.
- **WP2 inherits a harder question than "pin the requirement".** The requirement is already pinned at
  90 s and REST cannot meet it. WP2 has to state what data age each trigger's lookback *actually*
  tolerates and whether ADR-0011's candle bound is right, because if it is, the evaluation universe
  has to be small enough to keep fresh — single digits on Lite — or the architecture has to change.
