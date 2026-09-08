# M5a pipeline evidence — 2026-09-08 (gate met 03:33 UTC)

Execution plan §4 "M5a — First paper trade", exit gate: "First end-to-end PAPER trades from live market data using S0 only, in an attended Profile 1A session, each visible as an action cycle in the ledger. `STARTING` warm-up test green. One recorded `S0_SAFE` decision can be reconstructed from its stored inputs; the parity suite is green; the fill model is documented and its parameters versioned."

The authoring session built every M5a package, ran the worker against the hosted Supabase project (`jwujkzorirttwgsdoztq`, migrations through 002000 applied with `supabase db push`), observed the pipeline reach an ACTIVE attended P1A paper session, and at 03:31–03:33 UTC recorded the first momentum trigger, both S0 decisions and the first paper trade. The gate items below are each met; the "Trade record" section holds the rows.

## Gate items

| Gate item | Status | Evidence |
| --- | --- | --- |
| First end-to-end PAPER trades from live market data using S0 only | **Pass** | Session `e502e4df` (P1A, attended, PAPER) ACTIVE with the presence tool heartbeating; candidate `69d04f65` (STONK, momentum-v1 score 82, eight conditions passed) detected 03:31:04 UTC from live Birdeye candles; `S0_RAW@1.0.0` cycle `31f6060f` CLEARED (ungated baseline, review non-blocking) → risk evaluation `6f758b38` allowed 200 USDC (max position value cap) → intent `6d1ecf9d` → paper attempt `68134b42` FINALIZED at slot 445236877 → fill 200 USDC → 964 781 907 526 base units (shortfall −23 bps, price improved) → position `504dcf14` OPEN with one MONITORED_EXIT lot, sleeve committed 200 of 4 000 USDC; `S0_SAFE@1.0.0` cycle `9610089b` REJECTED on `OVEREXTENDED_1H` (the safety gate held back what the baseline took, exactly the counterfactual split the plan asks for). Position monitor marked it 30 s later (uPnL −0.47 USDC, stop 0.1907 ATR 8 %). Level B probes captured: ENTRY_REFERENCE, DECISION, EXECUTABLE, EXIT_MARK. |
| Each trade visible as an action cycle in the ledger | **Pass** | Two rows in `agents.action_cycles` for the candidate (`31f6060f` RAW CLEARED with `intent_id` and `risk_evaluation_id` set; `9610089b` SAFE REJECTED, reason `OVEREXTENDED_1H`), each with its proposal and adversarial review row; the Control Room and Positions pages read these rows. |
| Attended Profile 1A session | **Pass** | `ops.runtime_sessions` `e502e4df`: profile P1A, attended true, capital authority PAPER, ACTIVE, `last_presence_heartbeat_at` advancing every minute from `tools/session-presence.mjs`; the previous P0 session was ended through an accepted END_SESSION control request. |
| `STARTING` warm-up test green (D63) | **Pass** | Observed on the hosted project: the session sat in `STARTING` from 23:28 to 00:06 UTC with `WARMUP_SUFFICIENT` failing (`0 of 0 tracked assets warm`), then `FEEDS_FRESH` failing, and moved `STARTING → WATCH → ACTIVE` only after all six gates passed (`ops.runtime_sessions.cold_start_gates`, transitions recorded with actor `WORKER`). `libs/risk/src/runtime-session/cold-start.spec.ts` holds the property that STARTING cannot leave while any fact is unhealthy. Candidate scoring is independently blocked per asset by `FEATURES_COLD` (`libs/signals/src/candidates/detector.ts`). |
| One recorded `S0_SAFE` decision reconstructible from stored inputs | **Pass (test and live decision)** | Re-run 03:36 UTC against the real rows: `decideS0` over the stored candidate, stored feature snapshot `feature_snapshot_id`, stored strategy version rows and the versioned gate policy `s0-gate-v1`, with `now` = the stored `started_at`, reproduced both cycles exactly (RAW: CLEARED/CONFIRM/[S0_RAW_UNGATED, OVEREXTENDED_1H]; SAFE: REJECTED/REJECT/[OVEREXTENDED_1H], same objections). The paper fill reproduced from the stored DECISION and EXECUTABLE probes, the stored intent and `paper-fill-v1`: output 964 781 907 526 and shortfall −23 bps, identical to the stored fill. No provider and no current state were read. |
| Parity suite green | **Pass** | `libs/execution/src/adapter/paper-adapter.spec.ts` runs the eleven-scenario table in `parity.ts` against the paper adapter; the live adapter runs the same table in M7. |
| Fill model documented and versioned | **Pass** | `PaperFillPolicy` `paper-fill-v1` (`libs/contracts/src/policy/paper.ts`); `libs/execution/src/adapter/fill-model.ts` header documents the decision-quote → executable-quote → pre-submit chain → allowance-once → below-minimum-is-NOT_LANDED rule; every paper fill records the policy version and the decision quote. |

## What the session gate found (M4 fixes landed today)

Running the runtime session against the hosted data exposed three defects the gate would otherwise have hidden behind "healthy" feeds:

| Defect | Fix | Commit |
| --- | --- | --- |
| Candle ingestion starved under the Lite per-cycle budget: same-priority assets ordered by id, dead tokens took every slot, eligible assets unrefreshed since 19:14 UTC while `CANDLES` reported HEALTHY | Stalest-first planner, empty-fetch backoff, eligible-first tracking; verified offline that the provider returned 211 fresh candles for an eligible asset the worker had not asked for | `6afa202` |
| A mint absent from chain retried at the head of every eligibility batch | Recorded as a BLOCKED hard reject (`MINT_NOT_INITIALIZED`) | `ebaa58a` |
| Eligibility feed health reset on restart; a cycle touching no Birdeye class left `TOKEN_OVERVIEW`/`TOKEN_SECURITY` FAILED and blocking | State restored from `ops.provider_health`; an uncalled, unknown class publishes NO_DEMAND with no effect | `a7ddd14` |

## Hosted state at 03:35 UTC

| Measure | Value |
| --- | --- |
| Assets | 22 ELIGIBLE · 128 BLOCKED · 153 total |
| Feature snapshots in the last 10 min | 24 assets computed (incl. the SOL reference series), 6 warm |
| Portfolio snapshots | 783 (paper book, equity 10 000 USDC, 200 USDC exposure after the fill) |
| Birdeye compute units this month | 32 870 of 2 500 000 |
| Session transitions | P0 session ended by control request; P1A session `e502e4df` OFF→STARTING (SCHEDULE) → WATCH → ACTIVE with presence PRESENT |
| Action cycles / positions | 2 / 1 |

## Known limit for the operator

Birdeye Lite cannot refresh continuous 1m candles for ~20 assets every minute: the monthly allowance permits roughly one refresh per asset every 15–20 minutes, so features are warm in bursts and the momentum trigger sees fresh inputs only shortly after each refresh. The stalest-first planner spreads the budget fairly; raising the tier or narrowing the tracked set is the operator's call and changes how often S0 can fire.

## Gate closure

Every exit-gate item is met by the rows above; the plan §8 M5a checkbox is ticked with this record as evidence. M5a is not an adversarial-review gate (reviews sit at M1, M3, M6, M8a, M11); the M5a code was reviewed at the interim M4 review and will be inside review #1's scope where it touches the financial boundary. The paper session keeps running: further trades accrue as triggers fire and the position monitor manages the open lot to its stop, trail, time stop or safety exit.
