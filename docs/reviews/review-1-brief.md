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
| 2026-09-09 (WP0 follow-up) | `apps/risk-authorizer/src/main.ts` — `chainStanding()`'s cache key now names both stores (`chainStandingCacheKey(ledgerHead, replicaCheckpoint)`, exported from `libs/db/src/server/audit.ts`) and the entry expires after `CHAIN_STANDING_TTL_MS = 30_000`. `chainStanding` itself was **not** restructured. | **This is inside one of the two deployables the gate scrutinises**, and it changes an integrity control (ADR-0009 P2). Two things to weigh: the replica is now read on every call, where before it was read only on a cache miss — a per-request file read in the authorizer's hot path, deliberately accepted because it is the cheap half of the verification and the half that makes a vanished replica visible. And 30 s is a chosen number with no derivation behind it: it bounds how long a *silent* divergence can persist, and a reviewer may well argue it should be shorter, longer, or configurable. Identity cases: `libs/db/src/server/audit-cache-key.spec.ts`. |
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

- **Open question for the gate: should a persistent shadow regression pause new entries?** The
  asymmetric wipe — our shadow journal lost, the executor's intact — disables DB-down protection in
  both directions: the executor would plan against a book from before the wipe, and it refuses our
  monitor commands as `SHADOW_STALE` because our sequence is below what it holds. It never
  self-corrects. It now raises a CRITICAL, which is observability. Whether the system should also
  stop opening new exposure while its DB-down protection is known-broken is a trading-behaviour
  policy question, and it was left to the operator rather than decided in a defect fix. `journal-import`
  sets a sticky entry pause for its comparable case, which is an argument that this should too.

All three defects are instances of one class described at the end of that probe document: *a cheap
local value stands in for an expensive remote one, and the substitution is sound only while the two
cannot diverge.* The 2026-09-09 review's two CRITICALs were the same family, making five. A reviewer
looking for more of these is looking in a productive direction — and the audit that found DEFECT-2
and DEFECT-3 covered worker roles and the authorizer's cache, **not** `pipeline.ts`'s internals,
which is this review's ground.

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
