# Runbook — complete infrastructure loss, chain-first recovery

Blueprint D36, §22.5, §21.2B/C, §26.1, §35 step 21; plan M11. Applies when the hosts, the database, the deployment platform or any combination is lost, corrupted or no longer trusted. The rule that shapes every step: **the chain and the custody providers are the truth; the application is a projection that is rebuilt afterwards.** Nothing here asks the lost deployment for anything.

## What survives by design

| Item | Where it lives | Never lives in |
| --- | --- | --- |
| Trading wallet public key and settlement/token accounts | signer provider (non-exportable key at Profile 2+), operator recovery material (public data), `deploy/profile-0/.env.worker` `PAPER_TRADING_WALLET` for paper | — |
| Break-glass principal and cold-recovery wallet fingerprint | signer provider control plane, offline recovery material (D53, D54) | any deployable, any env file a service reads, any database row |
| Emergency operator key (`traderctl`) | operator machine env file | workspace, GHCR image, database |
| Code and images | GitHub `Brilliant-Innovations/solmate`, GHCR `solmate-{worker,risk-authorizer,execution-service}`, contract-set lock `libs/contracts/contract-set.lock.json` | — |
| Schema | `supabase/migrations` (hosted history applied through the latest migration; `docs/probes/` records which) | — |
| Executor durable journal and audit checkpoints | `SHADOW_JOURNAL_PATH`, `AUDIT_CHECKPOINT_PATH` on the executor / worker host volume (Profile 4: the attached, service-specific volume) | the database alone |
| Provider secrets | operator secret store (Birdeye, Helius, Jupiter, Sentry, Supabase service role, Turnkey at Profile 2+) | GitHub |

## Ordered steps

1. **Declare the incident and pause the world you can still reach.** If the executor answers: `node tools/traderctl.mjs <operator-env> pause --reason "infra loss <date>"`. If it does not, note that and continue; the pause is not a precondition for anything below. Do not start any replacement runtime yet.
2. **Enumerate chain truth.** `node tools/recoveryctl.mjs <recovery-env> enumerate` prints wallet SOL and SPL balances, token accounts and recent signatures through a closed read-only RPC method set. Add provider-vault balances from the protection provider's own console (Jupiter Trigger at Profile 2+). Write the result down with a timestamp; it is the opening balance of the recovery.
3. **Reconstruct exposure from that enumeration only.** Every non-settlement token balance is exposure; every open provider order is a protected lot; every signature after the last known checkpoint is a movement to explain later. Do not consult a database backup for this step: rows alone are not execution authority (§31).
4. **Decide whether exposure can wait for the rebuild.** If the enumeration shows exposure that policy would not carry unattended (D61 `OFFLINE_PROTECTED` conditions unmet, held-asset safety unknown, provider protection absent), the break-glass principal closes or recovers it now: follow [recoveryctl](recoveryctl.md) steps 3–7 (revoke the executor workload identity first, time-boxed incident identity, risk-reducing swaps only, `SWEEP_TO_COLD_RECOVERY` if the wallet itself is in doubt). If exposure is provider-protected and within its offline deadline, it may wait, and the external `session-resume-watchdog` deadline still binds (§21.2C).
5. **Restore the database from the schema, not from trust.** Create or restore the Supabase project; apply every migration (`pnpm exec supabase db push --db-url <url> --include-all`); regenerate nothing by hand. A restored backup is acceptable for research history, but every trading table is treated as stale until reconciliation (step 9) has run.
6. **Rebuild from clean artifacts.** Pull the images by tag from GHCR or rebuild with `deploy/Dockerfile`; the build runs `tools/check-artifacts.mjs` and refuses a banned package. Confirm the bundles report the locked contract-set digest (`node tools/startup-digest.mjs`) and that `node tools/check-transitive.mjs` is green on the checked-out lockfile.
7. **Reissue every credential the lost environment held.** New Supabase service-role key, new `INTERNAL_API_SECRET`, new projection and emergency operator keys (`node tools/dev-keys.mjs` for paper profiles; the isolated environment for Profile 2+), new provider keys if the old hosts could have leaked them. The signer workload identity is re-enabled only after step 4's revocation is reviewed and the signer policy digest (`SIGNER_DENY_EXPORT_PINNED`, `PROBE_A_SIGNER_POLICY` rows) is re-verified. Profile 4: replace hosts and attached volumes host by host; the executor's journal volume is restored before the executor starts so `RECONCILED_INTO_DB` lines are not lost.
8. **Start services with entries paused.** Runtime enters `STARTING`; `WORKER_ROLES` must include `reconciliation`, `held-asset-safety`, `chain-health`, `readiness`, `notifications` and `journal-import` before any strategy role. The session starts in `WATCH` and stays paused (`PAUSE_NEW_ENTRIES` is sticky, D61) until an operator resumes with step-up.
9. **Reconcile chain and custody into the application.** The reconciliation role compares the wallet against the ledger and pauses on any unexplained balance or movement; the journal-import role replays the executor's durable journal into the audit ledger and holds `DB_OUTAGE_EMERGENCY_REVIEW` until an operator reviews it. Explain every movement from step 3 (fill, provider deposit/withdraw, break-glass action, manual funding) before clearing. Held-asset safety and emergency-route refresh complete before entries can re-open (§21.2B).
10. **Re-run Live Readiness and record the drill.** All rows must be green for the profile before `RESUME_NEW_ENTRIES`; record `node tools/record-readiness-evidence.mjs --env <worker env> --row BREAK_GLASS_SWEEP_DRILL --kind DRILL --verdict PASS|FAIL --evidence <link>` (if step 4 signed), and the same for `--row DB_DOWN_EMERGENCY_CLOSE` and `--row OFFLINE_CARRY`, with links to the enumeration and the reconciliation report. Resume requires the passkey step-up (D41).

