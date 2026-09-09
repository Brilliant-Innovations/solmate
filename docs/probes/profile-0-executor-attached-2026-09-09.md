# Profile 0 with the executor attached — what running it actually proved (2026-09-09)

First time the worker → execution-service → risk-authorizer path has run as three real processes
outside a spec harness. The goal was the reviewer's: turn `DB_DOWN_EMERGENCY_CLOSE` and
`PERSIST_BEFORE_SUBMIT_DRILL` from "exercised by a spec against the harness" into "exercised against
processes that actually ran", key-free, with no Turnkey and no D65 exposure.

It did that, and it immediately found a defect that no spec could have found. That is the point of
the exercise, so it is recorded first.

## DEFECT-1 — the position shadow is pushed only when it changes, so an executor that attaches later never receives one

**Severity:** high. It silently disables the DB-down emergency close (§15.10A, D22), which is the
path that exists for when Postgres is gone.

`runShadowSyncCycle` (`apps/worker/src/roles/shadow-sync.ts:75`) compares the freshly built shadow
against the newest entry in the worker's **local** journal and returns early when they match:

```ts
if (latest && latest.fingerprint === fingerprint) return { mode: 'UNCHANGED', ..., pushed: 'SKIPPED' };
```

The early return happens before the `deps.executor.syncShadow(shadow)` call. So the executor is
pushed to only on the cycle where the shadow *changed*. The worker's journal is the only thing
consulted; what the executor holds is never considered.

**Reproduced 2026-09-09.** The worker's shadow journal
(`%LOCALAPPDATA%/solmate/position-shadow.jsonl`) held exactly one entry: sequence 1, zero positions,
recorded `2026-09-08T19:30:35.811Z` during the previous smoke. A freshly started execution-service
was attached, the worker was started with `WORKER_ROLES=shadow-sync` and logged
`shadow_sync_starting` with `executor: true` — the wiring was live. Every subsequent cycle rebuilt an
identical zero-position shadow, matched the day-old fingerprint, took the `UNCHANGED` branch and
pushed nothing. Two `db-down-close` drills minutes apart both returned:

```
{"drill":"db-down-close","ok":true,"actions":0,"skipped":0,"holdings":0,"closeableHoldings":0,
 "custodySlot":495798858,"shadowSequence":null,...}
FAIL: the executor has no synced position shadow, so a DB-down close would have no bounds to plan against
```

`shadowSequence: null` after the shadow-sync role had been running against a reachable executor for
minutes. The executor never receives a shadow until a position changes.

**Why it matters beyond this drill.** The same hole opens whenever an executor restarts while
positions happen to be stable — the worker's journal still says "unchanged", so it never re-pushes,
and the executor sits with a stale or absent shadow for as long as the portfolio is quiet. A quiet
portfolio is exactly when nobody notices. If Postgres then goes down, the executor has no bounds to
plan a close against, and the emergency path is unavailable precisely when it is needed.

**Why no test caught it.** In every spec the journal starts empty, so the first cycle is always a
change and always pushes. The bug needs a journal that outlives the executor — state across process
lifetimes, which only a real deployment has. This is the "does this actually execute in its target
environment" gap the 2026-09-09 review named, and it is the second time that gap has produced the
real finding.

**~~Not fixed here.~~ Fixed in WP0 later the same day — see the follow-up at the end of this file.**
The original paragraph deferred it to adversarial review #1 and proposed a fix shape that does not
work, and both are left visible rather than edited away:

> It is a change in the execution boundary, which is what adversarial review #1 is meant to
> scrutinise… The shape of the fix: `syncShadow` already returns `lastSynced`, so the worker can push
> when the executor is behind rather than when its own journal changed.

Two things wrong with that. The deferral argument applies to *refactoring* the execution boundary,
not to repairing a live high-severity defect adjacent to it, and `shadow-sync.ts` is `apps/worker`
anyway. And `lastSynced` is returned **only on the refusal branch** (`pipeline.ts:698`); the success
branch returns `{ok: true, sequence}`, so there was nothing to read it from. Worker-side memory of
the last push would also have missed the case that matters most — an *executor* restart, which the
worker has no way to observe.

## What the two drills actually reach on a paper profile

Neither can be readiness evidence here, and both say so honestly rather than passing on a zero state.
Those guards were added by review 2026-09-09 (M-6, M-7) for exactly this reason.

