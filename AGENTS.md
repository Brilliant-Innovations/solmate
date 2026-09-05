# sol-agent-trader — notes for implementation agents

**Read `docs/implementation/GUARDRAILS.md` in full before doing anything.** It is the canonical law for this repository: the blueprint's §31 decisions and §32 review checklist verbatim, the execution plan's ground rules, and the trust-tag and module-boundary rules. This file only tells you where things are and how a session runs.

## Where things are

- Blueprint: `docs/blueprint/Solana_Autonomous_Trader_Blueprint_v1.10.md`.
- Execution plan: `docs/implementation/Execution_Plan_v4.md` (§7 playbook, §8 checklist).
- Decisions: `docs/decisions/` (ADR-0001 to ADR-0004 are the only intentional deviations from blueprint text).
- Probe results `docs/probes/`, review findings `docs/reviews/`, costs `docs/costs.md`, change log `docs/CHANGELOG.md`.
- Invariant map `invariant-test-map.yaml`, checked by `node tools/check-invariant-map.mjs`.

## Every session

1. Read the current milestone and the blueprint sections it lists. Pick one work package and state it.
2. Contracts first, then implementation, then tests, then invariant-map entries.
3. Before ending: invariant check green (and `nx affected -t lint,test` once the workspace exists); tick the §8 checkbox; add a line to `docs/CHANGELOG.md`; update `docs/costs.md` if a provider or tier changed.
4. Never edit the scope, dependencies or exit gate of an unticked milestone. Write an ADR and stop for the operator.
5. Gate reviews are run by a different model session or a human than the author, using GUARDRAILS.md Part 3.

## Toolchain

- Node 24 LTS (`.nvmrc`), pnpm pinned in `package.json` (corepack).
- Software signer and throwaway keys only. No live or probe credential belongs in this workspace.
