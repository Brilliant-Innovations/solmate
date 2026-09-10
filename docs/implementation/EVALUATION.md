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
| **2 — confirm** | `B_CAPTURED`, then `C_LIVE_PAPER` | Does that edge survive the data actually available at decision time? | a tier, plus elapsed time |

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

**Isolating proposer from adversary.** `proposer_only_net` versus `full_net` in
`replay_disagreement` is the adversary's marginal contribution directly: the same proposals scored with
and without the adversary's vetoes. `rejected_counterfactual_net` says what the rejected trades would
have done.

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
| `rejected_winners_baseline_net` exceeds `filtered_losers_baseline_net` | The adversary is destroying value, whatever the totals say. | **Stop**, regardless of headline P&L. |

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

## 7. Still to be filled before signature

Left blank deliberately. Each needs a number, and each must be written before the first run rather
than derived from it:

1. **Minimum sample** — trades per arm before any verdict is read, with the reasoning for that number.
   The accumulation *rate* is in `wp2-evidence-source-2026-09-10.md` §3, so a number here converts
   directly to a date.
2. **"Decisive" versus "marginal"** in §5, as a threshold on `strategy_economic_usd` difference and a
   minimum `cost_to_edge_ratio`.
3. **Paper-to-live discount.** The parity suite (`libs/execution/src/adapter/parity.ts`, eleven
   scenarios, green for the paper adapter since M5a) establishes that paper and live share lifecycle
   and refusal semantics. It does **not** yet quantify a fill-quality discount, because the live
   adapter has never run. Until it has, the discount is unmeasured, and Stage 2's `C_LIVE_PAPER` leg
   is what produces it. Stating an invented discount now would be worse than stating none.

## 8. Amendment rule

Amendments **before** the first real model call are legitimate and must be dated in this file with
their reasoning — WP3 exists precisely to find paths that look computed but never execute, and may
show that a metric named in §4 does not work as assumed.

Amendments **after** the first real model call are not legitimate. That is what pre-registration means.
