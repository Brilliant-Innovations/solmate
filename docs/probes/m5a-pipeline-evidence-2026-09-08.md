# M5a pipeline evidence — 2026-09-08 (gate not yet met)

Execution plan §4 "M5a — First paper trade", exit gate: "First end-to-end PAPER trades from live market data using S0 only, in an attended Profile 1A session, each visible as an action cycle in the ledger. `STARTING` warm-up test green. One recorded `S0_SAFE` decision can be reconstructed from its stored inputs; the parity suite is green; the fill model is documented and its parameters versioned."

This is a progress record, not a gate closure. The authoring session built every M5a package, ran the worker against the hosted Supabase project (`jwujkzorirttwgsdoztq`, migrations through 002000 applied with `supabase db push`) and observed the pipeline reach an ACTIVE paper session. No momentum trigger has fired yet, so no paper trade exists. The gate stays open until the first attended paper trades are recorded.

## Gate items

| Gate item | Status | Evidence |
| --- | --- | --- |
| First end-to-end PAPER trades from live market data using S0 only | **Open** | Pipeline armed: session `6c5b93e2` on the hosted project is `ACTIVE` with `PAPER` authority; `candidates_cycle` scans 19 eligible assets every minute (7 warm at the last check, the rest still accumulating lookback); every scan so far ended `NO_TRIGGER` or `FEATURES_COLD`. Zero rows in `signals.candidates`, `agents.action_cycles`, `trading.intents`, `trading.positions` on the hosted project as of 00:30 UTC. |
| Each trade visible as an action cycle in the ledger | **Mechanism proven, no live rows yet** | `libs/strategies/src/s0/decide.spec.ts` and `apps/worker/src/roles/paper-entry.spec.ts` show CLEARED S0_SAFE cycle → risk evaluation → intent → paper fill → position with lot; `libs/db/src/server/paper-repo.integration.spec.ts` and `positions-repo.integration.spec.ts` write the same rows against the local database. |
| Attended Profile 1A session | **Open (operator action)** | The local worker runs with `DEPLOYMENT_PROFILE=P0`, so presence is `NOT_REQUIRED` and the session activated without a heartbeat. For the attended evidence run the worker with `DEPLOYMENT_PROFILE=P1A` and keep `node tools/session-presence.mjs deploy/profile-0/.env.worker` open; `apps/worker/src/roles/session.spec.ts` proves WATCH ↔ ACTIVE follows the heartbeat. |
| `STARTING` warm-up test green (D63) | **Pass** | Observed on the hosted project: the session sat in `STARTING` from 23:28 to 00:06 UTC with `WARMUP_SUFFICIENT` failing (`0 of 0 tracked assets warm`), then `FEEDS_FRESH` failing, and moved `STARTING → WATCH → ACTIVE` only after all six gates passed (`ops.runtime_sessions.cold_start_gates`, transitions recorded with actor `WORKER`). `libs/risk/src/runtime-session/cold-start.spec.ts` holds the property that STARTING cannot leave while any fact is unhealthy. Candidate scoring is independently blocked per asset by `FEATURES_COLD` (`libs/signals/src/candidates/detector.ts`). |
| One recorded `S0_SAFE` decision reconstructible from stored inputs | **Pass (test), no live decision yet** | `decide.spec.ts` property: identical stored inputs (candidate, feature snapshot, strategy version, gate policy, clock) reproduce the identical cycle, proposal and review; the gate reads only the stored snapshot and never a provider. Will be re-run against a real stored decision once one exists. |
| Parity suite green | **Pass** | `libs/execution/src/adapter/paper-adapter.spec.ts` runs the eleven-scenario table in `parity.ts` against the paper adapter; the live adapter runs the same table in M7. |
| Fill model documented and versioned | **Pass** | `PaperFillPolicy` `paper-fill-v1` (`libs/contracts/src/policy/paper.ts`); `libs/execution/src/adapter/fill-model.ts` header documents the decision-quote → executable-quote → pre-submit chain → allowance-once → below-minimum-is-NOT_LANDED rule; every paper fill records the policy version and the decision quote. |

## What the session gate found (M4 fixes landed today)

Running the runtime session against the hosted data exposed three defects the gate would otherwise have hidden behind "healthy" feeds:

| Defect | Fix | Commit |
| --- | --- | --- |
| Candle ingestion starved under the Lite per-cycle budget: same-priority assets ordered by id, dead tokens took every slot, eligible assets unrefreshed since 19:14 UTC while `CANDLES` reported HEALTHY | Stalest-first planner, empty-fetch backoff, eligible-first tracking; verified offline that the provider returned 211 fresh candles for an eligible asset the worker had not asked for | `6afa202` |
| A mint absent from chain retried at the head of every eligibility batch | Recorded as a BLOCKED hard reject (`MINT_NOT_INITIALIZED`) | `ebaa58a` |
| Eligibility feed health reset on restart; a cycle touching no Birdeye class left `TOKEN_OVERVIEW`/`TOKEN_SECURITY` FAILED and blocking | State restored from `ops.provider_health`; an uncalled, unknown class publishes NO_DEMAND with no effect | `a7ddd14` |

## Hosted state at 00:30 UTC

| Measure | Value |
| --- | --- |
| Assets | 19 ELIGIBLE · 1 EVALUATING · 114 BLOCKED |
| Feature snapshots in the last 10 min | 21 assets tracked (incl. the SOL reference series), 7 warm |
| Portfolio snapshots | 225 (paper book, equity 10 000 USDC, no exposure) |
| Birdeye compute units this month | 22 220 of 2 500 000 |
| Session transitions | OFF→STARTING (SCHEDULE) · STARTING→WATCH (WORKER) · WATCH→ACTIVE (WORKER) |

## Known limit for the operator

Birdeye Lite cannot refresh continuous 1m candles for ~20 assets every minute: the monthly allowance permits roughly one refresh per asset every 15–20 minutes, so features are warm in bursts and the momentum trigger sees fresh inputs only shortly after each refresh. The stalest-first planner spreads the budget fairly; raising the tier or narrowing the tracked set is the operator's call and changes how often S0 can fire.

## Remaining to close M5a

1. First paper trades in an attended P1A session (operator runs the worker as P1A with the presence tool; the pipeline then needs a trigger to fire).
2. Re-run the reconstruction check against a real stored `S0_SAFE` decision and record it here.
3. Fresh-session adversarial review with `docs/implementation/GUARDRAILS.md` Part 3 as the checklist, findings in `docs/reviews/`.
