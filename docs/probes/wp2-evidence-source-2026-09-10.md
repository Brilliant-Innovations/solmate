# WP2 first cut — what the evidence source is, how much exists, and how long a clean one takes

**Naming:** this document says "Level A" and "Level B"; the enum is `ReplayFidelity = ['A_HISTORICAL',
'B_CAPTURED', 'C_LIVE_PAPER']` (`libs/contracts/src/enums.ts:305`) and has a third member. `EVALUATION.md`
uses the enum names; read "Level A" as `A_HISTORICAL` and "Level B" as `B_CAPTURED` below.

Measured against the hosted archive on 2026-09-10. This answers the reframed WP2 question — *evidence
source, volume, elapsed time* — and it changes the answer to the tier question rather than deferring
it.

Stratified by tolerance rather than by a single "clean" threshold, because the strictest tolerance
belongs to the control arm and a contaminated control makes the comparison worthless.

## 1. The existing archive is void, for two independent reasons

**Level B (observation-respecting replay).** Replay that honours point-in-time discipline may use a
candle only once it was *observed*, not merely once its bucket closed. Across 18,132 decision points
(45 eligible assets × 5-minute instants over the archive):

| Attainable input age at the decision instant | Count | Share |
| --- | ---: | ---: |
| No usable candle at all | 0 | 0% |
| ≤ 30 s (`EARLY_ACCELERATION` bound) | **0** | **0%** |
| ≤ 90 s (momentum / catalyst bound) | 6 | 0.03% |
| ≤ 180 s (hybrid bound) | 55 | 0.30% |
| **Median attainable age** | **12,180 s ≈ 3.4 h** | |

The 30 s stratum is structurally empty, as the 60 s bucket floor predicts. But so is every other
stratum: at a median of 3.4 hours the archive is roughly **135× the momentum tolerance**. This is not
a strict-threshold problem, and loosening the threshold does not rescue it.

**Level A (bucket-only replay).** Ignoring observation lag entirely and asking only whether we hold
the buckets:

| | |
| --- | --- |
| Window | 3,426 minutes (57 h) |
| Eligible assets | 45 |
| Mean buckets held per asset | 990 — **28.9% coverage** |
| Best single asset | 2,673 buckets (78%) |
| **Mean contiguous run** | **6.3 minutes** |
| Longest contiguous run | 1,155 minutes (19 h) |
| Runs ≥ 60 min | 81 |
| Runs ≥ 240 min | 26 |

The mean contiguous run is the number that matters, and it is fatal. `contiguousClosedBars` truncates
at any gap, and the momentum trigger needs `minReturn15m` (15 contiguous bars) and
`minRelativeVolume60` (60). **A 6.3-minute mean run cannot compute either feature.** Only the 81 runs
over an hour and 26 over four hours are usable at all, concentrated in a handful of assets.

So the archive fails at both fidelity levels, for reasons that do not share a cause: observation lag
kills Level B, gap density kills Level A. Neither is fixed by the other.

One caveat that matters for interpreting 28.9%: a thinly traded token has no bucket for a minute in
which it did not trade, so some of the missing coverage is real market structure rather than ingestion
failure. Eligibility already requires ≥$250k liquidity, but "eligible" is not the same as "trades
every minute". ~~The evaluation universe should therefore be chosen on observed bucket density.~~ **That
conclusion is wrong and is superseded by `EVALUATION.md` §6:** density here reflects which assets the
broken planner happened to serve, not which assets trade, so selecting on it would bias the universe
by attention. Select by the stated eligibility rule and purchase contiguity for whatever it selects.

## 2. The finding that changes the tier question

Archive accumulation and live freshness have been treated as the same cost. They are not.

A single OHLCV request returns **up to 1000 buckets for 45 CU** (`BIRDEYE_CU.ohlcvV3`). Cost is per
request, not per bucket. So:

- **Contiguity does not depend on refresh frequency.** One request backfills the entire gap since the
  last one, up to 1000 buckets ≈ **16.7 hours** of 1-minute data. Refreshing an asset even twice a day
  yields a *fully contiguous* 1m series.
- **Freshness does depend on refresh frequency**, and that is what costs money: holding input age at
  90 s needs a refresh roughly every 30 s, which is 3.89 M CU/month per asset.

> **A contiguous Level A archive for a single-digit universe is nearly free and bounded by calendar
> time. Only live-decision freshness is bounded by money.**

At 5 assets refreshed every 6 hours: 20 requests/day = 900 CU/day = 27,000 CU/month, **about 1% of the
Lite allowance**. The remaining 99% is then available for whatever live freshness the evaluation
actually needs.

This is the precise version of "replay dissolves the tier question": it dissolves it **at Level A**.
It does not dissolve it at Level B, where usable density is bounded by observation lag at write time,
which costs exactly what live freshness costs. Choosing the fidelity level is therefore choosing
whether the evaluation needs a tier at all.

## 3. Elapsed time, which is now the binding constraint

The archive contributes nothing usable, so the clock starts from the fixed ingestion. What a day buys,
at 5 assets on a 6-hour refresh:

| Quantity | Per day | Notes |
| --- | --- | --- |
| Contiguous 1m bars per asset | ~1,440 | Subject to the asset actually trading each minute |
| Asset-days | 5 | |
| CU cost | ~900 | 0.04% of the monthly allowance |

The volume needed before a verdict may be read is **WP2's remaining open question and belongs in
`EVALUATION.md` as a pre-registered number**, not here — deriving a sample size after seeing the
accumulation rate is the ordering this whole exercise exists to avoid. What this document establishes
is the *rate*, so that whatever sample size is pre-registered converts directly to a date.

## 4. What this forces `EVALUATION.md` to state explicitly

1. **Fidelity level.** Level A (cheap, large sample, cannot model execution-time data staleness) or
   Level B (models it, and costs a tier). Not a default — a stated choice with its reasoning.
2. **The control arm's trigger.** If S0 keeps `EARLY_ACCELERATION`, the control runs at ratio ~2.0 on
   1m data while the LLM strategies read momentum at 90 s, which the 60 s floor does satisfy. That is
   a degraded control against a clean treatment, and any difference between them is confounded by data
   quality rather than by the thing under test. Defining the control on the momentum trigger compares
   like with like. See ADR-0014.
3. ~~**Universe selection by bucket density**, not by eligibility alone.~~ **Superseded by `EVALUATION.md` §6, 2026-09-10.** Density in this archive is an artifact of the broken planner's priority ordering rather than a property of the market, and going forward it is a choice rather than an observation, since contiguity is purchasable at a twice-daily refresh for anything we point at. Selecting on it would pick whatever happened to receive attention. Select by the stated eligibility rule and buy contiguity for what it selects.
4. **The three recorded quantities per decision** — required age, attained age, ratio — so degradation
   is visible on the decisions themselves rather than reconstructed afterwards (ADR-0014).

## 5. What has not been done

- The exit-path re-measurement after shortening `POSITION_MONITOR_INTERVAL_MS` (ADR-0014 proposes that
  order: shorten, re-measure, then decide on a tier).
- Any accumulation. The rate above is derived from the request/CU arithmetic and the corrected planner
  configuration, not observed under the WP1b changes — the worker has not run continuously since they
  landed. The first week of real accumulation replaces §3's projection with a measurement.
