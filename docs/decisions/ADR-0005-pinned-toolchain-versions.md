# ADR-0005 — Pinned toolchain and library versions at M1 start

**Status:** Accepted
**Date:** 2026-09-05
**Class (§31 taxonomy):** TRADE-OFF / DECISION
**Blueprint text affected:** D58 names the stack (Node 24 LTS, pnpm + Nx, Next.js 16, Base UI, Zod, `@solana/kit`, Vitest, `fast-check`) without exact versions. This ADR records the versions verified against the npm registry on 2026-09-05 and two places where the newest major was deliberately not taken.
**§31-protected decision affected:** none.

## Context

Execution Plan v4 §6 requires verifying current docs and pinning exact versions at M1 start. Registry state on 2026-09-05:

| Package | Latest | Pinned | Why |
| --- | --- | --- | --- |
| Node.js | 24.20.0 (LTS) | 24.x via `.nvmrc` / `engines` | D58 |
| pnpm | 10.28.2 | 10.28.2 via `packageManager` | corepack-managed |
| nx and `@nx/*` | 23.2.0 | 23.2.0 exact | `@nx/next` peer range `next >=14 <17` accepts Next 16 |
| typescript | 7.0.2 | ~6.0.3 | Nx 23.2 generates TS 6.0; `typescript-eslint` supports `<6.1.0`. TS 7 is outside every tool's declared range |
| next | 16.3.4 | 16.3.4 | D58 Next.js 16 Active LTS; `engines.node >=20.9` |
| react / react-dom | 19.2.8 | ^19.2.8 | |
| zod | 4.5.4 | ^4.5.4 | canonical wire-boundary schema layer (D58) |
| vitest | 5.0.0 | ^4.1.11 | `@nx/vitest` peer range is `^3 \|\| ^4`; Vitest 5.0.0 released too recently |
| fast-check | 4.9.0 | ^4.9.0 | property tests (§24.6) |
| eslint | 10.10.0 | ^9.39.5 | `@nx/eslint` and `typescript-eslint` accept 10, but `eslint-plugin-react` 7.37.5 (peer `<=^9.7`) and `eslint-plugin-react-hooks` 5.0.0 call APIs removed in ESLint 10 and crash on the React projects. Pinned to latest 9 until `eslint-plugin-react` supports 10 |
| eslint-plugin-react-hooks | 7.1.1 | ^7.1.1 | matches what `eslint-config-next` 16.3.4 pins; Nx's generator default of 5.0.0 is replaced |
| `@solana/kit` / `@solana/react` | 8.2.0 | ^8.2.0 | |
| `@solana/kit-plugin-wallet` | 0.19.0 | ^0.19.0 | pre-1.0; watch for breaking minors |
| `@base-ui/react` | 1.8.0 | ^1.8.0 | blueprint package name confirmed; `@base-ui-components/react` is the old rc name |
| `@tanstack/react-query` | 5.102.8 | ^5.102 | |
| `@tanstack/react-table` | 9.2.4 | ^9.2 | |
| lightweight-charts | 5.2.1 | ^5.2 | attribution requirement (§5.1) |
| recharts | 3.10.1 | ^3.10 | |
| `@supabase/supabase-js` | 2.115.0 | ^2.115 | |
| `@turnkey/sdk-server` | 8.4.0 | ^8.4 | M3, execution-service only |
| `@opentelemetry/api` | 1.9.1 | ^1.9 | |
| `@sentry/nextjs` / `@sentry/node` | 10.73.0 | ^10.73 | |
| `@simplewebauthn/server` | 14.0.1 (2026-09-05) | ^14.0.1 | worker only; passkey step-up verifier (ADR-0006, added 2026-09-06). Node ≥ 22 |
| `@simplewebauthn/browser` | 14.0.0 (2026-09-02) | ^14.0.0 | web, from M9 (ADR-0006). `@simplewebauthn/types` is retired since v13; types ship in server/browser |

## Decision

- Pin the versions in the table. Exact pins for Nx and Next; caret ranges within the same major elsewhere, locked by `pnpm-lock.yaml`.
- Do not adopt TypeScript 7 or Vitest 5 until Nx and `typescript-eslint` declare support; revisit at M2 exit.
- Any major-version bump of a package in the financial deployables (`risk-authorizer`, `execution-service`) is a reviewed change recorded in `docs/CHANGELOG.md`, not a routine dependency update.

## Consequences

- Workspace generated with `create-nx-workspace@23.2.0 --preset=ts` (TS solution setup: workspaces plus project references).
- `pnpm-workspace.yaml` uses `apps/*` and `libs/*` per blueprint §4.1 instead of the generator's `packages/*`.
- Nx-generated per-agent instruction folders (`.claude/`, `.cursor/`, `.codex/`, `.gemini/`, `.opencode/`, `.agents/`) are not adopted; `CLAUDE.md` and `AGENTS.md` with `GUARDRAILS.md` remain the only agent instructions (ground rule 9).

## Operator sign-off

Sean Rogers, 2026-09-05. Registry check performed at M1 start per plan §6.
