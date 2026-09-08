# M5b evidence — 2026-09-08

Execution plan §4 "M5b — Signal breadth and research features", exit gate: "P3 acceptance complete including the self-influence guard; S0 paper continues across the full trigger set." ADR-0007 note: only the `S0_LIVE_SAFETY` subset (self-influence wiring, cohort inputs with unknown treated as most restrictive, speed/expiry/chase enforcement) gates M8a; the rest is research breadth.

## P3 deliverables (blueprint §35 "P3 — Signal and candidate engine")

| Deliverable | Where | Evidence |
| --- | --- | --- |
| Multi-horizon features | `libs/signals/src/features/engine.ts`, `FEATURE_ENGINE_V2` | M5a; v2 adds `rs_universe_1h`, `rs_cohort_1h` (cross-asset pass in the features role) |
| Relative strength / regime | `libs/signals/src/features/regime.ts`, `regime-v1` | `regime.spec.ts` (fixed rule order, property: permutation-invariant, no label under eight warm assets); observed on the hosted worker: `features_cycle` logs `regime` and `regimeFacts` every minute (six warm assets so far → no label, by design) |
| Deterministic cohorts and correlation clusters | `cohorts-v1`, `clusters-v1`, `libs/risk/src/cohorts`, worker role `cohorts` | `cohorts.spec.ts` (property: partition, min size, order independence), `cohorts-repo.integration.spec.ts` (LLM suggestion refused as ACTIVE by the table); hosted: taxonomy installed with 12 memberships, hourly cluster sets stored (empty on the Lite candle cadence: assets read as unknown cluster capacity) |
| Trigger families | `momentum-v1`, `early-accel-v1`; `libs/signals/src/triggers`, `candidates/detector.ts` | `early-acceleration.spec.ts` (each §9.2 condition, cross-family dedupe, property); hosted `candidates_cycle` scans both families per asset. Smart-money accumulation waits on tracked-wallet flow features; catalyst and social families wait on M6 intelligence |
| Candidate dedupe / cooldown / expiry | detector tail shared by every family; `expireCandidates` | M5a specs; §9.7 aggregation across families (`early-acceleration.spec.ts`) |
| Deterministic momentum baseline | `S0_RAW@1.2.0` / `S0_SAFE@1.2.0` on `S0_TRIGGER_FAMILIES` | first paper trade 03:33 UTC (M5a evidence); versions 1.1.0 and 1.2.0 registered as immutable rows, older rows untouched |
| Self-influence / owned-address suppression guard | `libs/signals/src/self-influence/guard.ts`; candidate-side check in the detector; suppression flag on every feature snapshot from own LIVE fills; owned addresses excluded from flow features (M4) | `guard.spec.ts`, `detector.spec.ts` (rejected with `SELF_TRADE_SUPPRESSION_WINDOW`), `features.spec.ts` (flag inside/outside the window), `candidates.spec.ts`; INV-11 mapped |

## P3 acceptance

| Acceptance | Status | Evidence |
| --- | --- | --- |
| Candidates arise from live data without LLMs | Pass | STONK candidate 03:31 UTC from live Birdeye candles; no LLM package in the worker's candidate path (artifact scan; the worker holds no model key in Profile 1A) |
| Each candidate explains the exact trigger/features | Pass | `triggerDetails` on every candidate: policy version, feature engine version, every input value, passed conditions, score, regime and market sessions (`detector.ts`); the M5a reconstruction re-ran the stored decision from those inputs |
| Baseline can paper-decide candidates by itself | Pass | `S0_RAW`/`S0_SAFE` cycles, risk evaluation, paper fill and position on the hosted project (M5a evidence); S0 now consumes both deterministic families |

## Speed / expiry / chase (S0_LIVE_SAFETY)

- D32 candidate-age contract: `expireS0` produces EXPIRED cycles for a candidate older than `maxCandidateAgeMs` at decision time (`s0.spec.ts`).
- Intent expiry: `liveIntentExpiryMs` bounds every paper intent; the live adapter re-checks intent and authorization expiry and chase tolerance before signing (M3 parity table).
- Cohort inputs: `requireCohortCapacity` makes an unknown cohort or cluster the most restrictive cap (`entry.spec.ts`); the paper-entry role now feeds real usage.

## First full paper round trip and the defect it exposed

The STONK lot opened at 03:33 UTC under `S0_RAW@1.0.0` breached its ATR hard stop at about 04:09 (exit mark 179.2 USDC on a 200 USDC lot). The exit did not execute for four minutes: after the 1.1.0 and 1.2.0 version bumps the position monitor could not find `S0_RAW@1.0.0` among the worker's registered versions (`position_monitor_failed`). The monitor now resolves a lot's strategy version from its immutable row when it is not a current version (worker spec: an older-version lot exits; an unknown version is an error, never a silent hold). After the fixed bundle started at 04:13 the exit filled at 04:14: `position_exit_filled` reason `HARD_STOP`, quantity 964 781 907 526, proceeds 179 431 804, realized −20 568 196 base units, position and lot closed, sleeve commitment released. This is the first complete paper round trip on the hosted project and the first defect caught by a live paper position rather than a test.

## Gate closure

Every P3 deliverable and acceptance item is met and S0 paper-trades the full deterministic trigger set. The plan §8 M5b checkbox is ticked with this record as evidence. M5b is not an adversarial-review gate. Regime labels and empirical clusters will only populate on a richer candle cadence than Birdeye Lite provides; the classifier and the clustering are correct on the data they have and say so (null label, unknown cluster) rather than guess.
