# Adversarial review #1 (M3, financial boundary) — brief for the reviewing session

Review #1 is the M3 gate: the execution boundary and the risk-authorization path, with
`GUARDRAILS.md` Part 3 (§32) as the checklist. It has not been run. Per Part 1 rule 4 it must be run
by a **different session** from the authoring ones, and the operator has asked for a **different
model family** as well — the fresh-session rule buys context-independence, not model-independence,
and for the financial boundary specifically both are wanted.

This file exists to carry facts a reviewer would otherwise have to rediscover. It is not a summary of
the code and it does not tell the reviewer what to conclude.

## What changed after the M3 evidence was written

`apps/execution-service/src/pipeline/pipeline.ts` — **the M3 evidence predates the current file.**
The reviewer should not assume the M3 status document describes what is there now.

| When | Change | Why it matters to this review |
| --- | --- | --- |
| 2026-09-09 (WP0) | `ExecutorPipeline.syncShadow` — `shadow.sequence <= last` split into `< last` (`SHADOW_REGRESSION`) and `=== last` (`{ok: true, state: 'IN_SYNC'}`). The return type gained `state: 'APPENDED' \| 'IN_SYNC'`. | It relaxes a refusal in the DB-down protection path (D22, §15.10A). The safety argument is that the worker derives sequences from an append-only journal, so an equal sequence implies an equal book, and a wiped worker journal restarts at 1 and is still refused as strictly lower. **That argument deserves adversarial attention** — it is the one place where a check that used to refuse now accepts. Rationale and reproduction: `docs/probes/profile-0-executor-attached-2026-09-09.md` (DEFECT-1). |
| 2026-09-09 (WP0 follow-up) | `apps/risk-authorizer/src/main.ts` — `chainStanding()`'s cache key now names both stores (`chainStandingCacheKey(ledgerHead, replicaCheckpoint)`, exported from `libs/db/src/server/audit.ts`) and the entry expires after `CHAIN_STANDING_TTL_MS = 30_000`. `chainStanding` itself was **not** restructured. | **This is inside one of the two deployables the gate scrutinises**, and it changes an integrity control (ADR-0009 P2). Two things to weigh: the replica is now read on every call, where before it was read only on a cache miss — a per-request file read in the authorizer's hot path, deliberately accepted because it is the cheap half of the verification and the half that makes a vanished replica visible. And the 30 s TTL has a derivation, which is the right way to argue about it: it bounds how long a vanished replica stays invisible, so the question is how many authorizations can pass inside that window. At Profile 2's attended tiny-live entry rate — `LIVE_ENTRY_INTERVAL_MS` 15 s, and candidates that clear the adversarial cycle far more rarely than every other tick — that is on the order of **one trade**. The number to argue about is therefore "at most one authorization may pass on an unverified replica", not "30 seconds". A reviewer who wants zero should say so, and the cost of zero is the full `verifyAuditChain` walk on every request. Identity cases: `libs/db/src/server/audit-cache-key.spec.ts`. |
| 2026-09-09 (WP0 follow-up) | `apps/worker/src/roles/journal-import.ts` — a `page.head` below the import cursor now raises `EXECUTOR_JOURNAL_RESET` and stops importing (DEFECT-2). | `apps/worker`, so outside review #1's two deployables, but it changes what the executor's journal API is trusted to mean, and the reviewer is looking at the other end of that contract. It also newly relies on the executor reporting `head` honestly. |
| 2026-09-09 (WP0 follow-up) | `apps/worker/src/roles/shadow-sync.ts` — a refused push now raises `SHADOW_SEQUENCE_REGRESSION` once, via a new optional `alerts` dependency. | Same: worker-side, but it is the observability half of the `syncShadow` contract above. It deliberately does **not** pause new entries — see the open question below. |

Nothing else in `pipeline.ts` changed. In particular it was **not** split into smaller modules,
despite being the largest module in the highest-trust deployable (710 lines, 47KB, a single
~530-line `ExecutorPipeline` class). That was deliberately deferred so the reviewer reads the same
code the M3 evidence and the drills refer to; whether its size impedes review is itself worth saying
in the findings.

## Known-open defects the reviewer should not have to find

Reported and left open on purpose, so they do not consume review budget as "new" findings. Confirming
or disputing the severities is fair game; rediscovering them is waste.

~~DEFECT-2 and DEFECT-3 are open.~~ **Both were fixed on 2026-09-09, later the same day** — see the
table above for what changed and what to weigh. What remains open is one deliberate omission:

