# Operating costs (monthly run-rate)

Recorded at every milestone exit (execution plan §3). D43 spend budgets and D37 platform economic P&L are configured from these numbers, not guessed. Amounts in USD per month unless noted.

| Milestone exit | Date | Provider / service | Tier | Monthly | Notes |
| --- | --- | --- | --- | --- | --- |
| M0 | 2026-09-05 | none | — | 0 | Local repository only. |
| M2 | 2026-09-06 | GitHub (Actions, GHCR) | Free (organisation `Brilliant-Innovations`) | 0 | Private repo; Actions minutes within free quota; GHCR private storage 500 MB free — three service images ≈ 80 MB compressed each per tag, so prune old `sha-*` tags before ~2 tags per service accumulate. |
| M2 | 2026-09-06 | Vercel | Hobby (team `Beakforce`) | 0 | `apps/web` only. Blueprint D57 names Pro (USD 20/seat/month) for the `session-resume-watchdog` cron and team features; upgrade decision at M8a. |
| M2 | 2026-09-06 | Supabase | Free (project `jwujkzorirttwgsdoztq`) | 0 | 500 MB database, 2 M realtime messages, 50 000 MAU; Auth TOTP free. Expect Pro (USD 25/month) when OHLCV storage grows in M4. |
| M2 | 2026-09-06 | Sentry | Developer (org `beakforce`) | 0 | 5 000 errors / 10 M spans per month across the four projects. |
| **M2 total** | 2026-09-06 | | | **0** | No paid tier yet. Three GHCR images published; every service startup logs the contract digest, not spend. |

## Provider tier register

Filled in as each account is created (plan §3 prerequisites table). Tier limits feed the §21.1 freshness contracts and are shown read-only in Settings (§20.26).

| Provider | Account created | Tier | Rate limit / quota assumed | Used from |
| --- | --- | --- | --- | --- |
| GitHub (Actions, GHCR) | 2026-09-05 | Free | 2 000 Actions minutes/month, 500 MB GHCR storage, 1 GB transfer | M0 / M2 |
| Vercel | 2026-09-06 | Hobby | 100 GB bandwidth, serverless within Hobby limits, no team seats, cron limited to daily | M2 |
| Supabase | 2026-09-06 | Free | 500 MB DB, 1 GB file storage, 2 M realtime messages, 200 concurrent realtime peers, API rate limits per `supabase/config.toml` `[auth.rate_limit]` | M2 |
| Sentry | 2026-09-06 | Developer | 5 000 errors, 10 M spans, 50 replays per month; 1 user | M2 |
| Independent Solana RPC | | | | M3 |
| Jupiter API | not yet (Price V3 works keyless on `lite-api.jup.ag`) | Lite (free) → Pro/Ultra with `x-api-key` on `api.jup.ag` | 50 ids per Price V3 request; adapter defaults to 1 rps keyless, 10 rps with a key (`libs/market/jupiter`) | MP / M4 |
| Turnkey | | | | MP |
| Birdeye | not yet (`BIRDEYE_API_KEY` absent → market feeds report FAILED) | Standard $0 (30k CU, 1 rps, no WS) · Lite $39 (2.5M CU, 15 rps) · Starter $99 (8M CU, 15 rps) · Premium $199 (20M CU, 50 rps, WS) · Business $499 (60M CU, 100 rps, WS); verified 2026-09-06 | CU per call: ohlcv v3 45–100, multi_price ⌈3·n^0.8⌉, trending 25, new_listing 20, token/list 50, overview 15, security 25, holders 30; token/list scroll 2 rps. `BIRDEYE_TIER` sizes the adapter's rate and CU budgets (`libs/market/birdeye/tiers.ts`); Standard cannot sustain a 60 s loop (≈1 000 CU/day) and returns 401 on `/defi/token_security` ("API key lacks sufficient permissions", observed 2026-09-07), so eligibility cannot leave EVALUATING on Standard; Lite is the realistic P1A floor | M4 |
| Solana RPC (public `api.mainnet-beta.solana.com`) | in use, keyless | public | `getAccountInfo`/`getTokenSupply` fine at ~4 rps; `getTokenLargestAccounts` refused with 429 regardless of pacing (observed 2026-09-07), so chain-derived concentration needs a keyed RPC — Helius free tier is the planned M4 adapter | M4 |
| Helius | in use since 2026-09-07 (free key in the local worker env; absent key → reconciliation treats every wallet transaction as unexplained and pauses) | Free (10 rps, 1M credits/month; Parsed Events + webhooks on all plans) → Developer $49 as measured need appears | Adapter uses Parsed Events `POST /v1/parsed-events/transactions` only for signatures the read-only RPC already listed (100 per call, 2 rps default); Enhanced Transactions v0 is in maintenance mode per Helius docs (2026-09-07), legacy payload shape still accepted for replay; the Helius RPC endpoint can also serve `SOLANA_RPC_URL` for `getTokenLargestAccounts` | M4 |
| LunarCrush | | | | M6 |
| CryptoPanic | | | | M6 |
| LLM provider (proposer) | | | | M6 |
| LLM provider (adversary) | | | | M6 |
| Notification channels | | | | M8a |
