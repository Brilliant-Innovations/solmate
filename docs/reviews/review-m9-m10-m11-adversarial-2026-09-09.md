# Adversarial review — M9 step 8, M10, M11 key-free items (2026-09-09)

**Scope:** commits `6030803~1..HEAD` (11 commits, 118 files) — funding connector, replay/research framework, research surfaces, transitive package policy + SBOM, runbooks, Terraform, automated readiness drills.

**Method:** five fresh reviewer sessions with no authoring context, each assigned one slice of the blueprint §32 checklist (GUARDRAILS Part 3), instructed to construct concrete failures rather than opinions. Their findings were then re-verified by the session that commissioned them; every claim below is marked with its verification status.

**Standing:** this is **not** an adversarial review gate. Gates #1–#4 are tied to M3, M6, M8a and M11 and must be run by a session or human with no authoring context; the commissioning session here holds that context. Treat this as pre-review triage that a real gate should re-cover, not as a substitute for it.

Classification per blueprint §31: DEFECT / MISSING REQUIREMENT / TRADE-OFF / ENHANCEMENT.

---

## Summary

| Severity | Count | Of which verified in-session |
| --- | --- | --- |
| CRITICAL | 2 | 1 reproduced, 1 by unambiguous code reading |
| HIGH | 10 | 8 |
| MEDIUM | 18 | 6 |
| LOW | 6 | 2 |

Two themes dominate:

1. **Unexecuted code shipped as evidence.** The Terraform was never rendered, and the two CRITICAL defects are in the first ten lines of shell it generates. The `PARTIAL_TIERS` branch of the replay book has never run. Both were committed with documentation asserting they work.
2. **Unknowns rendered as zeros.** Discarded query errors, `?? 0` coalesces, hardcoded `failedExecutions: 0`, and a fee model whose default charges nothing all produce plausible numbers where the honest answer is "not measured" — the exact §32 question *"Can stale or missing market/risk data appear as a valid zero?"*

---

## CRITICAL

### C-1 — Terraform cloud-init emits a shell syntax error; no service starts on any host that runs a listener-less service · DEFECT
`deploy/terraform/modules/solmate-host/cloud-init.yaml.tftpl:43-50`. **Reproduced in-session.**

The `solmate-listen` generator wraps each service's `echo` lines in a `{ … }` group. The worker declares `listen = {}` (`profile-3/main.tf:39`, `profile-4/main.tf:44-49`), so the template renders an empty group:

```sh
      {
      } > /etc/solmate/worker.listen.env
```

`sh -n` and `bash -n` both reject it (`syntax error near unexpected token '}'`, exit 2). The script is `set -eu` and the unit is `Type=oneshot`, and a parse error kills the whole file — so the risk-authorizer and executor listener env files are never written either. Every `solmate-<service>.service` declares `Requires=solmate-listen.service` (`:71`).

Result: `terraform apply` on Profile 3 yields a Droplet on which **none** of the three financial services ever starts; on Profile 4 the worker host is dead the same way. First surfaces during a promotion window.

### C-2 — Profile 4 firewalls deny the worker's egress to the risk-authorizer and executor · DEFECT
`deploy/terraform/profile-4/main.tf:88-95`, applied at `:107-114`. **By code reading; DigitalOcean's declared-outbound-is-default-deny semantics assumed, not exercised.**

`local.egress` permits outbound 443/tcp, 53/tcp+udp, 123/udp only. The matching *inbound* rules for 8781 and 8791 exist (`:127-131`, `:153-157`), and `worker_env_hints` points the worker at `http://<private>:8781` / `:8791` (`outputs.tf:17-18`) — but the worker's own firewall never permits those outbound connections.

Result: every risk authorization and every execute call times out. D52 fails entries closed on a risk-authorizer read failure, so this presents as a total trading outage on the first live-hardened profile. Profile 3 is unaffected only because the calls are host-local — which is C-3 below.

---

## HIGH

### H-1 — The replay dataset cutoff can never bind, so the backfill defence is inert · DEFECT
`apps/worker/src/roles/replay.ts:136`, `libs/replay/src/point-in-time/guard.ts:61-71`. **Verified, including empirically against the hosted evidence run.**