- **~~Open question: should a persistent shadow regression pause new entries?~~ Decided yes by the
  operator, 2026-09-09, and implemented.** The asymmetric wipe — our shadow journal lost, the
  executor's intact — disables DB-down protection in both directions and never self-corrects, so
  `shadow-sync` now sets the sticky entry pause `SHADOW_PROTECTION_UNAVAILABLE` alongside the CRITICAL.
  The reasoning was that this is not a new policy invention: §13.6 already blocks entries whenever the
  infrastructure that makes trading safe is absent (`FEEDS_STALE`, `SESSION_NOT_ACTIVE`,
  `CUSTODY_MISMATCH`, `DB_UNAVAILABLE`), and opening a position that provably cannot be protected is
  the strongest instance of that category, not a new one. It rides on §21.2C's `ops.entry_pauses`
  rather than a new `RISK_REASONS` member, so the versioned risk policy and the contract lock are
  untouched — the same mechanism `journal-import` uses. Cleared only by step-up `RESUME_NEW_ENTRIES`,
  with the reconciliation procedure in `docs/runbooks/infrastructure-loss-chain-first-recovery.md`.
  **What is still worth a reviewer's attention:** this makes a worker-side role able to halt trading,
  which is correct here but is a capability worth confirming is narrowly held.

### A sub-pattern worth its own search: the cause gets fixed, the detector does not

DEFECT-4 (`docs/probes/data-budget-2026-09-09.md`) was **found once already and half-fixed**. On
2026-09-08 the symptom was recorded in the changelog in as many words — "`WARMUP_SUFFICIENT` never
passed because 1m candles for every eligible asset had stopped hours earlier **while CANDLES reported
HEALTHY**". The planner starvation underneath it was diagnosed and fixed. The detector that had just
demonstrated it would report HEALTHY over hours-old data was left exactly as it was, and went on
saying so for another day, until someone queried the table directly.

A detector is code too, and the incident that exposes it is the only occasion anyone has reason to
look at it. So: **wherever an incident report names a monitor, alarm, health row or gate that failed
to fire, check whether that monitor was changed.** In this repository the honest answer so far is
usually no. Candidate starting points — none of these have been audited, they are named because they
are the same shape:

- every `ops.provider_health` class other than `CANDLES` (`TOKEN_OVERVIEW`, `TOKEN_SECURITY` and
  `DISCOVERY_LIST` were fixed only incidentally, by the shared evaluator);
- the cold-start gates (`WARMUP_SUFFICIENT`, `FEEDS_FRESH`) which consume that same health;
- `ops.watchdog_runs` and the resume watchdog, whose own telemetry row is written by the thing it
  watches;
- the readiness drills, which report FAIL honestly today but have never reported PASS anywhere real.

All four defects are instances of one class described at the end of that probe document: *a cheap
local value stands in for an expensive remote one, and the substitution is sound only while the two
cannot diverge.* The 2026-09-09 review's two CRITICALs were the same family, making five. A reviewer
looking for more of these is looking in a productive direction — and the audit that found DEFECT-2
and DEFECT-3 covered worker roles and the authorizer's cache, **not** `pipeline.ts`'s internals,
which is this review's ground.

## A structural note the reviewer should weigh: the authorizer's startup path cannot be tested

`apps/risk-authorizer/src/main.ts` calls `main()` at module load. Nothing in it can be imported, so
nothing in it can be unit tested — and `main()` is where the environment is validated fail-closed, the
signing keys are imported, the RPC allowlist is enforced, the internal-API secrets are required, and
the chain-standing cache lives. That is a meaningful surface of one of the two deployables this gate
exists to scrutinise, and it is covered today only by the service-level specs beneath it and by
running the process.

It surfaced concretely while fixing DEFECT-3: the cache-key logic had to be **moved** into
`libs/db/src/server/audit.ts` to be testable at all. That is defensible on its own terms — checkpoint
identity does belong with the checkpoint code — but the reason it moved was testability, not design,
and "we could not test it there, so we moved the testable part elsewhere" is a pattern that will
recur and will gradually hollow out `main.ts` into the one place nothing is verified. Worth a finding
either way: either the entrypoint should be split so its startup path is importable, or the review
should say explicitly that this surface is accepted as process-tested only.

Not fixed, because restructuring the authorizer's entrypoint is exactly the kind of change this gate
should authorise rather than inherit.

## What the boundary has and has not executed

- The three deployables have run as real processes together exactly once (2026-09-09), on a paper
  profile with `SIGNER_BACKEND=SOFTWARE_DEV` and `liveCapabilityEnabled=false`.
- No transaction has ever been signed by a production signer. `TurnkeySigner` exists and is covered
  by key-free tests against a fake transport; it has never spoken to Turnkey. Probe A/C are unrun.
- The executor journal has never recorded a real attempt: `attemptsAudited: 0`. Paper entries use the
  in-process adapter and never reach the executor.
- `DB_DOWN_EMERGENCY_CLOSE` and `PERSIST_BEFORE_SUBMIT_DRILL` have never returned PASS anywhere
  except against the in-process spec harness, and on a paper profile they structurally cannot.

The gap between "covered by tests" and "has executed in its target environment" is where every
serious finding so far has lived. That is the most useful prior a reviewer can carry into this.
