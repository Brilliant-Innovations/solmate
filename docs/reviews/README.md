# Adversarial review records

Each gate milestone ends with an independent review by a **different model session or a human than the author** (D50, plan ground rule 4). The checklist is GUARDRAILS.md Part 3 (blueprint §32). One file per review.

| Review | Gate | Scope |
| --- | --- | --- |
| #0 | M1 | `/libs/contracts` and all state machines; explicitly: no position behavior inside the action cycle (ADR-0001) |
| #1 | M3 | §32 security + trading correctness, financial boundary skeletons |
| #2 | M6 | §32 AI boundary |
| #3 | M8a | §32 security + trading correctness with emergency paths; tiny-live row set (ADR-0004) |
| #4 | M11 | full §32 including compositional cases |

## Record template

```markdown
# Review #N — <milestone> — YYYY-MM-DD

**Reviewer:** <model + session id, or person>  **Author of reviewed work:** <session id>
**Commit range:** <from>..<to>

## Findings

| # | §32 item | Severity (critical/high/medium/low) | Class (§31) | Finding | Evidence | Disposition |
| --- | --- | --- | --- | --- | --- | --- |

## Verdict

Gate PASS / gate BLOCKED. Unresolved critical/high findings block the gate.
```