`guardedRows`/`guardedCandles` compare `observedAt` against `datasetCutoff`, never against `until` (the simulated moment). The role sets `datasetCutoff: now` (request time), and the request cycle already refuses `window.to > now` — so the cutoff is always ≥ every tick and the clause can never reject a row the source-time clause already accepted. `guard.ts:59` documents the opposite.

Measured against the exact window the M10 evidence run replayed (2026-09-08):

```
1m candles:                          40,292
observed >5 min after their bucket:  39,453  (98%)
observed >1 hour after their bucket: 30,996  (77%)
worst observation lag:               301 minutes
```

**Severity calibration.** The reviewer called this CRITICAL; that conflates two leaks. *Market* look-ahead is **not** occurring — `candleVisibleAt` still enforces bucket-close plus availability lag, so no future price reaches a strategy, and §18.3's stated rule holds. What breaks is *system-state fidelity*: the replay hands strategies candles the live worker did not possess for up to five hours, so warm-up timing, candidate detection and eligibility diverge from what live actually looked like. With 98% of candles late-observed, the "Level B captured-market" run cited in `docs/probes/m10-evidence-2026-09-09.md` is, for candle-derived features, indistinguishable from Level A. HIGH, and the evidence document's fidelity label needs correcting.

### H-2 — Trade History infers PAPER vs LIVE from an account-name prefix while an authoritative column sits unread · DEFECT
`apps/web/src/lib/history.ts:130,177`. **Verified.**

`trading.accounts.mode` is an immutable enum added in `20260908001900_account_mode.sql` and used by every other loader (`paper.ts`, `ops.ts`, `settings.ts`, `arming.ts`). `history.ts` selects only `id, name` and decides `name.startsWith('paper') ? 'PAPER' : account ? 'LIVE' : 'PAPER'`.

Worse than reported: the schema column **defaults to `LIVE`**, while the UI's missing-account fallback guesses **`PAPER`**. Any failure of the `intents` or `accounts` sub-query (see H-3) therefore renders every live lot with the paper chip, in the table, in the CSV `book` column, and as the Attribution grouping key. Directly against §32 *"Can the operator mistake PAPER for LIVE_AUTO anywhere in the app?"* The e2e seed uses `paper-e2e`/`live-e2e`, so the heuristic can never fail in test.

### H-3 — Every query error in Trade History is discarded; failures render as valid zeros · DEFECT
`apps/web/src/lib/history.ts` — **the string `error` appears zero times in the file. Verified.**

Every sub-query destructures `data` only; a failure becomes `?? []`. The fills fetch (`:120`) uses `.in('id', fillIds)`, which PostgREST encodes into the request URL at ~37 characters per id: 300 lots × 2 fills ≈ 22 KB, past typical gateway limits; the Attribution page requests `limit: 2000`. On failure a **closed** lot renders proceeds `0.00`, fees `0.000`, slippage `0.000`, path `—`, beside a correct realized P&L — and the totals line reports "router + transfer fees 0.00 USDC". A failure of the top-level lots query renders "No lot matches", which reads as *you have no trades*.

### H-4 — Eight of twelve Trade History filters run after the SQL `LIMIT`, and the truncation notice can never fire · DEFECT
`apps/web/src/lib/history.ts:106-109` vs `:207-217`; notice at `history/page.tsx:63`. **Verified.**

Only `status`, `strategy`, `from`, `to` reach SQL. `book`, `result`, `exitReason`, `path`, `regime`, `family`, `verdict`, `symbol` filter in JS over the already-truncated page. The notice tests `rows.length >= f.limit` on the *post-filter* array, so once any JS filter removes a row it is unreachable.

On the PAPER/LIVE axis: with paper volume dominating, `?book=LIVE` fetches the newest 300 (all paper), post-filters to zero, and renders "No lot matches" — the operator concludes **no live trade has ever closed**. The CSV/JSON export inherits the truncation and records neither the effective limit nor whether it bound.

### H-5 — LLM cost is charged twice for any strategy with both paper and live lots in the period · DEFECT
`apps/web/src/lib/attribution.ts:112,141`. **Verified.**

