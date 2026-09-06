# Profile 0 / 1A launch

Two ways to run the three Node services on the workstation (blueprint D65; `config/profiles/P0.json`, `P1A.json`). Both keep one credential file per logical service, which is what the M2 exit gate checks: no process can read another service's secrets.

## Containers (same images CI publishes)

```sh
pnpm exec supabase start                 # local Supabase on 553xx
cd deploy/profile-0
cp .env.worker.example .env.worker
cp .env.risk-authorizer.example .env.risk-authorizer
cp .env.execution-service.example .env.execution-service
docker compose up --build
```

`deploy/Dockerfile` builds the workspace, bundles one service into a single `main.js`, runs `tools/check-artifacts.mjs` and fails the build on any banned package. The runtime image is `node:24.20.0-alpine` plus that file, running as the `node` user with a read-only root filesystem and all capabilities dropped. The executor's journal is the named volume `executor-journal`.

Published images: `ghcr.io/brilliant-innovations/solmate-{worker,risk-authorizer,execution-service}` (`.github/workflows/images.yml`, `GITHUB_TOKEN` only).

## Processes (fastest inner loop)

```sh
pnpm nx serve @sol-agent-trader/worker
pnpm nx serve @sol-agent-trader/risk-authorizer
pnpm nx serve @sol-agent-trader/execution-service
```

Each reads its own env file from the shell you start it in; `.env.example` at the repo root lists the names per service. Every service validates its environment before anything else runs (`libs/contracts/src/config/env.ts`): a missing required name or a credential outside its trust class is fatal (`event: env_invalid`, names only, never values). `node main.js --print-digest` prints the contract digest without touching the environment; CI and the image workflow use it.

## Not here

Profile 1B (Vercel Sandbox), Profile 2 (isolated VM holding live credentials) and Profiles 3/4 (fixed-price VM, three hosts) are declared in `config/profiles/` and provisioned in M11 (ADR-0002).
