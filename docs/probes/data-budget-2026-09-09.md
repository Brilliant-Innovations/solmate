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

**Step 4 — the tier decision, with the numbers.** CU/month = assets × (43,200/R) × 45:

| Universe | Refresh | CU/month | Cheapest tier |
| --- | --- | ---: | --- |
| 43 eligible | 65 min (steps 1+2, free) | 1.29 M | **Lite $39** ✓ |
| 43 eligible | 45 min (S2/S3) | 1.86 M | Lite $39 ✓ |
| 43 eligible | 30 min (S4) | 2.79 M | Starter $99 |
| 43 eligible | 20 min (S1) | 4.18 M | Starter $99 |
| 43 eligible | 5 min | 16.7 M | Premium $199 |
| 20 assets | 20 min | 1.94 M | Lite $39 ✓ |
| 20 assets | 5 min | 7.78 M | Starter $99 |

Reading it: **Lite already covers S2 and S3 once steps 1–2 are done.** S1 at 20 minutes and S4 at 30
minutes need Starter ($99) at a 43-asset universe — or stay on Lite by cutting the eligible universe
to ~20, which is a strategy-coverage decision, not a budget one.

**Caveat on that mapping, stated rather than buried:** the table treats `maxCandidateAgeMs` as the
required candle-refresh interval. That is an assumption. The honest requirement is whatever data age
each trigger's lookback tolerates, and nothing currently records it. **WP2 must pin the real
per-strategy input-freshness requirement**, because the tier decision follows from it.

## What this changes for the sequence

Steps 1 and 2 are the operator-gated WP1b. They are code-only, cost nothing, and should land before
any paper evaluation begins — a run started on eight-hour-old candles produces exactly the evidence
that has to be discarded later. The recording gap (no input age on a feature snapshot) should land
with them, or the evaluation cannot tell warm from cold after the fact.
