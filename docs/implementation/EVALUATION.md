# Evaluation protocol — does the proposer/adversary pair beat the control, net of cost?

**Status:** pre-registration draft. **Operator signature required before WP3's first real model key.**
**Date:** 2026-09-10. Written before any result exists, which is the only time it can be written.

Layer 5 exists so the system can prove whether the AI adds value. It has never produced a verdict.
This document fixes how the verdict will be read, so that it cannot be chosen after the fact.

Everything here is checked against the tree: no metric below is invented, and every one names the
view, module or column that already computes it. Where something does not exist, it says so.

---

## 1. Naming, corrected

The codebase's fidelity levels are `ReplayFidelity = ['A_HISTORICAL', 'B_CAPTURED', 'C_LIVE_PAPER']`
(`libs/contracts/src/enums.ts:305`). Earlier working notes said "Level A / Level B"; the enum has
three members and the third is live paper. This document uses the enum names.

## 2. The design is two stages, and the gate between them is the point

`docs/probes/wp2-evidence-source-2026-09-10.md` established that contiguity is nearly free (one OHLCV
request backfills ~16.7 h for 45 CU) while freshness costs 3.89 M CU/month per asset. That is not a
choice between fidelity levels. It is a sequence.

| Stage | Fidelity | Question it answers | Cost |
| --- | --- | --- | --- |
| **1 — screen** | `A_HISTORICAL` | Does the pair beat the control *on the data*? | ~1% of the Lite allowance |
| **2 — confirm** | `C_LIVE_PAPER` + `B_CAPTURED`, same window | Does that edge survive the data actually available at decision time? | **one** tier purchase, plus elapsed time (see 6a(ii)) |

**Stage 1 is necessary and not sufficient.** A pass at `A_HISTORICAL` authorizes **exactly one thing:
the spend for Stage 2.** It does not authorize live trading, a strategy promotion, an arming step, or
any change to a Release. This is stated as a rule rather than an intention because the failure mode is
specific and predictable: a cheap positive result becomes the argument for skipping the expensive
confirmation, which is the substitution this entire detour exists to prevent.

## 3. The comparison

Arms, all from `research.replay_leaderboard` keyed by `strategy_version_id` and `variant`:

| Arm | Role |
| --- | --- |
| `S0_SAFE` | **primary control** — deterministic, gated |
| `S0_RAW` | ungated deterministic reference; shows what the safety gate costs |
| `S1`–`S4` | treatment (proposer + adversary, per family) |
| latency-matched baseline | `research.replay_latency_cost` — the control re-run under the treatment's decision latency |

**The control arm runs on the momentum trigger, not `EARLY_ACCELERATION`** — a pre-registered choice,
with its reasoning, per ADR-0014. `EARLY_ACCELERATION` reads a 5-minute window, so its derived input
bound is 30 s, which is unsatisfiable on 1-minute candles by construction (minimum input age equals
the bucket resolution). It would therefore run at a ratio of ~2.0 while the LLM strategies read
momentum at 90 s, which the 60 s floor does satisfy. Comparing a degraded control against a clean
treatment measures data quality, not strategy. `EARLY_ACCELERATION` remains available to live
operation; it is out of *this comparison* only.

## 4. Metrics, and where each already comes from

Nothing here is new work.

| Question | Source | Columns |
| --- | --- | --- |
| Did it make money, net of cost | `research.replay_leaderboard` | `net_pnl`, `gross_pnl`, `fees`, `slippage_cost`, `execution_shortfall_bps` |
| Was it skill or variance | same | `win_rate`, `expectancy`, `profit_factor`, `sharpe`, `sortino`, `tail_loss` |
| What did it risk | same | `max_drawdown_fraction`, `time_in_market_fraction`, `turnover` |
| Did it execute | same | `failed_execution_rate`, `average_decision_to_fill_ms` |
| **What the AI added or destroyed** | `research.replay_incremental_value` | `both_traded`, `filtered_losers` (+ `baseline_net`), `rejected_winners` (+ `baseline_net`), `admitted_not_baseline` |
| **What the adversary specifically added** | `research.replay_disagreement` | `proposer_only_net` vs `full_net`, `disagreement_rate`, `expectancy_after_confirm` / `_challenge`, `rejected_with_counterfactual`, `rejected_counterfactual_net` |
| Was confidence meaningful | `research.replay_calibration` | `brier_score`, per-bin counts |
| What latency cost | `research.replay_latency_cost` | `missed_baseline_net`, `edge_lost_to_latency`, `expired_by_latency` |
| Economics incl. model spend | `research.replay_economic_pnl` | `trading_net_usd`, `direct_cost_usd`, `strategy_economic_usd`, `platform_share_usd`, `cost_to_edge_ratio` |
| Exit behaviour | `research.replay_exit_outcomes` | `net_pnl`, `expectancy`, `average_hold_ms`, `average_execution_shortfall_bps` |

