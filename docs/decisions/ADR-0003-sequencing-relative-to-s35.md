# ADR-0003 — Build sequence differs from §35; scope does not

**Status:** Accepted
**Date:** 2026-09-05
**Class (§31 taxonomy):** TRADE-OFF / DECISION
**Blueprint text affected:** §35 "First Build Sequence", which orders the isolated risk-authorizer/executor skeletons and the Turnkey/Trigger probes (steps 7–9) before Birdeye ingestion (step 10), and states "This order intentionally proves the dangerous and stateful parts early."
**§31-protected decision affected:** none. §35 closes with "staging is a build sequence, not a scope reduction"; this ADR preserves that.

## Context

The first thing worth learning is whether the platform can consume market data, find candidates, paper-execute against real quotes and manage positions. That evidence does not require the signer or executor, because the paper adapter never signs. Building the financial boundary first delays the first functional checkpoint without reducing risk, since no capital exists before M8a.

## Decision

Execution Plan v4 orders work as follows, with Track B holding working priority after M2:

- Track B: M4 market data and eligibility → M5a first paper trade → M5b breadth → M6 agents.
- Track A: MP provider probes → M3 financial boundary, filling gaps whenever Track B is blocked. MP closes before M3's contracts harden; M3 closes before M7.
- M7 (signed authorization, sleeves, full lifecycle) joins M3 and M5a and runs on `S0_SAFE`; M6 feeds it but does not gate it.
- M8 is split into M8a (tiny-live prerequisites, opening Profile 2) and M8b (`LIVE_AUTO` prerequisites).
- Research screens (M9 step 8) follow replay (M10).

Guard against divergence between paper and live execution:

- The `ExecutionAdapter` contract with `paper` and `live` implementations is fixed in `/libs/contracts` in M1.
- One shared Jupiter quote/order client lives in `/libs/execution` and is the only quote path. Both adapters consume it. A second quote path is a boundary violation.

## Consequences

- The first functional slice (M0–M5a) exists before any signer or executor code lands.
- P7 acceptance "same strategy code in paper and live with only the execution adapter differing" is protected by construction rather than by later refactoring.
- The blueprint's intent to prove dangerous parts early is honored by MP (probes) starting immediately after M2 and by M3 preceding any path to capital.

## Operator sign-off

Sean Rogers, 2026-09-05. Surfaced by the ChatGPT and Fable reviews of plan v1 and the implementation-agent review of plan v2.
