# ADR-0004 — Tiny-live `S0_SAFE` variant and the `READY_FOR_ATTENDED_TINY_LIVE` row set

**Status:** Accepted
**Date:** 2026-09-05
**Class (§31 taxonomy):** MISSING REQUIREMENT (the blueprint names the verdict in §29 but does not enumerate its rows) plus TRADE-OFF / DECISION (Probe A scope)
**Blueprint text affected:** §29 (profile-aware readiness, `READY_FOR_ATTENDED_TINY_LIVE`); §12.3 and §20.8 (`human_reaction_floor_ms` and `LIVE_APPROVAL` eligibility); D55 (signer-side policy scoped to `LIVE_AUTO`).
**§31-protected decision affected:** none. No transaction authorization, signer policy, deterministic risk, adversary, chain reconciliation or hard cap is waived.

## Context

Profile 2 (tiny attended live) is meant to open before the full UI, replay and hardening exist. Two things block it as the blueprint is written:

1. A `T0_FAST` deterministic baseline may declare an intent expiry shorter than `human_reaction_floor_ms`, which makes it ineligible for `LIVE_APPROVAL`. `LIVE_AUTO` at Profile 2 would require the direct-pool adapter (D33), which the plan defers to M8b.
2. §29 names `READY_FOR_ATTENDED_TINY_LIVE` but lists rows only for hardened unattended funding.

## Decision

### Tiny-live strategy variant

`S0_SAFE` gets a second, versioned strategy variant for Profile 2 whose speed tier and intent expiry sit above the configured `human_reaction_floor_ms`, so it can bind to a `LIVE_APPROVAL` Release. The variant uses the same deterministic rule and the same deterministic second-look gate; only the tier/latency contract differs. `S0_RAW` continues as the ungated shadow counterfactual for both variants. The binding is tested in M7's exit gate.

### Row set

`READY_FOR_ATTENDED_TINY_LIVE` is computed **per strategy class**. For the deterministic `S0_SAFE` variant the rows are, all required unless marked:

- risk-authorizer isolation and DB-tamper tests (envelope and projection) green;
- deny-export active and verified for both Turnkey principals; signer policy id/digest pinned;
- persist-before-submit drill green;
- approval hash binding and replay tests green;
- tiny-live variant bound to a `LIVE_APPROVAL` Release with valid step-up attestation;
- wallet holds only tiny attested capital; recognized custody value at or below the D56 ceiling;
- reconciliation clean; no unknown wallet transactions;
- `CRITICAL` out-of-app delivery, escalation and dead-man pause tested;
- out-of-band `traderctl` pause and close tested;
- break-glass revoke and `SWEEP_TO_COLD_RECOVERY` exercised on the probe wallet and re-run on the trading wallet;
- Probe C (signer contract) re-run on the trading wallet;
- signer-outage drill green;
- DB-down emergency close tested;
- wallet SOL/USDC reserve thresholds healthy;
- operator-presence heartbeat active and its loss pauses new entries;
- capital attestation recorded;
- executor and risk-authorizer credentials in the isolated environment, not in any agent-readable workspace;
- forbidden-package artifact scan, runtime egress test and contract-digest match green;
- minimum live operator surface E2E green: approve, reject, arm, pause, mobile close, and Live Readiness `FAIL` blocks arming;
- Trigger lifecycle test green **if** provider protection is enabled; otherwise the readiness record states Profile 2 is `MONITORED_EXIT`-only;
- Probe A passed for the routes in use — **preferred, not required** for `LIVE_APPROVAL`, because D55 scopes the second signer-side policy layer to `LIVE_AUTO`; deny-export remains required;
- no open severity-1 defect.

Not required for this verdict: direct-pool emergency adapters, full §20 UI, replay, full SBOM tooling, Terraform.

### Scope rule

A green `S0_SAFE` verdict is never clearance for an LLM strategy. Any S1–S4 strategy going live at Profile 2 additionally requires the §29 rows for Action Adversary coverage including open-position `HOLD`, spend-budget enforcement and a `PROTECTION_ONLY` drill. `LIVE_AUTO` at any profile requires the D33 direct-pool adapter and the D55 signer-side policy, including Probe A.

## Consequences

- Profile 2 can open after M8a on a deterministic strategy under human approval, before M9–M11.
- The readiness screen must expose the strategy class the verdict was computed for.
- If Probe A fails, `LIVE_APPROVAL` tiny live remains possible; `LIVE_AUTO` waits on the signer fallback ADR.

## Operator sign-off

Sean Rogers, 2026-09-05. Surfaced by the implementation-agent reviews of plans v2 and v3.
