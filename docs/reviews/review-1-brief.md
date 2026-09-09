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

Nothing else in `pipeline.ts` changed. In particular it was **not** split into smaller modules,
despite being the largest module in the highest-trust deployable (710 lines, 47KB, a single
~530-line `ExecutorPipeline` class). That was deliberately deferred so the reviewer reads the same
code the M3 evidence and the drills refer to; whether its size impedes review is itself worth saying
in the findings.

## Known-open defects the reviewer should not have to find

Reported and left open on purpose, so they do not consume review budget as "new" findings. Confirming
or disputing the severities is fair game; rediscovering them is waste.

- **DEFECT-2** — `apps/worker/src/roles/journal-import.ts:60-63`. `page.head` is never compared with
  the import cursor, so an executor whose journal was reset returns an empty page forever and the
  role reports healthy. Audit-completeness (§15.10, §20.25).
- **DEFECT-3** — `apps/risk-authorizer/src/main.ts:72`. `chainStanding()` caches the verification
  verdict on the Postgres ledger head hash, but verifies the *external checkpoint replica file* — two
  different stores, no TTL. A quiet ledger means replica loss or tampering goes unnoticed (ADR-0009
  P2). This one is inside the isolated authorizer and is the most safety-relevant of the three.

Both are instances of one class described at the end of that probe document: *a cheap local value
stands in for an expensive remote one, and the substitution is sound only while the two cannot
diverge.* DEFECT-1 was the first, and the 2026-09-09 review's two CRITICALs were the same family. A
reviewer looking for more of these is looking in a productive direction.

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