`tradingBy` is keyed `strategyVersionId|book`; `modelBy` is keyed by strategy version alone; the join at `:141` looks up by strategy version. A version with lots in both books produces two rows, each charged the full model cost. `aggregateContributionUsd`, `totalCostUsd`, every unit cost and `finalOperatingResultUsd` inherit the doubling.

### H-6 — The transitive package scanner fails open · DEFECT
`tools/check-transitive.mjs:128`. **Reproduced in-session.**

`closureOf` substitutes `{}` for any unresolvable snapshot and nothing asserts the closure is non-trivially sized. Renaming one section header in the real lockfile:

```
$ sed 's/^snapshots:$/snapshotz:/' pnpm-lock.yaml > no-snap.yaml
$ node tools/check-transitive.mjs --lockfile no-snap.yaml --no-sbom
risk-authorizer packages:5 … ok:true      (real: 26)
execution-service packages:5 … ok:true    (real: 26)
worker packages:6 … ok:true               (real: 50)
web packages:17 … ok:true                 (real: 213)
exit=0
```

A 92% closure loss produces exit 0 and four `ok: true` lines. A pnpm lockfile format change (as v6 → v9 was) silently disables the whole policy. The CI negative test cannot catch this because it runs against a hand-written fixture in the old shape (M-16).

### H-7 — Root-importer production dependencies bypass every deployable closure · DEFECT
`tools/check-transitive.mjs:151`. **Verified.**

The check walks only `importers['apps/<service>']`. The root importer's production dependencies are `fast-check, next, react, react-dom, zod` — and `next`, `react`, `react-dom` are all in `BROWSER_STACK`, banned for `trust:risk-authorizer` and `trust:execution-service`. They resolve cleanly from risk-authorizer source (`createRequire(...).resolve('next')` → `node_modules/.pnpm/next@16.3.4/...`), which is the module graph esbuild uses, yet the risk-authorizer closure (26 packages) does not contain them and reports `violations: 0`.

Mitigated but not closed by the source boundary lint and the artifact scan — catching packages source never imports is this tool's unique job.

### H-8 — A position that becomes unquotable is never closed and vanishes from every metric · DEFECT
`apps/worker/src/replay/engine.ts:300` vs `:326`. **Verified line order.**

`managePositions` does `if (!quote) continue;` **before** the `WINDOW_END` branch. A token that stops trading mid-window produces no `ClosedTrade`, no `decision.outcome`, and is excluded from win rate, net P&L, tail loss, max drawdown and every attribution group — while `equityOf` keeps carrying it at its last pre-rug mark, so `finalEquity` is overstated. The single worst outcome the system exists to survive scores as neither a loss nor a trade. Live behaviour is the opposite: `position-monitor.ts:85-89` logs it and held-asset safety escalates `NO_EXIT_PATH` → `UNABLE_TO_EXIT` (CRITICAL, dead-man class).

### H-9 — systemd mount-unit names are unescaped; two of three services cannot start even after C-1 · DEFECT
`deploy/terraform/modules/solmate-host/cloud-init.yaml.tftpl:70-71`. **By code reading; systemd escaping rules assumed, not exercised.**

Units hard-code `var-lib-solmate-${s.name}.mount`, but systemd escapes a literal `-` inside a path component to `\x2d`: `/var/lib/solmate/risk-authorizer` → `var-lib-solmate-risk\x2dauthorizer.mount`. Only `worker` (no interior dash) matches. A `Requires=` on a nonexistent unit fails the job, so the documented `systemctl start solmate-<service>` (README:31) cannot work for risk-authorizer or execution-service.

### H-10 — The out-of-band emergency endpoint binds private but is published as a public URL · DEFECT
`cloud-init.yaml.tftpl:41-49` vs `profile-3/main.tf:142-144`, `profile-4/outputs.tf:23-26`. **By code reading.**

`solmate-listen` writes every `listen` entry — including `OUT_OF_BAND_LISTEN`, which `env.ts:330` confirms is a bind address — to the Droplet's **private** address, while the firewall opens the port on the public interface and the output hands the operator a **public** URL described as "traderctl target … reachable from operator_cidrs only".