| Drill | Verdict | Why |
| --- | --- | --- |
| `DB_DOWN_EMERGENCY_CLOSE` | **FAIL** | DEFECT-1: `shadowSequence: null`. With that fixed it would reach the next guard, `closeableHoldings == 0`, and record NOT_APPLICABLE — a paper wallet holds no closeable custody, and a planned close of zero actions demonstrates nothing. |
| `PERSIST_BEFORE_SUBMIT_DRILL` | **NOT_APPLICABLE** | `attemptsAudited: 0`. Paper entries go through the in-process adapter (`apps/worker/src/roles/paper-entry.ts:156`) and never touch the executor, so its journal has no attempt to audit. `journalHead: 2` — the journal exists and is readable, there is simply nothing of this kind in it. |

Both become real evidence only against a funded wallet that has executed through the executor, which
is Profile 2 and therefore behind Probe A/C. Standing the services up cannot change that, and the
earlier expectation that it would was wrong.

## What it did prove

Not nothing, and not what was expected:

- Three services start from their own credential files with no cross-reads, and both internal APIs
  bind and serve (`event: listening` on `127.0.0.1:8791` and `:8781`).
- The HMAC request signing in `ExecutorClient` (`signServiceRequest`) is accepted by the real server.
  A bearer token is refused `401 MISSING_HEADERS`, so the scheme is enforced, not assumed.
- Both deployables report the same contract-set digest
  `927863837e7654205486d10943f568686c6f09b519652c1a15fc02bf143319ef` — D50's "two deployables with
  different contract digests both become live" check, exercised across processes rather than in a
  unit test.
- The executor reads chain custody for real: `custodySlot: 495798447` then `495798858` on the second
  call, a live slot advancing between drills.
- `health()` reports `signer: {backend: SOFTWARE_DEV, state: HEALTHY, policyDigest: null}` with the
  detail "development signer: no external policy layer (D55 does not apply below live capability)" —
  which is what `SIGNER_POLICY_DIGEST_MATCHES` correctly refuses to accept as attestation.
- The drill round trip runs end to end against a real process for the first time.

## Two operational traps found while doing it

1. **`set -a; . .env.execution-service` silently corrupts `EXECUTOR_GUARDRAILS_JSON`.** The shell
   strips the quotes from `{"liveCapabilityEnabled":false}`, and the service dies with
   `env_invalid: Expected property name or '}' in JSON at position 1`. The README's "reads its own
   env file from the shell you start it in" invites this. Use Node's `--env-file`, which parses
   dotenv properly and is what the container route does. The README now says so.
2. **The env templates could not stand these services up.** `.env.execution-service.example` and
   `.env.risk-authorizer.example` were missing `INTERNAL_API_LISTEN`, `INTERNAL_API_SECRETS`,
   `OUT_OF_BAND_LISTEN`, `EXECUTOR_JOURNAL_PATH`, `SOFTWARE_SIGNER_KEY_PKCS8`, `DEPLOYMENT_PROFILE`
   and `SERVICE_INSTANCE_ID`; `.env.worker.example` mentioned `EXECUTION_SERVICE_URL` only in prose
   and never named `INTERNAL_API_SECRET`. All three are filled in, and `tools/dev-keys.mjs` now mints
   the shared internal-API secret and emits it into all three blocks from one value, so the pair
   cannot disagree.

## Reproducing

```sh
node tools/dev-keys.mjs            # paste each block into its own gitignored env file
node --env-file=deploy/profile-0/.env.risk-authorizer   apps/risk-authorizer/dist/main.js
node --env-file=deploy/profile-0/.env.execution-service apps/execution-service/dist/main.js
node --env-file=deploy/profile-0/.env.worker            apps/worker/dist/main.js
```

Then file the two drills from Live Readiness `Run drill`, or call `dbDownCloseDrill` /
`persistBeforeSubmitDrill` directly against an `ExecutorClient` built from the worker's env.

---

# WP0 follow-up: DEFECT-1 fixed, and an audit of its defect class

## The fix

Three edits, no behaviour added:

- `apps/worker/src/roles/shadow-sync.ts` — the early return on a matching local fingerprint no longer
  skips the executor. The journal keeps its append optimisation (an unchanged book is not a new
  sequence), but the push happens every cycle, carrying the **shadow of record** — the sequence
  already in the journal, not a freshly minted one. So a quiet book re-sends one sequence repeatedly
  rather than inflating the sequence space.
