# Provider probes (milestone MP)

Probes are small scripts run against real providers whose answers can change the design. They run from the **isolated environment** with the probe-only Turnkey wallet, never from a coding-agent workspace (GUARDRAILS.md Part 4). Each result is recorded here and its consequences become an ADR.

| Probe | File | Question | Blueprint |
| --- | --- | --- | --- |
| A | `turnkey-alt-policy.md` | Can the pinned Turnkey Solana policy accept legitimate Jupiter v0 `/order` routes and deny lookup-table placeholder, transfer and program-key cases? Is deny-export verified for both principals? | D47, D55, §15.7A, §45.1 |
| B | `trigger-lot-isolation.md` | Does the exact Jupiter Trigger V2 mode/version prove seeded per-order balance isolation through a real deposit and two-step cancel/withdraw? | D44, §16.5, §24.2 |
| C | `signer-contract.md` | Does the Turnkey signer produce canonical Solana Ed25519 signatures with acceptable latency, deterministic identical-bytes retry and an audit log entry? | §15.4, §15.7, §29 |

## Result template

```markdown
# Probe X — <title>

**Date run:** YYYY-MM-DD
**Environment:** isolated VM `<name>`; probe wallet `<pubkey>`; cluster mainnet-beta
**Provider versions:** Turnkey API <version> / policy language <version>; Jupiter Swap V2 <date>; Trigger V2 <mode/version>
**Script:** <path or commit>

## Cases

| # | Case | Expected | Observed | Pass |
| --- | --- | --- | --- | --- |

## Verdict

PASS / FAIL / PARTIAL, one paragraph.

## Consequences

- ADR-NNNN written / not needed.
- Plan rows affected.
```

## Milestone gate evidence

Live-evidence walks of an exit gate, gathered by the authoring session and referenced from the plan §8 checklist. They are not provider probes and need no isolated environment.

| Milestone | File |
| --- | --- |
| M4 | `m4-exit-gate-2026-09-07.md` — gate items with hosted-stack evidence; one item blocked by the Birdeye tier |