During an incident, `traderctl pause` gets connection-refused. This is §32 *"Can DB/web outage prevent the out-of-band kill or emergency-close path?"* answered yes — and the only remaining route is SSH to the host, which the executor-compromise runbook treats as untrusted.

---

## MEDIUM (selected)

- **M-1 · The typed funding guard never sees instruction data** — `libs/contracts/src/policy/funding.ts` (`PreparedInstruction` = program + accounts, no `data`); `funding-wallet.tsx:156` drops it before validation. **Verified.** A compromised web bundle can keep every account address the guard checks and change only the transfer amount, or append ComputeBudget instructions (accepted wholesale, within `maxInstructions: 4`) setting an arbitrary priority fee. The wallet extension's own approval screen remains a real second control, so this is a gap in the guard's stated purpose rather than a direct fund-loss path. MISSING REQUIREMENT — the guard holds `requestedAmount` and should bind it.
- **M-2 · Nothing compares the recorded funding event to chain truth** — `roles/funding.ts:83` records `requestedAmount` verbatim; `reconciliation.ts:167-171` confirms with observed deltas but never compares the two, and `funding-repo.ts:58` has no `order by`/`limit` against a non-unique `tx_signature`. MISSING REQUIREMENT.
- **M-3 · A FAST funding claim can relabel an unexplained inflow as EXPECTED** — `reconciliation.ts:167-171` `continue`s past `classifyMovement`, and the source is checked only against the destination's own trading wallet, never the owned-address registry. A stolen aal2 operator session can suppress a reconciliation MISMATCH and keep `RECONCILIATION_CLEAN` green. DEFECT.
- **M-4 · CSV formula injection from provider-controlled token symbols** — `history.ts:260` quotes only on `"`, `,`, newline; never neutralises a leading `=`, `+`, `-`, `@`. **Verified.** A token deployer sets the symbol to `=HYPERLINK(...)`; it reaches the operator's spreadsheet through normal ingestion. DEFECT.
- **M-5 · `EXECUTE_READINESS_DRILL` is a step-up-free route to refresh three readiness rows the manual path gates behind a passkey** — `step-up.ts:55` (FAST) and `roles/readiness.ts:170-200` (admin only) vs `:220-233` (admin + evidenceRef + `stepUpVerified`). The verdict cannot be forged — the worker computes it — but it can be *obtained*, on rehearsals whose weakest form passes trivially (M-6). aal1 is closed by the DB (`ops.has_aal2()`). TRADE-OFF requiring an ADR, not a code comment.
- **M-6 · `DB_DOWN_EMERGENCY_CLOSE` passes on a zero-action plan** — `pipeline.ts:322-330` returns `ok: true` whenever `planEmergencyClose` succeeds, and an empty wallet yields a valid zero-action plan; `drills.ts:101` asserts only `r.ok`, never the `shadowSequence` its own docstring claims. The dry run also skips signing, simulation, structure validation, journal writes, idempotency and the local pause. MISSING REQUIREMENT — the row description over-claims relative to the rehearsal.
- **M-7 · The persist-before-submit audit is vacuous on ordering and blind to retries** — `internal.ts:154-171`: `signed` is populated in sequence order, so `s > e.sequence` can never be true; only the *first* SIGNED per correlation id is recorded while retries share the intent id; and `unresolvedAttempts` is computed, returned and then ignored in the verdict despite `drills.ts:113` claiming it is checked. DEFECT.
- **M-8 · The latency-matched baseline measures the candle grid, not latency** — decisions land on minute boundaries and candles become visible at `bucketTime + 60s + 5s`, so a 30 s-slower variant systematically executes off a one-minute-fresher price; `edge_lost_to_latency` can come out negative ("latency made us money"), and is exactly 0 for any `latencyMatchedMs < 5000`. DEFECT.
- **M-9 · `chase_rejected` and `stale_quote_rejected` are structurally always zero** — decision and execution quotes resolve to the same 1m bucket (`submissionDelayMs` 1,500 ms), so `CHASE_EXCEEDED` and `QUOTE_STALE` are unreachable at Level A. Published as counts in `research.replay_latency_cost`. DEFECT.
- **M-10 · The replay universe is truncated alphabetically at 200 and chosen by present-day candle coverage** — `replay-repo.ts:172-180` (`order by a.symbol limit 200`); survivor bias, and the truncation is not recorded on the run (`asset_ids` is null for an unrestricted run). DEFECT.
- **M-11 · The decisions digest excludes `candidateId`, which is the key `incrementalValue` pairs on** — reviewer produced two decision sets with identical digests but different `rejected_winners` / `admitted_not_baseline` / incremental-expectancy denominators. Compounding: `checkReproduced` has no caller outside specs and `resultsDigest` is written but never compared. DEFECT + MISSING REQUIREMENT.
- **M-12 · Risk rejections are credited to the AI as filtering skill** — `attribution.ts:33` treats any `rejection !== null` as "did not trade", so a `RISK:SLEEVE_CAPACITY_EXCEEDED` refusal on a candidate the model *wanted* becomes `AI_FILTERED_LOSER`, inflating the Q1 headline. DEFECT.
- **M-13 · `WINDOW_END` liquidates free of charge** — `engine.ts:326-330` bypasses the adapter: no 15 bps adverse allowance, no fees, no failure draw, no repricing. Systematic upward bias on every position open at window end, and `WINDOW_END` appears as a legitimate exit-reason row feeding Q13/Q14. DEFECT.
- **M-14 · Modelled fees never reach any reported number** — `ClosedTrade.fees` carries router + transfer only, both `0` under `DEFAULT_PAPER_FILL_POLICY`, so `netPnl ≡ grossPnl` while the Replay Lab renders a "fees" column reading `0.00`. Lamport fees accrue to `book.feesLamports`, which never leaves the book. DEFECT.
- **M-15 · `failed_execution_rate` is a hardcoded 0 on every in-sample/hold-out row** — `roles/replay.ts:238,248` pass `failedExecutions: 0`, and `coreMetrics` returns `0/trades = 0`, not null, rendered as "0%". `WINDOW_END` strandings are also counted as execution failures, asymmetrically across variants. DEFECT.
- **M-16 · The CI negative test cannot catch H-6** — it plants into a synthetic fixture, unlike the artifact-scan step which plants into the real built artifact; nothing asserts anything about the real run's output, and only the `worker` policy is exercised. MISSING REQUIREMENT.
- **M-17 · `image_tag` bumps are a no-op** — the tag is consumed only inside `user_data`, which carries `ignore_changes`. An operator promoting a security fix sees "No changes" and believes it is live; even a restart re-pulls the old tag. MISSING REQUIREMENT.
- **M-18 · Profile 4 grants the risk-authorizer arbitrary outbound 443/53 to the internet, and hosts pull mutable tags with `imageDigest: null` in the readiness binding** — a post-build compromise of the isolated policy process faces no network control, and a GHCR push can swap a reviewed tag without invalidating any readiness evidence. MISSING REQUIREMENT.
- **M-19 · Attribution period mismatch, month-window overflow, exit-price-valued entry fees, position-scoped exit reasons, unknown-SOL-price `?? 0`** — five arithmetic/labelling defects in `attribution.ts` / `history.ts`; the month overflow is **reproduced**: a 90-day window ending 2026-08-29 collects `2026-05, 2026-07, 2026-08` and silently drops June's metered provider spend.
- **M-20 · §33 item 20 is marked Done with no signer adapter in the repo** — `docs/probes/m11-status-2026-09-09.md:41` claims "Live capability can remain disabled without any missing implementation work"; `SoftwareDevSigner` is the only `TradingWalletSigner` and no Turnkey code exists anywhere. **Verified.** Contradicts rows 8, 15 and 28 of the same table. DEFECT in the evidence record.

