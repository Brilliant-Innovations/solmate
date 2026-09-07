# ADR-0007 — Profile 2 restricted capability set, its safety dependencies, and shared chain-foundation ownership

**Status:** Accepted
**Date:** 2026-09-08
**Class (§31 taxonomy):** MISSING REQUIREMENT (the plan's M8a gate did not name the capability set it certifies) plus TRADE-OFF / DECISION (task-level ownership of `/libs/solana-hard-state`)
**Blueprint text affected:** §29 (profile-aware readiness), §35.7–9 (M3 content), D65 (progressive profiles). Plan v4 §4 M3, M5b, M7, M8a.
**§31-protected decision affected:** none. Every protection stays on; this ADR only narrows what Profile 2 is allowed to do and names what must exist before it does it.
**Source:** operator review of plan v4 (2026-09-07) and its self-review (2026-09-08); repository-verified assessment in `docs/reviews/review-plan-v4-external-recommendations-2026-09-07.md`.

## Context

The M8a gate certified "the `S0_SAFE` tiny-live variant" without saying which capabilities that Release enables. Readiness for a capability set that is not written down cannot be computed, and safety work in M5b that the live risk policy depends on had no consumer before M12. Separately, the plan assigned `/libs/solana-hard-state` to M3 while M4 built it; the dependency of Track B on Track A that the plan text implied never existed in practice.

## Decision

### Profile 2 capability set (the only configuration `READY_FOR_ATTENDED_TINY_LIVE` may certify)

- one trading account, one strategy Release: the `S0_SAFE` tiny-live variant (ADR-0004);
- one strategy sleeve per mint; a Release that would create a second sleeve on a mint already held is refused at arming (readiness row `SINGLE_SLEEVE_PER_MINT`);
- at most one exposure-increasing authorization in flight; a second is refused by the risk-authorizer until the first is `FINALIZED`-reconciled or proven `NOT_LANDED`;
- pending exposure (authorized, submitted, `CONFIRMED_PROVISIONAL`, `REORG_PENDING`) counts as spent against every cap;
- a durable single-writer execution gate in the executor: one signing sequence, fenced by a durable token, no parallel submission;
- `MONITORED_EXIT` protection unless the Trigger lifecycle row is green (ADR-0004 unchanged);
- an enumerated transaction-shape set: Jupiter `/order` swaps between the settlement mint and the held asset on the route families listed in the Release, and the direct-pool emergency shapes only once M8b lands; every other shape is rejected before signing;
- `LIVE_APPROVAL` only; no `LIVE_AUTO`;
- disabled capabilities stay disabled: no LLM strategy, no multi-strategy accounting, no provider protection unless proven, no offline carry.

### Safety dependencies of that Release (`S0_LIVE_SAFETY`, an explicit M8a prerequisite)

Only what the Release consumes, nothing for research breadth:

- candidate-side self-influence guard **wired into the candidate machine** (the library exists since M4; M5a wires it);
- cohort inputs for every policy field the Release enables; an unknown cohort or classification is treated as the most restrictive cap;
- speed-tier, intent-expiry and chase enforcement bound to `human_reaction_floor_ms` (ADR-0004);
- deterministic protection (stop/trail/time policies) and the held-asset safety loop running for every open position.

Regime classification, correlation clusters, session labels and further trigger families remain M5b research work and are not tiny-live prerequisites.

### Shared chain foundation ownership

`/libs/solana-hard-state` is owned by M4 as the "shared chain foundation" (read-only RPC with a closed method set, mint/token-account decoders, balance and security-state reads, slot/freshness metadata, fixtures, contract tests, and the capability-boundary test landed 2026-09-08). M3 and the risk-authorizer are consumers. No milestone is added; plan §4 M3 and §8 M4 are corrected to say so.

## Consequences

- M8a's exit gate is computed for this capability set; enabling anything outside it requires the readiness rows of the capability being enabled (multi-strategy: lot-scoped review state; `LIVE_AUTO`: D33 + D55 in full; LLM strategies: ADR-0004 scope rule).
- Lot-scoped review state (operator review item 5C) is required by the multi-strategy Release, not by the pilot; the `SINGLE_SLEEVE_PER_MINT` row is the guard until then.
- General sleeve/cohort reservations (ADR-0009) are required when concurrent exposure-increasing authorizations are enabled, not before.

## Operator sign-off

Sean Rogers, 2026-09-08 ("as long as the amendments do not weaken our app then go ahead").