- `apps/execution-service/src/pipeline/pipeline.ts` — `shadow.sequence <= last` split into
  `< last` (a genuine `SHADOW_REGRESSION`) and `=== last` (`{ok: true, state: 'IN_SYNC'}`). One
  comparison and one return shape; nothing else in that file changed.
- `apps/worker/src/roles/shadow-sync.ts` reports `IN_SYNC` instead of `REGRESSION` and no longer logs
  the benign case at error level.

**Why the equal case is safe without a content check.** The worker derives the sequence from its own
append-only journal, so sequence K maps to exactly one book there. A worker whose journal was wiped
restarts at 1, which is strictly lower than what the executor holds and is still refused — the D22
protection this check exists for is untouched. A fresh or wiped executor has `last === null`, so the
push lands and self-corrects, which is the case DEFECT-1 was about.

**The regression test was proved to fail against the old code**, not merely asserted: reverting
`shadow-sync.ts` alone makes both the new case and the amended existing case fail, and restoring it
makes all four pass. The new test covers an executor holding nothing against a populated journal (the
attach/restart case) and an executor whose sequence is behind the journal's newest (the catch-up
case). Neither can arise from an empty journal, which is why the suite passed throughout.

## The defect class

"Early return on locally computed or locally cached state, placed before the remote push or read it
is standing in for." The question asked of each site: **does the remote side's state get consulted,
or is local state being treated as proof of remote state?**

### Found

| # | Where | Judgement |
| --- | --- | --- |
| DEFECT-1 | `apps/worker/src/roles/shadow-sync.ts` | **Fixed here.** Local journal fingerprint treated as proof the executor held the shadow. |
| DEFECT-2 | `apps/worker/src/roles/journal-import.ts:60-63` | **Open.** `page.head` is assigned to the report and never compared against `lastImported`. The cursor comes from our own audit ledger; the journal it indexes lives on the executor. An executor whose journal was reset — new volume, wiped `EXECUTOR_JOURNAL_PATH`, replaced host — restarts its sequences below our cursor, returns an empty page, and the role reports a healthy `fetched: 0` cycle indefinitely. Consequence: emergency actions taken during a DB outage never reach the audit ledger and the §15.10 operator review gate never fires. Audit-completeness, not live-trading safety, which is why it is reported rather than fixed inside WP0. **Fix shape:** when `page.head !== null && page.head < lastImported`, the executor's journal is not the one our cursor refers to — raise and stop advancing, rather than treating an empty page as "nothing new". |
| DEFECT-3 | `apps/risk-authorizer/src/main.ts:72` | **Open, and the most interesting of the three.** `chainStanding()` caches the verification verdict keyed on the **ledger head hash** read from Postgres, but what it verifies is the **external checkpoint replica file** written by the worker. Two different stores. While the ledger head is unchanged, loss of, truncation of, or tampering with the replica is never noticed, and the cache has no TTL and never expires within the process. The primary threat ADR-0009 P2 defends against — rewriting `audit.events` — still moves the head hash and still misses the cache, so it is caught. What is not caught is the replica going bad while the ledger is quiet: a long-lived authorizer keeps returning a stale `ok: true`. This is the same class in the most safety-critical deployable, and it is one the artifact and boundary rules cannot see. **Fix shape:** key the cache on both the ledger head and the replica's own identity (its latest checkpoint sequence and hash), or give it a short TTL so a quiet ledger still re-reads the replica. |

### Checked and cleared

| Where | Why it is not this class |
| --- | --- |
| `roles/audit-checkpoint.ts` + `FileCheckpointReplicator` | Replicates and re-verifies against the file every cycle. No short-circuit on unchanged state. |
| `roles/state-projector.ts` | No early return; signs and stores a projection every cycle. |
| `roles/readiness.ts` | `signerHealth()` and `computeRows` both run **before** the `same` check, and that check skips a duplicate database *write*, not a remote read. Ordering is the thing that makes it safe, and it is correct. |
| `roles/emergency-dry-run.ts:79-84` | The `due` filter is a cadence gate on the timestamps of our own prior runs — local state throttling local activity. It asserts nothing about the remote. |
| `roles/market-ingest.ts:164-167` | `candleBackoff` is failure-driven exponential backoff, set on failure and cleared on success. Same reasoning: it throttles our own calls, it does not claim the provider's state is unchanged. Cleared for this class — but flagged for WP1, since it is a candidate explanation for unspent Birdeye allowance. |
| `roles/reconciliation.ts`, `chain-health.ts`, `position-monitor.ts`, `live-entry.ts`, `recovery.ts` | Contact their remote every cycle; the returns found are terminal, not short-circuits. |
| `libs/agents/src/action-cycle/machine.ts:205` | An in-memory comparison between two fields of one object. No remote involved. |

