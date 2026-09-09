# Runbook — production signer outage

Blueprint D33 (signer-outage exposure bounded), §21.2 "Production signer unavailable/degraded", §32 "What happens to every open `MONITORED_EXIT` position when the production signer is unavailable?", D53; plan M8a signer health and signer-outage drill, M11. Applies from Profile 2 on, when the remote signer (Turnkey, non-exportable key) is unavailable, degraded, or its policy or workload identity can no longer be verified. Paper profiles use the software dev signer and are not subject to this runbook.

## What the platform does on its own

- Signer health is a System Health dependency and a Live Readiness row; `SIGNER_OUTAGE_DRILL` records that this runbook was exercised.
- New live entries, adds, discretionary protection changes and new on-chain exits through the normal path stop: none of them can be signed. The runtime does not pretend otherwise; the executor reports `SIGNER_UNAVAILABLE` and the risk core refuses entries on signer health.
- Every `MONITORED_EXIT` lot is signer-dependent exposure. If any is open, the notifications role raises `SIGNER_UNAVAILABLE_WITH_EXPOSURE` (CRITICAL, out-of-app delivery, escalation and dead-man pause). The D33 cap already bounded how much `MONITORED_EXIT` exposure could exist; a new entry that would have exceeded it was denied before the outage.
- Provider-side protection (`JUPITER_TRIGGER` lots) keeps working independently until it needs a signed cancel, withdraw or change; those lots remain protected through the outage.
- Jupiter-independent direct-pool routing does not cure a signer outage: it needs a signature too. It exists for a Jupiter outage, not this one.

## Operator procedure

1. **Acknowledge and pause.** Acknowledge the CRITICAL alert (`ACKNOWLEDGE_ALERT`) and pause new entries: web `PAUSE` (Shift+P) or `node tools/traderctl.mjs <operator-env> pause --reason "signer outage <date>"`. The pause is sticky (D61) and survives dashboards.
2. **Establish the shape of the outage.** Provider status page, `/health` signer row (last success, policy digest verification, workload identity check), executor logs. Distinguish: transient provider outage; policy digest mismatch (the signer's transaction policy no longer matches the pinned digest); workload identity disabled or rotated. The last two are not outages to wait out; treat a digest mismatch as a potential compromise and read [executor compromise](executor-compromise.md).
3. **Inventory exposure by protection mode.** `/positions` groups open lots by `MONITORED_EXIT` versus `JUPITER_TRIGGER`. `MONITORED_EXIT` lots cannot be exited until signing returns; their stops are still evaluated and logged, so the record shows what the runtime would have done. `JUPITER_TRIGGER` lots keep their provider protection; note any protection expiry that falls inside a plausible outage window.
4. **Decide whether to wait or to escalate.** Wait when: the provider reports a transient outage, `MONITORED_EXIT` exposure is within the D33 cap and held-asset safety is `NORMAL`. Escalate to the break-glass path when: a `MONITORED_EXIT` lot's asset turns `CRITICAL_EXIT` or `EXIT_RECOMMENDED`, the outage outlasts the strategy's maximum offline duration, or the signer's policy or identity can no longer be trusted. Escalation follows [recoveryctl](recoveryctl.md) steps 3–7: revoke the executor workload identity first, then the time-boxed incident identity may sign risk-reducing held-asset → SOL/USDC swaps and provider cancel/withdraw; it may not open anything.
5. **Do not widen anything during the outage.** No new Release, no ceiling change, no manual protection edits: every one of those needs a signature or a step-up ceremony that the incident state refuses.
6. **Recovery gate before entries re-open.** All three must be re-verified and visible on `/health` and `/readiness`: signer health green; signer policy digest equal to the pinned `SIGNER_DENY_EXPORT_PINNED` / `PROBE_A_SIGNER_POLICY` record; executor workload identity re-enabled and its permission scoped exactly as before. Then reconciliation runs (provider fills that happened during the outage are refreshed), held-asset safety and emergency routes refresh, and only then `RESUME_NEW_ENTRIES` with passkey step-up.
7. **Record.** `node tools/record-readiness-evidence.mjs --row SIGNER_OUTAGE_DRILL --kind DRILL --verdict PASS|FAIL --evidence <incident note>` with the timeline: detection, pause, exposure inventory, decision, recovery verification. A rehearsal that never had `MONITORED_EXIT` exposure open records that fact rather than a PASS on a scenario it did not exercise.

## Questions this runbook must answer during the drill

- Which `MONITORED_EXIT` lots were open, and what did their stop logic record while unsignable?
- Did every `JUPITER_TRIGGER` lot stay protected, and was any protection expiry inside the window?
- Did the dead-man deadline pass, and did `PAUSE_NEW_ENTRIES` hold regardless of dashboard availability (§21.2A)?
- Was any recovery step performed through the executor rather than the separate break-glass plane? (It must not be.)
