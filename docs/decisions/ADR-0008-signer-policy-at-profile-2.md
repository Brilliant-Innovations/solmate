# ADR-0008 — Signer-side policy at Profile 2 (`LIVE_APPROVAL`)

**Status:** Accepted
**Date:** 2026-09-08
**Class (§31 taxonomy):** TRADE-OFF / DECISION resolving a blueprint inconsistency; supersedes the "preferred, not required" Probe A row of ADR-0004
**Blueprint text affected:** D55 (second signer-side policy layer, worded for `LIVE_AUTO`), D65 and §29 (no profile waives signer policy to reduce cost), §15.7A, §31 ("production live signer key remains non-exportable and is never regressed to a raw executor secret").
**§31-protected decision affected:** none weakened; this ADR strengthens ADR-0004.
**Source:** operator review item 2 and self-review 2B.

## Context

D55 scopes the external signer-policy layer to `LIVE_AUTO`. D65 and §29 say signer policy is preserved across profiles. Two readings exist: "the policy required for the selected mode" and "the full D55 layer for every live mode". ADR-0004 chose the first and marked Probe A "preferred, not required" for `LIVE_APPROVAL`, stating that no protected decision changed. That understated the residual risk: human approval binds an envelope hash (INV-10), and the executor's semantic simulation (M3) checks balance deltas, but neither constrains the bytes a compromised executor host signs after approval. Only the signer-side policy does.

## Decision

1. **External signer-policy validation is mandatory for the transaction shapes Profile 2 permits** (ADR-0007's enumerated set). The pinned policy must accept those shapes and deny: any instruction targeting a program outside the allowlist, any transfer to a recipient outside the trading wallet's own accounts and the registered custody set, any `ADDRESS_TABLE_LOOKUP` placeholder that would hide a policy-relevant account, and any signer other than the trading wallet. Shapes the policy cannot express are not permitted at Profile 2; breadth (more route families, lookup tables) is future work behind the same rule.
2. If the selected native policy cannot constrain that subset, an isolated signer-policy gateway (D55 alternative) is required before Profile 2 opens. There is no waiver.
3. **Probe A is split into four recorded results**, each pass/fail on its own: (a) deny-export and policy-administration restrictions for both principals; (b) supported-shape acceptance; (c) malicious-shape rejection (foreign program, foreign recipient, extra signer, placeholder lookup); (d) lookup-table compatibility. `READY_FOR_ATTENDED_TINY_LIVE` requires (a), (b) and (c) green; (d) informs M8b.
4. The readiness record states the residual risk explicitly: with (a)–(c) green, a compromised executor can only request signatures for shapes the policy accepts, within the exposure the envelope authorized; it cannot exfiltrate the key or move funds to an arbitrary destination.

## Consequences

- ADR-0004's row list changes in one place: "Probe A passed for the routes in use — preferred, not required" becomes "Probe A results (a), (b), (c) green for the Profile 2 shape set — required".
- MP records four Probe A results instead of one; `docs/probes/README.md` carries the split.
- The M3 executor validator and the M8a readiness computation enforce the shape set (ADR-0009 owners).

## Operator sign-off

Sean Rogers, 2026-09-08.
