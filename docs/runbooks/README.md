# Runbooks

Operator procedures for the incidents the blueprint requires to be rehearsed (D36, D35, D33, D53/D54; §21.2; §35 step 21; P10). Each runbook names the tool or surface for every step, what evidence to record in Live Readiness (§29, ADR-0010) and what must be true before new entries may re-open. None of them is routine operation; all of them start with pausing new entries and end with a readiness re-run.

| Runbook | Trigger | Planes used |
| --- | --- | --- |
| [Complete infrastructure loss — chain-first recovery](infrastructure-loss-chain-first-recovery.md) | hosts, database or deployment lost or untrusted | chain read, break-glass if exposure demands it, redeploy, reconcile |
| [Wallet reserve and manual funding](wallet-reserve-and-manual-funding.md) | `RESERVE_BELOW_THRESHOLD`, `WALLET_RESERVES` readiness row, capital ceiling re-attestation | web Wallet / Custody funding connector, reconciliation |
| [Signer outage](signer-outage.md) | `SIGNER_UNAVAILABLE_WITH_EXPOSURE`, signer health `DEGRADED` / `DOWN` | application pause, provider protection check, break-glass only if warranted |
| [Executor compromise](executor-compromise.md) | suspected compromise of the execution-service host, image or credential | revoke first (signer control plane), chain-first, break-glass, sweep, rebuild |
| [recoveryctl (break-glass skeleton)](recoveryctl.md) | referenced by the three incident runbooks | D25 plane 2 |

Two control planes, two credentials (D25): `tools/traderctl.mjs` speaks to the executor's out-of-band endpoint with the operator's emergency key and can only pause or reduce risk; `tools/recoveryctl.mjs` and the signer provider's control plane are reached with break-glass material that no application deployable holds. A compromise or outage of the first plane never removes the second.

Drill evidence: every rehearsal is recorded with `node tools/record-readiness-evidence.mjs --env <worker env> --row <ROW> --kind DRILL --verdict PASS|FAIL --evidence <link>`; the rows these runbooks feed are `BREAK_GLASS_SWEEP_DRILL`, `SIGNER_OUTAGE_DRILL`, `DB_DOWN_EMERGENCY_CLOSE`, `WALLET_RESERVES`, `CAPITAL_ATTESTATION`, `OFFLINE_CARRY` and `OUT_OF_BAND_CONTROLS` (`libs/contracts/src/policy/readiness.ts`). A PASS needs an admin with a verified step-up; a FAIL needs only an operator. Three drills run themselves from Live Readiness `Run drill` (admin): CRITICAL_ALERT_DELIVERY, DB_DOWN_EMERGENCY_CLOSE and PERSIST_BEFORE_SUBMIT_DRILL record their verdict with a transcript; the signer-outage and break-glass drills in these runbooks are always operator-run.