### The pattern worth naming

All three found instances share a shape that no boundary rule, artifact scan or unit test catches:
**a cheap local value stands in for an expensive remote one, and the substitution is sound only while
the two cannot diverge.** They diverge exactly when a process restarts, a volume is replaced, or a
file is lost — none of which a test fixture does, because fixtures start empty and live for one test.

That is why this is the third finding in the family after the 2026-09-09 review's two CRITICALs, and
why the useful defence is not another rule but the thing that found it: running the deployables as
real processes with state that outlives them.

## WP0 follow-up 2: DEFECT-2 and DEFECT-3 fixed, and the class closed

Both were reported open above. Both are now fixed, in the same session, so the audit does not have to
be re-derived later.

**DEFECT-2** — `journal-import` compares `page.head` against the import cursor. A head below the
cursor is the executor's own report that its journal is not the one the cursor refers to, so the role
raises `EXECUTOR_JOURNAL_RESET` (CRITICAL, once) and stops rather than advancing over a gap. The
records those sequences pointed at are gone; this is not recoverable in code, and pretending otherwise
by resetting the cursor would silently drop them from the audit ledger.

**DEFECT-3** — the authorizer's chain-standing cache is keyed on `chainStandingCacheKey(ledgerHead,
replicaCheckpoint)` and expires after 30 s. The replica is read on every call, which is the point
rather than the cost: it is the cheap half of the verification and the half that makes a vanished or
replaced file visible. The expensive half — the full `verifyAuditChain` walk — is still skipped while
both stores are demonstrably unchanged. `chainStanding` itself was not restructured.

Two honest notes on that one. The replica file is now read once per authorization request rather than
once per cache miss, which is a real change to the authorizer's hot path. And 30 s is a chosen number
with nothing behind it but judgement; it bounds how long a silent divergence can persist, and review
#1 may reasonably want it different or configurable. Both are flagged in the review brief rather than
buried here.

### The asymmetric wipe: answered

The question was whether a persistent `REGRESSION` raises an alert or is only a log line, and whether
the hole is therefore the same shape one level up. **It was only a log line** — `shadow-sync` had no
alerting capability at all, unlike `journal-import` and `audit-checkpoint` which both do.

Tracing it through was worse than the question assumed. After an asymmetric wipe — our journal lost,
the executor's intact at sequence K — we restart at 1 and every push is refused. But the executor
also holds a shadow from *before* the wipe, and `ExecutorPipeline.emergency` refuses a monitor command
whose `shadowSequence` is below what it holds (`SHADOW_STALE`, `pipeline.ts:349-352`). So the worker's
DB-down protection path is disabled in both directions at once: the executor would plan against a
stale book, and it rejects every emergency close the worker sends it. The only signal was one error
line per cycle from the role least equipped to escalate.

`shadow-sync` now takes an optional `alerts` dependency and raises `SHADOW_SEQUENCE_REGRESSION`
(CRITICAL) once — deduplicated through `openAlertExists`, because repeating the push changes neither
side and a per-cycle alert would be its own kind of noise. It deliberately does **not** pause new
entries. That is a trading-behaviour policy call, `journal-import` makes the opposite choice for its
comparable case, and a defect fix is the wrong place to settle it. It is recorded as an open question
in `docs/reviews/review-1-brief.md`.

### Is the class closed?

For the sites the audit covered, yes — with the boundary stated plainly rather than implied. It
covered every worker role and the authorizer's one cache. It did **not** cover the internals of
`pipeline.ts` or `AuthorizerService`, which are review #1's and review #2's ground and are better
served by a reader who did not write them.

Every one of the three fixes was proved against its own pre-fix code rather than asserted: reverting
`shadow-sync.ts` alone fails the DEFECT-1 cases, reverting `journal-import.ts` alone fails the reset
case, and disabling only the alert branch fails the asymmetric-wipe case. A regression test that
cannot fail is decoration.