**Isolating proposer from adversary.** `proposer_only_net` versus `full_net` in `replay_disagreement`
is the adversary's marginal contribution directly — and it is stronger than a veto count, because
`PROPOSER_ONLY` is a **separately executed replay arm** (`ReplayVariant`,
`libs/contracts/src/entities/replay.ts:70`) rather than a post-hoc subtraction. It therefore captures
everything the adversary does: vetoes, challenges, and the revisions that follow them. `CHALLENGE` is
additionally broken out on its own (`challenged`, `expectancy_after_challenge`), so a *modified*
proposal is visible as its own category rather than folded into "not rejected".
`rejected_counterfactual_net` is the baseline arm's realized outcome on the same candidates — see
§6a(iii) for what that does and does not assume.

**Separating AI filtering from risk-core refusals.** Already structural, not a convention to remember:
`IncrementalCategory` (`libs/replay/src/metrics/attribution.ts:21-23`) carries `RISK_BLOCKED_AI`,
`RISK_BLOCKED_BASELINE` and `RISK_BLOCKED_BOTH` as categories distinct from `AI_FILTERED_LOSER` and
`AI_REJECTED_WINNER`. A trade the deterministic risk core refused **is never credited to the model**.

**Model cost netting.** `direct_cost_usd` is the strategy's own model spend; `platform_share_usd` is
its allocated share of shared operating cost, and `replay_economic_pnl.allocation` records the
allocation basis in force — which is how a strategy trading in more than one book is charged. The
verdict reads `strategy_economic_usd`, never `trading_net_usd`.

## 5. Asymmetric stopping rule, pre-registered

**`A_HISTORICAL` hands both arms inputs better than live can supply**, and the bias has a known
direction: if the LLM strategies benefit more from clean, complete context than the deterministic
control does — plausible, since context richness is most of what they are for — then Stage 1
**overstates the treatment's relative advantage**.

Therefore the thresholds are deliberately asymmetric. **Aggressive on stop, conservative on proceed.**

| Stage 1 outcome | Reading | Action |
| --- | --- | --- |
| Treatment fails to beat control on `strategy_economic_usd` | **Strong** evidence against. The treatment ran with every advantage and still lost. | **Stop.** Redesign or abandon layer 5. Do not buy Stage 2. |
| Treatment beats control marginally | **Weak** evidence for. Consistent with the known bias alone. | **Stop.** Not sufficient to authorize Stage 2 spend. |
| Treatment beats control decisively, and `cost_to_edge_ratio` leaves margin | Necessary, not sufficient. | **Proceed to Stage 2 only.** |
| `rejected_winners_baseline_net` exceeds `filtered_losers_baseline_net` | The adversary is destroying value, whatever the totals say. | **Stop**, regardless of headline P&L — subject to the coverage caveat in §6a(iii). |

"Decisively" and "marginally" must be given numeric definitions **before the first run**, in §7.

## 6. Universe selection — by stated rule, not by density

The evaluation universe is selected by the **existing eligibility criteria**
(`core.asset_eligibility`, `DEFAULT_ELIGIBILITY_POLICY`), and contiguity is then purchased for
whatever that selects.

Explicitly **not** selected by observed bucket density. Density in the current archive is an artifact
of the broken planner's priority ordering rather than a property of the market, and going forward it
is a *choice* rather than an observation, since contiguity is purchasable at a twice-daily refresh for
anything we point at. Selecting on density would pick the assets that happened to receive attention,
which correlates with liquidity and volatility and biases the universe in a direction nobody controls.
Selecting by rule makes the universe a pre-registered decision instead of a residue.

*(This supersedes the "select by bucket density" item in `wp2-evidence-source-2026-09-10.md` §4.3.)*

## 6a. Three clarifications required before signature, checked against the tree

**(i) A scripted model is not "the first real model call".** WP3 drives the discretionary cycle through
the gateway's injected transport with fixed structured output. That is plumbing: it produces no result
capable of influencing a threshold, and it exists precisely to discover whether the metrics in §4
execute at all. So amendments to this document **remain legitimate after WP3 and until the first call
that reaches a real provider with a real key**. Stated here rather than left to inference, because the
moment someone wants to argue the point is the moment the argument is least trustworthy.

