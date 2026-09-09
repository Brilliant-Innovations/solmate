# ADR-0013 — An automated readiness drill runs without step-up; an operator-asserted verdict still needs one

**Status:** Accepted
**Date:** 2026-09-09
**Class (§31 taxonomy):** TRADE-OFF / DECISION.
**Blueprint text affected:** §29 (readiness drills), §21.2A, D41 (step-up policy), P10.
**§31-protected decisions affected:** "human risk-increasing controls require step-up while pause/close remain fast" — this ADR argues a rehearsal is neither. "live configuration is immutable Release-bound and step-up attested" — unchanged.
**Source:** adversarial review 2026-09-09, finding M-5, with M-6 and M-7 fixed in the same pass.

## Context

`EXECUTE_READINESS_DRILL` is classified FAST in `libs/contracts/src/policy/step-up.ts`, so an admin can run a drill with an aal2 session and no passkey assertion. The three rows it can produce — `CRITICAL_ALERT_DELIVERY`, `DB_DOWN_EMERGENCY_CLOSE`, `PERSIST_BEFORE_SUBMIT_DRILL` — are `DRILL`-kind rows, and recording a `DRILL` PASS through the *manual* evidence path requires admin **plus** a step-up assertion (`apps/worker/src/roles/readiness.ts`). The same readiness row is therefore reachable at two different authentication bars.

The reviewer's objection is sound as far as it goes: a readiness PASS is an input the arming path relies on, and obtaining one more cheaply moves the deployment closer to armable. It was sharpened by two other findings: at the time of the review the automated rehearsals could pass without demonstrating anything — `DB_DOWN_EMERGENCY_CLOSE` returned `ok: true` for a zero-action plan on an empty wallet (M-6), and the persist-before-submit audit's ordering test could never fire (M-7). A cheap route to a verdict that is trivially obtainable is a real weakening.

## Decision

**Keep `EXECUTE_READINESS_DRILL` FAST**, on the following grounds, and only because the two rehearsals were made real in the same change.

1. **Step-up guards an operator assertion, not a machine measurement.** On the manual path the operator *supplies* the verdict; the system has no way to check it, so the passkey is what binds a claim to a person. On the drill path the worker runs the rehearsal and computes the verdict; the request carries only a `rowId`, and a payload that names anything outside `AUTOMATED_DRILL_ROWS` is refused. There is no assertion to bind.
2. **A drill cannot produce a PASS it did not earn.** After M-6/M-7: `DB_DOWN_EMERGENCY_CLOSE` needs a synced shadow sequence and a plan that accounts for every closeable holding, and records `NOT_APPLICABLE` on an empty wallet; `PERSIST_BEFORE_SUBMIT_DRILL` needs at least one audited attempt, every SUBMITTED preceded by its own SIGNED record with retries counted, and nothing left unresolved; `CRITICAL_ALERT_DELIVERY` needs both rounds to reach the policy minimum including an out-of-app channel. Each records `FAIL` honestly when the deployment cannot meet the bar.
3. **A drill row expires; a manual row does not.** Drill rows carry `expiresAt = finishedAt + drillMaxAgeMs`, so a drill PASS is perishable evidence that has to be re-earned. A manually asserted row has `expiresAt: null`.
4. **Rehearsing must stay cheap.** A protection that is expensive to exercise is exercised rarely, which is the failure mode §29 exists to prevent. Putting a passkey in front of every drill trades a real safety property for a theoretical one.
5. **aal1 is already closed at the database** (`ops.has_aal2()`), so the floor is a TOTP-verified operator session, not a bare cookie.

## What this does not license

- The **manual** evidence path keeps its step-up for `DRILL` and `PROBE` PASS rows. Nothing here relaxes it.
- A drill may never write a row outside `AUTOMATED_DRILL_ROWS`, and the verdict may never come from the request payload.
- `SIGNER_OUTAGE_DRILL` and the break-glass drill stay manual and stay step-up gated: they run in the isolated environment against real credentials.

## Consequences

- Re-opening this is cheap: adding `EXECUTE_READINESS_DRILL` to the step-up set is a one-line policy change, and the readiness role already has `stepUpVerified` wired.
- If a future drill can change deployment state rather than only observe it, that drill does not belong on this path, and this ADR does not cover it.
- Recorded for adversarial review gate #4 to re-examine: the argument rests entirely on the drills being honest, which is a property of the code, not of the policy.