---

## LOW

- **L-1** `--network host` on every container erases the netns boundary the Terraform README calls a "VPC/firewall boundary"; on Profile 3 all three trust levels share one network namespace, leaving `INTERNAL_API_SECRET` as the only barrier between a worker that ingests untrusted text and the executor's emergency plane. Undeclared TRADE-OFF, contradicted by `profile-4/main.tf:158`.
- **L-2** Four of five `record-readiness-evidence.mjs` invocations in the runbooks omit the required `--env` and exit 2 — the final audit step of each incident runbook.
- **L-3** The alert drill has no `try/finally` around its resolve and `DRILL_CRITICAL_ALERT_DELIVERY` is not in the notifications role's `OWNED` set, so an abort mid-drill strands a permanent open CRITICAL that only a later successful drill can clear.
- **L-4** `research.replay_attribution` and `replay_economic_pnl` aggregate FULL-only rows without a `variant` column, so they silently disagree with the leaderboard.
- **L-5** `prevent_destroy = false` sits directly under a comment claiming host replacement must be deliberate.
- **L-6** `.gitignore` duplicates two terraform patterns, `!*.tfvars.example` is inert, and auto-loaded `*.tfvars.json` is not ignored.

---

## Cleared — attacks that produced no finding

Recorded because negative results are evidence too:

