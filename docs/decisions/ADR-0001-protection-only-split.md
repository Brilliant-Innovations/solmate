# ADR-0001 — `PROTECTION_ONLY` is a position review state, not an action-cycle terminal state

**Status:** Accepted
**Date:** 2026-09-05
**Class (§31 taxonomy):** TRADE-OFF / DECISION
**Blueprint text affected:** §6.10D, which lists the action cycle's "final cleared/rejected/expired/`PROTECTION_ONLY` state" and says "The action cycle is canonical for the final action state."
**§31-protected decision affected:** none. "Unresolved open-position adversarial review enters `PROTECTION_ONLY`" (§31) is preserved exactly.

## Context

§6.10D models `PROTECTION_ONLY` as a terminal state of `agents.action_cycles`. §11.11A describes it as "a deterministic runtime state, not an AI action", entered by a position when a reassessment cannot be cleared. §20.9 shows it as a position review state (`REVIEWED` / `PROTECTION_ONLY` / `BUDGET_PAUSED`). Putting position behavior inside the action-cycle machine mixes two domains: what a review concluded, and what the position does about it.

## Decision

- `agents.action_cycles` terminal states are `CLEARED`, `REJECTED`, `EXPIRED`, `UNRESOLVED`. An `UNRESOLVED` cycle carries `unresolved_reason` from the enum `DISAGREEMENT`, `ADVERSARY_UNAVAILABLE`, `TIMEOUT`, `BUDGET`, `MALFORMED_OUTPUT`, `REVISION_EXHAUSTED`, matching the six causes in D39.
- The action cycle remains canonical for the final **action** disposition and keeps the unresolved-reason field §6.10D requires.
- `trading.positions` carries a position review state: `REVIEWED`, `PROTECTION_ONLY`, `BUDGET_PAUSED`. An open position enters `PROTECTION_ONLY` when its latest reassessment cycle terminates `UNRESOLVED`, per D39. It leaves it only through a newly `CLEARED` cycle at a current shared cutoff.
- The two state machines are separate pure modules with separate property tests (M1). Adversarial review #0 checks explicitly that no position behavior lives in the action cycle.
- UI surfaces that the blueprint describes as showing `PROTECTION_ONLY` on a cycle row (§20.6) display it by joining the cycle to its position's review state.

## Consequences

- Cleaner domain boundaries; the Inspector can show "review was unresolved because X" and "position is therefore protection-only since T" as two facts.
- Every D39 behavior is unchanged: deterministic stops stay active, no discretionary action executes, retries back off, repeated failures raise `HIGH`, `unreviewed_stop` may only tighten.
- Invariant INV-21 ("an unresolved open-position discretionary cycle cannot persist a cleared `HOLD`; it enters `PROTECTION_ONLY`") is tested across both machines together.

## Operator sign-off

Sean Rogers, 2026-09-05. Surfaced by the ChatGPT review of plan v1 and the implementation-agent review of plan v2.