**(ii) `B_CAPTURED` is not a separate spend.** Confirmed in the tree:
`disciplineFor` (`libs/replay/src/point-in-time/guard.ts:68`) gives `A_HISTORICAL` → `SOURCE_TIME` and
**both** `B_CAPTURED` and `C_LIVE_PAPER` → `OBSERVED_TIME`; and the ops action refuses to file a replay
run at anything but `A_HISTORICAL` or `B_CAPTURED` (`ops-actions.ts:132`) — `C_LIVE_PAPER` is the live
book, not a replay. So B is the replay of the window C captured, over the same feed, under the same
observation discipline.

> **Two spends and three fidelities, not three stages.** Stage 2 buys one thing — a window of
> low-observation-lag data — and `C_LIVE_PAPER` and `B_CAPTURED` are both read out of it. Budget for
> one, not two.

**(iii) The counterfactual assumption, named — and it is narrower than "would have filled as scored".**
`rejectedCounterfactualNet` (`libs/replay/src/metrics/attribution.ts:147-155`) does not model a
hypothetical fill. It reads the **baseline arm's actually realized outcome on the same candidate**, and
only where the baseline in fact traded it (`if (traded(b))`). Two consequences the stop rule inherits:

- The assumption is a *substitution* one — that the control's realized outcome on a candidate is a fair
  proxy for what the treatment would have realized — not a fill-simulation one. Different arms may size
  or time differently, so it is a proxy, not a measurement.
- It is measurable only on the subset the baseline traded. `rejected_with_counterfactual` is therefore
  strictly less than `rejected`, and rejections of candidates the control never took contribute
  **nothing** to the rule. The stop in §5 is evaluated on that subset and its coverage
  (`rejected_with_counterfactual ÷ rejected`) must be reported alongside it, because a rule that can
  halt the programme on its own must not do so from a small unstated slice.

**And the related question resolves in our favour.** The adversary's marginal contribution is not
computed as veto-versus-no-veto. `ReplayVariant = ['FULL', 'PROPOSER_ONLY', 'LATENCY_MATCHED']`
(`libs/contracts/src/entities/replay.ts:70`) makes `PROPOSER_ONLY` a **separately executed replay arm**,
so `proposer_only_net` vs `full_net` captures everything the adversary does — vetoes, challenges and
the revisions that follow them — rather than only its refusals. `CHALLENGE` is additionally broken out
on its own (`challenged`, `expectancy_after_challenge`, and `disagreement_rate` counting challenges and
rejections together), so a modified proposal is visible as its own category.

## 7. Still to be filled before signature

Left blank deliberately. Each needs a number, and each must be written before the first run rather
than derived from it:

1. **Minimum sample — pre-registered as a *rule*, not a number.** Write it as: *n such that a
   difference of the magnitude fixed in (2) is detectable at stated power, given the variance observed
   in the pilot.* Stated that way, the pilot's variance converts the rule to a number mechanically and
   nobody chooses one after seeing a result. The accumulation *rate* is in
   `wp2-evidence-source-2026-09-10.md` §3, so the number then converts directly to a date. Power and
   significance levels go here too, and they are also a rule rather than a result.

2. **"Decisive" versus "marginal" — the operator's number, and the one to write first.** This is not a
   statistical question and it is not the builder's to answer. It is: *what edge over `S0_SAFE`, net of
   model cost, would make you willing to risk capital?* That comes from appetite and capital, not from
   the data. It is also the single blank most easily contaminated by any exposure to a result, since a
   threshold set after seeing a number tends to land just below it. **Write it before WP3 runs**, as a
   threshold on the `strategy_economic_usd` difference and a minimum `cost_to_edge_ratio`. Everything
   in (1) is derived from it, so it is the load-bearing blank.
3. **Paper-to-live discount.** The parity suite (`libs/execution/src/adapter/parity.ts`, eleven
   scenarios, green for the paper adapter since M5a) establishes that paper and live share lifecycle
   and refusal semantics. It does **not** yet quantify a fill-quality discount, because the live
   adapter has never run. Until it has, the discount is unmeasured, and Stage 2's `C_LIVE_PAPER` leg
   is what produces it. Stating an invented discount now would be worse than stating none.

## 8. Amendment rule

Amendments **before** the first real model call are legitimate and must be dated in this file with
their reasoning — WP3 exists precisely to find paths that look computed but never execute, and may
show that a metric named in §4 does not work as assumed. Per §6a(i), a scripted transport is **not**
a real model call, so WP3 falls inside this window.

Amendments **after** the first real model call are not legitimate. That is what pre-registration means.

The one exception in the other direction: §7(2), the operator's economic threshold, should be written
**before WP3 runs at all**, not merely before the first real call. Nothing in WP3 can contaminate it —
a scripted model produces no result — but the discipline is cheap and the habit is the thing being
protected.
