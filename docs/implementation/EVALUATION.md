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

**The cost denominator is partly floors, and must report how much.** `AgentRun.costAccrual`
distinguishes `MEASURED` (the provider returned usage metadata; `cost_usd` is what it billed —
including malformed output, which was billed and merely failed to parse) from `UNKNOWN` (the call
ended without metadata on timeout or outage; `cost_usd` is a **floor**, not a measurement). A timeout
is aborted on *our* deadline, so the provider may well have billed it, and the undercount is biased
toward the most expensive calls because a timeout is by definition a long generation.

> §7(2) divides edge by model cost per decision, so an undercounted denominator **inflates the
> measured edge**, in the direction of proceeding. Any metric dividing by model cost therefore reports
> the **UNKNOWN share** alongside it, exactly as the adversary stop reports its counterfactual
> coverage. A denominator assembled partly from floors is not a measurement, and this document does
> not treat it as one. If the UNKNOWN share is material, the cost comparison is **INCONCLUSIVE**.

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

### 5a. When the rules are allowed to fire

Two guards, pre-registered here because both must be chosen while it is still unknown which side of
them the result will land on.

**Minimum coverage for the adversary stop.** The `rejected_winners` stop in the table above is
computed on the counterfactual subset described in §6a(iii) — rejections where the *control also
traded* that candidate. That is not a random slice of what the adversary rejects: it is the overlap
with the control's own gate. At low coverage the rule would be halting the programme on a small and
non-randomly-selected corner of the adversary's behaviour.

> The stop fires only when **both** `rejected_with_counterfactual ≥ 30` **and**
> `rejected_with_counterfactual ÷ rejected ≥ 0.25`. Below either, the rule reports
> **INCONCLUSIVE** — neither a stop nor a pass — and the coverage figure is reported with it.

Both numbers are **conventions, not results**, and are marked as such for the same reason ADR-0014
marks its divisor: 30 is the conventional floor at which a mean stops being dominated by individual
observations, and 0.25 is a judgement that a quarter of the rejections is the least that can stand for
the whole. A reviewer who wants them different should say so **now**. What is not negotiable is that
some floor exists, because a rule empowered to end the programme must not do so from an unstated
slice.

**Burn-in, declared before the key exists.** Rate limits, mid-call truncation, provider-side schema
drift and whatever else a real provider does will all be met for the **first time on the first metered
run** (`wp3-discretionary-path-2026-09-10.md` item 3 — they are scripted as effects today, not
observed). Those cycles will be unrepresentative, and the temptation to exclude them after seeing them
is precisely the discretion this document exists to remove.

> The first **[N — operator to set, suggested 50]** cycles **and** **[H — suggested 4]** hours of
> running, **whichever is later**, after the first real key, are a **burn-in**: excluded from the
> Stage 1 sample by rule. Stage 1 has not started until the burn-in closes.

**Whichever is *later*, not either.** Fifty cycles in twenty minutes gives no exposure to rate limits
or drift; four hours at three cycles gives no exposure to anything. The purpose is meeting the
provider's failure modes, and that needs both volume and wall-clock.

Chosen now, while nobody knows what those cycles will look like. The burn-in also gives the key's
first use its right shape: a deliberate, small, **observed** run whose purpose is meeting the provider
— rate-limit behaviour, real token accounting, real latency — and which is explicitly *not* the pilot
starting. Findings from it are recorded as provider observations, not as results.

**Calendar stop.** If Stage 1 has not reached its pre-registered *n* by a stated date, that is not a
reason to keep waiting. **Insufficient decision rate is itself a result**, and it changes the design
rather than extending the clock — a narrower universe produces too few decisions to evaluate, and that
is a finding about the strategy family, not a scheduling problem.

- The date is set **once the pilot gives a decision rate**, as `n ÷ observed decisions per day`, plus
  a stated margin.
- An **outer bound applies regardless**: if Stage 1 has not concluded within **90 days** of first
  accumulation, it stops and the design is revisited whatever the rate turns out to be.

Without the outer bound, slow accumulation becomes indefinite drift, and drift is how a programme
avoids ever producing a verdict. The 90 days is likewise a convention to be confirmed, not derived.

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

2. **"Decisive" versus "marginal" — the operator's number, and the one to write first.** Not a
   statistical question and not the builder's to answer. Everything in (1) derives from it, so it is
   the load-bearing blank, and it is the one most easily contaminated by exposure to a result — a
   threshold set after seeing a number tends to land just below it. **Write it before WP3 runs.**

   **What is actually being priced.** Not "is the edge positive". It is: *how much better than a
   deterministic baseline must an LLM pair be to justify nondeterminism, a prompt-injection surface,
   metered spend, and a review burden that has already consumed a week?* No amount of data answers
   that, which is exactly why it is written before the data arrives.

   **Express it per decision, not as a percentage of P&L.** At small *n* and small capital a
   percentage is dominated by one or two trades; expectancy per decision is stable and comparable
   across arms.

   **A self-scaling form worth considering:** net edge over `S0_SAFE` per decision, as a **multiple of
   model cost per decision**. That asks the question directly — is the pair worth what it costs to run
   — and it does not need re-deriving when model prices move.

   **Every band needs an action, not just a boundary.** This is the part that makes it a
   pre-registration rather than a number:

   | Band | Condition | Action — operator to state |
   | --- | --- | --- |
   | Above | edge/decision ≥ **[X]** × model cost/decision | Proceed to Stage 2 (and nothing else) |
   | **Middle** | 0 < edge/decision < **[X]** × model cost/decision | **[state it: redesign, or stop]** |
   | Below | edge/decision ≤ 0 | Stop |

   **The middle band is the one that matters**, because almost every real result lands there, and
   because "marginal" will be read as "proceed carefully" unless something else is written down. If
   marginal means redesign, write *redesign*. If it means stop, write *stop*. A pre-registration whose
   middle band is unstated has pre-registered nothing.
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
