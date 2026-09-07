# ADR-0009 — Financial-boundary properties with owners and executable evidence

**Status:** Accepted
**Date:** 2026-09-08
**Class (§31 taxonomy):** MISSING REQUIREMENT (architectural promises in D9, D21, D45, §13.7, §15 without an implementation owner)
**Blueprint text affected:** none changed; §15.3–15.6, §13.7, D45, D9, §6.22 gain named owners.
**§31-protected decision affected:** none.
**Source:** operator review item 4 and self-review 1A/1B, 4.

## Context

Idempotency keys dedupe retries of one intent; a signed `RiskStateProjection` is a read of the past. Neither prevents two different authorizations from consuming the same remaining capacity, and nothing in the contracts proved that a database-only attacker cannot invent an adversary clearance. The review proposed particular architectures (reservations, clearance certificates, control epochs); the self-review correctly narrowed that to properties with evidence. This ADR names the properties, their owners and the minimum implementation that satisfies each for the Profile 2 capability set (ADR-0007). Architecture beyond that is adopted only on demonstrated need.

## Decision — properties, owners, evidence

| # | Property | Minimum implementation for Profile 2 | Owner | Evidence |
| --- | --- | --- | --- | --- |
| P1 | Concurrent valid intents cannot collectively exceed any cap. | One exposure-increasing authorization in flight; pending exposure (authorized, submitted, provisional, reorg-pending) counted as spent in the projection and in the executor's local ledger; the risk-authorizer refuses a second while the first is unreconciled. Sleeve/cohort reservations (`CapacityReservation`: reserved before signing, consumed on submit, released only on `NOT_LANDED` proof or `FINALIZED` reconciliation, never on envelope expiry) become required when concurrency is enabled. | Contract in M5a (paper path exercises the accounting); enforcement M7. | Property test: N concurrent intents never exceed the cap; a pending intent's expiry does not release capacity while it can still land. |
| P2 | Database-only tampering cannot fabricate proposer/adversary clearance. | The worker records the `CLEARED` transition as an audit event carrying proposal hash, cutoff version, verdict, Release digest and the affected lot; the state projector includes that event's sequence and hash in the signed projection; the risk-authorizer verifies the projection signature and the audit chain against the external checkpoint before authorizing. A standalone signed clearance envelope is adopted only if chain verification cannot be performed at authorization time. | Contracts before M6 (audit summary shape, projection fields); enforcement M6 (writer) and M7 (authorizer). | Tamper test: a mutated `action_cycles` row or audit row is refused; a cleared cycle re-pointed to a different proposal hash is refused. |
| P3 | An authorization issued before a pause cannot submit after it; a stale authorization cannot bypass a later re-arm. | Sticky `PAUSED` and the arming record are read by the authorizer at authorization and by the executor immediately before submit; envelope expiry bounds the window; transactions already broadcast may land and are reconciled, never assumed prevented. | M3 (executor pre-submit check, local pause); M7 (authorizer). | Drill: pause between authorization and submit → no submission; pause after broadcast → landed transaction reconciled and reported. |
| P4 | Durable execution identity survives restart, rollback and split-brain. | Executor durable nonce/sequence journal, persist-before-submit (`SIGNED_NOT_SUBMITTED`), single-writer fencing token. | M3. | Tests: restart after journal write, after submit before response, two executors with one fencing token. |
| P5 | Protection that is installing or failed counts as unprotected exposure. | Protection lifecycle `INSTALLING → ACTIVE | FAILED → CANCELLING`; only `ACTIVE` protects; unmanaged-exposure computation and `WIND_DOWN` treat the rest as unprotected. | Contracts now; M8a. | Test: a lot with `INSTALLING` protection blocks `OFF` and raises unmanaged exposure. |
| P6 | Canonical financial arithmetic. | Base-unit `bigint` everywhere, one rounding rule per operation, fee attribution and cash-flow identities as property tests; paper and live share the module. | M5a (paper accounting); M7 (live). | Property tests: conservation across fills, fees and lot allocation. |
| P7 | Execution-time transaction bounds. | For each permitted shape (ADR-0008): input mint/amount, output mint/minimum, recipient set and program set asserted against the simulated deltas at landing time, not only at build time. | MP (shape catalogue); M3 (validator). | Harness cases per shape: substituted recipient, extra transfer, foreign program, inflated input. |

Arming/control epochs are not required; P3 is satisfied without them.

## Consequences

- Plan §4 M3, M5a, M6, M7 and M8a carry these owners; §8 evidence links point at the tests.
- `CapacityReservation` and a clearance envelope stay out of the contracts until P1 concurrency or P2 verification demands them.

## Operator sign-off

Sean Rogers, 2026-09-08.
