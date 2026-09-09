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

**Not fixed here.** It is a change in the execution boundary, which is what adversarial review #1 is
meant to scrutinise, and the operator's ranking is to run that review before writing more code
there. The shape of the fix: `syncShadow` already returns `lastSynced`, so the worker can push when
the executor is behind rather than when its own journal changed — which also covers the
executor-restart case, not just the attach case.

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