- **Skill tool handlers do not bypass the look-ahead guard.** `createToolHandlers` has no production caller; the agents role consumes the guarded object directly, `createRepoContextSources` returns an object literal so `Object.keys` wrapping covers every method, and a wrong `CONTEXT_SOURCE_AS_OF` index fails closed.
- **The baseline gets the same candidate opportunity set.** One candidate object per asset per tick is handed to every stream, each with its own book at identical starting capital; asserted in `engine.spec.ts`.
- **A wallet-reported funding success does not change authoritative state.** No capital, ceiling or reserve computation reads `ops.wallet_funding_events`; the DB constraint forbids CONFIRMED without deltas.
- **RLS on the new replay tables and all eight views is correct.** Force-RLS, viewer policy, `select`-only to `authenticated`, `security_invoker` on every view, `anon` still revoked from the `research` schema.
- **The new executor drill routes are safe.** Both sit behind `verifyServiceRequest` with skew and nonce checks; the dry run appends nothing to the journal, claims no idempotency key, applies no pause, touches no database and never reaches the signer.
- **No secret material in logs, in the new tooling, or in any of the 11 commits.** Only `.example` files tracked under `deploy/profile-0/`.
- **Trust tags and module boundaries are clean.** Lint passes; `check-transitive` reports 0 violations on the real lockfile; `wallet-ui` is imported only by `apps/web`.
- **`failureDraw`'s per-key seeding is statistically unbiased** — 10k keys × 20 seeds, empirical 0.0199 against a configured 0.02, indistinguishable from a single mulberry32 sequence.
- **Running the alert drill on a LIVE profile cannot pause trading** — the drill class is not a dead-man class and escalation needs 10 minutes.
- **No SQL injection in the export**; filters go through PostgREST operators, `limit` is clamped, the filename is server-generated.
- **The plan-edit boundary (GUARDRAILS Part 1 rule 8) was respected** — the diff ticks M9/M10 with evidence links and appends a status annotation to M11; no scope, dependency or exit gate changed.
- **Book accounting for REDUCE→EXIT is correct** in the exact-division case: no double-count, settlement balance and sleeve capacity both return correct.
- **The invariant map is honest** — 25/28 mapped; the three unmapped are genuinely `LIVE_SIGNING` invariants whose owning modules do not exist; all six INV-13 test files exist.

---

## Recommended order of work

1. **C-1, C-2, H-9, H-10** before any Terraform is applied. None is live today; all four brick or blind a promotion.
2. **H-6, H-7** — the guardrail that is supposed to catch banned packages currently fails open and skips the root importer.
3. **H-2, H-3, H-4, H-5, M-4, M-19** — one file each, mostly small, and they are what an operator reads to decide about money.
4. **H-1, H-8, M-8..M-15** — replay fidelity. These change published research numbers, so they want a single considered pass plus a correction to `docs/probes/m10-evidence-2026-09-09.md`.
5. **M-5** — write the ADR the step-up asymmetry needs, or make `EXECUTE_READINESS_DRILL` require step-up.
6. **M-20** — correct the §33 row.
