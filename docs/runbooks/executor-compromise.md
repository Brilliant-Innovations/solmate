# Runbook — executor compromise

Blueprint D53, D54 (revoke first, sweep only to the pre-registered cold wallet), §15.7, §26.2 executor guardrails, "A suspected executor compromise triggers an incident state, immediate `PAUSE_NEW_ENTRIES`, and out-of-band revocation of the executor workload identity"; §32 security questions on a compromised executor host; plan M11. Applies when the execution-service host, image, credential set or internal API is suspected compromised, or when the signer policy digest no longer matches what the executor should be asking for.

## What a compromised executor can and cannot do

- It can request signatures through the constrained signer identity until that identity is revoked or the signer-side policy refuses the request. The production key is non-exportable; the executor never held it (§31).
- It cannot get arbitrary bytes, programs or recipients signed while the signer-side policy stands: the policy pins programs, the wallet's own token accounts and a settlement-only shape; `SWEEP_TO_COLD_RECOVERY` is the only external-recipient class and its recipient is pinned at the signer control plane, not supplied by a caller.
- It cannot promote or arm a Release, widen risk policy or approve anything: those are worker, authorizer and step-up paths with their own keys.
- It can lie in its API responses and its journal. Nothing below trusts either.

## Ordered steps (D54: revoke, then recover, then sweep, then rebuild)

1. **Declare the incident.** Who noticed what, when, on which host; which credential classes the host held (`INTERNAL_API_SECRET`, Supabase, RPC keys, the signer workload credential). Open a written timeline; every later step appends to it.
2. **Pause from outside.** `node tools/traderctl.mjs <operator-env> pause --reason "executor incident <date>"`. The out-of-band endpoint verifies the operator's emergency key; if a compromised executor ignores it, that is itself evidence. Do not rely on the pause; it is containment on the application plane only.
3. **Revoke first.** At the signer provider's control plane, disable the executor workload identity's signing permission. Record the policy version and identity changed and the time. A Solana public key cannot be rotated in place; cutting off the requester is the containment (D54). Do not wait for the enumeration to do this.
4. **Chain first.** `node tools/recoveryctl.mjs <recovery-env> enumerate`: balances, token accounts, recent signatures; provider vault balances from the provider console. Compare against the last audit checkpoint and the last clean reconciliation. Every signature since then is suspect until explained.
5. **Break-glass window, time-boxed and declared.** Activate the break-glass principal under the provider's MFA/quorum for a declared window. It may sign only: risk-reducing held-asset → SOL/USDC swaps; provider vault cancel/withdraw/recovery; `SWEEP_TO_COLD_RECOVERY`. Every signature is separately logged and alerted; each is appended to the timeline with its signature.
6. **Close or recover exposure**, then **sweep** wallet-owned SOL and SPL balances to the pre-registered cold-recovery wallet and its canonical token accounts if the wallet itself may be under an attacker's influence (a compromised executor could have staged transactions the signer would still accept before revocation). The recipient comes from the signer control plane; compare its fingerprint with the offline record before signing.
7. **Freeze the evidence.** Preserve the executor host image, the durable journal (`SHADOW_JOURNAL_PATH`) and audit checkpoints (`AUDIT_CHECKPOINT_PATH`) read-only; do not "repair" them. The journal-import role will later hold `DB_OUTAGE_EMERGENCY_REVIEW` for whatever it finds; the incident review decides which lines are trustworthy.
8. **Rotate everything the host could see.** `INTERNAL_API_SECRET`, Supabase service-role key and database password, RPC and provider keys, the projection signing key if the worker shared the host (it must not at Profile 3+), the emergency operator key pair if its public key was on the host. The signer workload identity is re-created, not re-enabled, with the same non-exportable wallet key and the same pinned policy.
9. **Rebuild from clean artifacts.** New image from a reviewed commit (`deploy/Dockerfile` runs the artifact scan), contract-set digest verified at startup (`node tools/startup-digest.mjs`), transitive policy green (`node tools/check-transitive.mjs`), egress test green. Profile 4: replace the executor host and its attached volume; restore the frozen journal copy for import, not for execution.
10. **Reconcile and review before any resume.** Reconciliation compares chain against the ledger; every movement from step 4 must be explained (attacker action, break-glass action, sweep). Live Readiness re-runs: `PROBE_A_SIGNER_POLICY`, `SIGNER_DENY_EXPORT_PINNED`, `CREDENTIAL_ISOLATION`, `ARTIFACT_EGRESS_DIGEST`, `OUT_OF_BAND_CONTROLS`, `BREAK_GLASS_SWEEP_DRILL`. New entries stay paused until an admin resumes with step-up after the incident review; a resume is a deliberate ceremony, never a side effect of the rebuild.
11. **Record.** `node tools/record-readiness-evidence.mjs --env <worker env> --row BREAK_GLASS_SWEEP_DRILL --kind DRILL --verdict PASS|FAIL --evidence <timeline>`; the incident review goes to `docs/reviews/` and, if any protection was weakened or bypassed, to an ADR classified DEFECT.

## What must not happen

- Recovering through the executor's own API (it is the compromised component; D53 puts the break-glass identity outside it for this reason).
- Typing a recovery address into any tool, env file, database row or browser.
- Re-enabling the old workload identity "to close positions quickly": the incident identity exists for that.
- Skipping the rotation in step 8 because the sweep succeeded: an attacker with the old `INTERNAL_API_SECRET` can still talk to a rebuilt executor.
