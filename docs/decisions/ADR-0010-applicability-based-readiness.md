# ADR-0010 — Applicability-based readiness, invariant wording fixes, bypass tests and deployment-bound evidence

**Status:** Accepted
**Date:** 2026-09-08
**Class (§31 taxonomy):** MISSING REQUIREMENT (§29 readiness needs a computable coverage rule) plus DEFECT (over-broad invariant wording inherited from §24.6)
**Blueprint text affected:** §24.6 (invariant list), §29 (readiness verdicts), §33 (definition of done). Plan v4 ground rule 2, M8a and M11 gates.
**§31-protected decision affected:** none.
**Source:** operator review items 6 and 8, self-review 1C and 3.

## Context

"≥ 12 invariants mapped" and "zero unmapped at M11" are progress counters. A readiness verdict for Profile 2 needs to know which invariants the enabled capability set exercises, and that each of those has an executable test with current passing evidence. "Fail when the owning module exists" was ambiguous once M1 created every module skeleton. Several invariant statements are broader than the behaviour they protect. Harness drills prove the code, not the deployment.

## Decision

1. **Invariant map schema.** Every entry carries `required_by` (milestone), `applicable_profiles` (`P0`…`P4`, or `ALL`), `applicable_strategy_classes` (`DETERMINISTIC`, `LLM`, or `ALL`), `applicable_capabilities` (from a fixed vocabulary: `LIVE_SIGNING`, `LIVE_AUTO`, `LLM_STRATEGY`, `MULTI_STRATEGY`, `PROVIDER_PROTECTION`, `OFFLINE_CARRY`, `EMERGENCY_DIRECT_POOL`, `PAPER`, `ALWAYS`), `tests`, `evidence` (links), and `not_applicable_reason` where a profile computation excludes it. `status` stays `unmapped | mapped`.
2. **Gate rule.** A readiness verdict for a profile and Release is computable only when every invariant whose applicability matches the enabled capability set is `mapped` and its tests are green in the evidence run; invariants for disabled capabilities are reported `NOT_APPLICABLE` with the reason. This replaces the milestone counts in plan §8 M8a/M11. It is explicitly not "M11 before M8a".
3. **Wording fixes** (statements only; the protected behaviour is unchanged): INV-05 "No new exposure while PAUSED or in OBSERVE/PAPER; mandatory exits are never blocked by pause or mode"; INV-01 gains "except the emergency-command authority under INV-12's constraints"; INV-12 gains "transactions broadcast before a pause may still land and are reconciled, not prevented".
4. **Bypass tests.** A CI job applies a small, named set of source bypasses in turn (drop the nonce check in approval binding; drop the hard-reject check in the entry gate; drop the paused check in `newEntriesAllowed`; make the mandatory-exit classifier honour the adversary) and asserts that the mapped tests fail. It is a hand-written list, not a mutation-testing platform.
5. **Deployment-bound evidence.** M8a persists a `ReadinessRow` per check binding commit and image digest, contract digest, policy digests, wallet, cluster, deployment profile, strategy Release, timestamp and expiry; a change to any bound digest, wallet or policy invalidates the row. Drills for M8a run in the target environment (process termination after journal write; after submit before response persistence; runtime restart with an ambiguous transaction; DB outage with an open monitored position; signer outage; stale/divergent RPC; loss of presence; pending transactions during pause; local sleep/shutdown when the runtime is local), not only in the harness.
6. **Severity wording.** "No open severity-1 defect" becomes "no unresolved critical/high security or financial-invariant finding" in every gate.

## Consequences

- `tools/check-invariant-map.mjs` validates the new fields now and gains a `--profile` computation in M8a.
- The three wording fixes land in `invariant-test-map.yaml` with this ADR; existing tests already prove the narrower statements.
- Plan §4 M8a and M11 and §8 are edited accordingly.

## Operator sign-off

Sean Rogers, 2026-09-08.
