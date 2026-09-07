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

## First worker run (market ingestion against the hosted Supabase)

The worker validates its whole credential set before it does anything, so the env file has to be complete. Nothing below goes to Vercel or GitHub; Vercel holds only the web app's two public values.

1. Generate throwaway signing keys and paste the worker block into `deploy/profile-0/.env.worker` (or `.env.local` for the process route):

   ```sh
   node tools/dev-keys.mjs
   ```

2. Fill the Supabase values from the hosted project's dashboard: `SUPABASE_URL` (Project Settings → API), `SUPABASE_SERVICE_ROLE_KEY` (the `sb_secret_…` key; worker only, never the browser), `SUPABASE_DB_URL` (Project Settings → Database → connection string, session mode, with the database password). For the local stack use the values already in the `.example` file.

3. Add the market-data settings. The free Birdeye tier meters compute units, not calls (about 1,000 units a day; one OHLCV request is 45), so keep the interval long:

   ```
   BIRDEYE_API_KEY=<key>
   BIRDEYE_TIER=STANDARD
   WORKER_ROLES=market-ingest
   MARKET_INGEST_INTERVAL_MS=1800000
   ```

4. Start it. Container route: `docker compose up --build worker` from this directory. Process route: `pnpm nx serve @sol-agent-trader/worker` with the values exported in the shell. A successful start logs `startup`, then `market_ingest_starting` with the budgets computed from the tier, then one `market_ingest_cycle` line per cycle with counts of candles written and rejected, assets discovered, snapshots and errors. Feed health lands in `ops.provider_health` and is visible to the web app.

   Add `eligibility` and `held-asset-safety` to `WORKER_ROLES` once `SOLANA_RPC_URL` is set; safety re-checks every open position each `HELD_ASSET_SAFETY_INTERVAL_MS` (default 60 s) and logs `position_safety_changed` whenever a state moves. Migration 001400 must be applied for that role. `reconciliation` compares every trading account's wallet against the ledger each `RECONCILIATION_INTERVAL_MS` and pauses running sessions on any unexplained balance or movement (migration 001500); set `HELIUS_API_KEY` (free tier) or every transaction touching the wallet counts as unexplained.

If the worker exits with `env_invalid`, the log names the missing or forbidden variables (never their values). If it logs `market_ingest_lease_unavailable`, another worker holds the `market-ingest` lease; stop it or wait for the 90-second lease to lapse.

## Not here

Profile 1B (Vercel Sandbox), Profile 2 (isolated VM holding live credentials) and Profiles 3/4 (fixed-price VM, three hosts) are declared in `config/profiles/` and provisioned in M11 (ADR-0002).
