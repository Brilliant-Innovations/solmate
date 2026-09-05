@docs/implementation/GUARDRAILS.md

# sol-agent-trader — Claude Code notes

The guardrails above are canonical and are imported, not copied. Everything below is workflow only.

## Where things are

- Blueprint: `docs/blueprint/Solana_Autonomous_Trader_Blueprint_v1.10.md` (§, D and P references everywhere point here).
- Execution plan: `docs/implementation/Execution_Plan_v4.md`. §7 is the session playbook; §8 is the milestone checklist.
- Decisions: `docs/decisions/` (ADR-0001 to ADR-0004 record the only intentional deviations from blueprint text).
- Probe results: `docs/probes/`. Review findings: `docs/reviews/`. Costs: `docs/costs.md`. Change log: `docs/CHANGELOG.md`.
- Invariant map: `invariant-test-map.yaml`, checked by `node tools/check-invariant-map.mjs`.

## Every session

1. Read the current milestone in the plan (§4) and the blueprint sections it lists. Pick one work package and say what it is.
2. Contracts first, then implementation, then tests, then invariant-map entries.
3. Before ending: `node tools/check-invariant-map.mjs` green (and `nx affected -t lint,test` once the workspace exists), tick the §8 checkbox, add a line to `docs/CHANGELOG.md`, update `docs/costs.md` if a provider or tier changed.
4. Never edit the scope, dependencies or exit gate of an unticked milestone. Write an ADR and stop for the operator instead.
5. If a gate milestone closed, the review is done by a fresh session with `docs/implementation/GUARDRAILS.md` Part 3 as the checklist, findings in `docs/reviews/`.

## Toolchain

- Node 24 LTS (`.nvmrc`), pnpm pinned by `packageManager` in `package.json` (use corepack).
- Software signer and throwaway keys only in this workspace. Probes and live credentials run from the isolated environment described in plan milestone MP.