## When the executor's journal did not survive — `EXECUTOR_JOURNAL_RESET`

Step 7 says to restore the executor's journal volume before the executor starts. When that is not
possible — the volume is gone, or a Profile 2 workstation was rebuilt — the journal restarts its
sequences at 1 while the audit ledger's import cursor is still at whatever it reached before the
loss. `journal-import` detects that (`page.head` below the cursor), raises `EXECUTOR_JOURNAL_RESET`
as CRITICAL and **stops importing**. It deliberately does not move the cursor itself: the records
between the cursor and the new head are gone, and advancing over them would erase the gap from the
audit ledger silently rather than recording that it happened.

The alert is not self-clearing, and the role stays stopped until an operator does this:

1. **Establish what the gap contains, from anything but the lost journal.** The missing sequences
   covered executor-local records — emergency commands, pauses, shadow syncs, and the attempt lines
   of emergency intents. Chain signatures (step 2's enumeration) and the protection provider's own
   console are the surviving evidence. Anything the executor did that reached chain is recoverable
   there; anything it recorded but did not broadcast is not.
2. **Decide whether the gap is material.** A gap spanning a period with no open exposure and no
   emergency action is an availability event. A gap that overlaps a DB outage in which an emergency
   close may have fired is a custody question, and step 4's reconstruction answers it, not this step.
3. **Write it down before clearing it.** File the gap as an audit note — the old cursor, the new
   head, the wall-clock window they span, what the chain enumeration shows for that window, and the
   conclusion. This is the record that the gap was examined rather than skipped; the audit ledger's
   hash chain stays intact either way, because nothing is back-dated into it.
4. **Move the cursor deliberately.** Only after (3): reset the import cursor to the new journal's
   base so import resumes from the rebuilt journal, and resolve `EXECUTOR_JOURNAL_RESET`. There is no
   automated verb for this and that is intentional — it is the one place where an operator asserts
   that lost records were accounted for by other means.
5. **Resume entries the normal way.** The sticky pause and step-up `RESUME_NEW_ENTRIES` in step 10,
   unchanged. A cleared journal-reset alert is not on its own a reason to resume.

The same shape applies to `SHADOW_PROTECTION_UNAVAILABLE`, raised when the worker's shadow journal is
lost but the executor's is not: the executor refuses our pushes as `SHADOW_REGRESSION` and refuses our
emergency closes as `SHADOW_STALE`, so DB-down protection is unavailable in both directions and new
entries are paused. It does not self-correct. The operator reconciles by deciding which side is
authoritative — normally the executor's, since it holds the later sequence — and rebuilding the
worker's journal from the current open book rather than trying to replay the lost one.

## Checks that make this runbook honest

- The enumeration in step 2 must be reproducible by a second operator from public data plus the wallet address alone.
- No step asks the old executor, the old database or the browser for an amount, a recipient or a state that the chain contradicts.
- The cold-recovery address is never typed: it is pinned at the signer control plane and compared against the offline record.
- A rebuild that skips step 6's artifact and digest checks is not a recovery; it is a new, unreviewed deployment.
