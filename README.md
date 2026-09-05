# sol-agent-trader

Implementation of the **Solana Autonomous Trader** blueprint v1.10: a Solana spot trading platform where deterministic scanners find candidates, a versioned Trading Skill proposes actions, an independent adversary challenges every discretionary action, a process-isolated risk-authorizer signs intents, and an isolated executor validates and submits through a non-exportable signer. Live capability is built from day one and disabled by default.

- Blueprint: `docs/blueprint/Solana_Autonomous_Trader_Blueprint_v1.10.md`
- Execution plan and milestone checklist: `docs/implementation/Execution_Plan_v4.md`
- Canonical guardrails for every implementing session: `docs/implementation/GUARDRAILS.md`
- Decisions: `docs/decisions/`

## Workspace

pnpm + Nx monorepo (TypeScript solution setup). Node 24 LTS (`.nvmrc`), pnpm pinned via `packageManager` (corepack).

```
apps/   web · worker · risk-authorizer · execution-service
libs/   contracts · db · market · onchain · solana-hard-state · intelligence · signals
        strategies · agents · skills · risk · execution · wallet-ui · replay · observability · testing
```

Trust boundaries between these projects are enforced at source level by Nx tags and `@nx/enforce-module-boundaries` (see GUARDRAILS.md Part 4) and at artifact level from milestone M8a.

## Commands

```
pnpm install
pnpm check:invariants          # invariant-test-map.yaml vs built modules
pnpm nx affected -t lint test typecheck
```
