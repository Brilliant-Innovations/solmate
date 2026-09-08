# Provider probes (milestone MP)

Probes are small scripts run against real providers whose answers can change the design. They run from the **isolated environment** with the probe-only Turnkey wallet, never from a coding-agent workspace (GUARDRAILS.md Part 4). Each result is recorded here and its consequences become an ADR.

| Probe | File | Question | Blueprint |
| --- | --- | --- | --- |
| A | `turnkey-alt-policy.md` | Four separately recorded results (ADR-0008): (a) deny-export and policy-administration restrictions for both principals; (b) acceptance of the Profile 2 shape set (ADR-0007); (c) rejection of malicious shapes — foreign program, foreign recipient, extra signer, `ADDRESS_TABLE_LOOKUP` placeholder; (d) lookup-table compatibility. Readiness needs (a)–(c). | D47, D55, §15.7A, §45.1, ADR-0007/0008 |
| B | `trigger-lot-isolation.md` | Does the exact Jupiter Trigger V2 mode/version prove seeded per-order balance isolation through a real deposit and two-step cancel/withdraw? | D44, §16.5, §24.2 |
| D | `trigger-auth.md` | Does Jupiter Trigger V2 wallet-message authentication work under the selected signer policy: approved challenge format and domain, challenge freshness and replay behaviour, a signing permission narrow enough that it cannot be turned into arbitrary message signing? Results kept separate for routing availability, signer availability and custody-release availability. | §16.2, §16.3, D44, D55 |
| C | `signer-contract.md` | Does the Turnkey signer produce canonical Solana Ed25519 signatures with acceptable latency, deterministic identical-bytes retry and an audit log entry? | §15.4, §15.7, §29 |

## Probe authorization boundary (operator review item 7)

Probes sign, deposit and withdraw real value before the ordinary live gate exists. Every probe run is authorized in writing before it starts, and the result file records the boundary it ran under:

- maximum probe-wallet value and maximum cumulative fees/loss (USD);
- allowed assets, programs and destination addresses; the cold-recovery destination is registered before the first probe that could need it;
- exact script paths and build/commit hashes approved for execution;
- who authorizes and who runs, from which isolated environment;
- abort conditions and recovery steps;
- post-probe chain/custody reconciliation of the probe wallet;
- credential revocation and cleanup after the run.

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
| M5a | `m5a-pipeline-evidence-2026-09-08.md` — every package running against the hosted project; first paper trade 03:33 UTC (S0_RAW took STONK, S0_SAFE rejected it on OVEREXTENDED_1H), reconstruction re-run on the real decision; gate met |
| M5b | `m5b-evidence-2026-09-08.md` — P3 deliverables and acceptance mapped to code, tests and the hosted worker (regime, cohorts/clusters, two deterministic trigger families, self-influence flag, D32 expiry); gate met |
| M3 | `m3-exit-gate-evidence-2026-09-08.md` — every exit-gate item mapped to its enforcing module and tests; both financial services started in Profile 0 (fenced journal, recovery, authenticated planes, signed pause via `traderctl`); Turnkey adapter and review #1 still owed |
