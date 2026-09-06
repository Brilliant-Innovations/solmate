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
| Jupiter API | | | | MP |
| Turnkey | | | | MP |
| Birdeye | | | | M4 |
| Helius | | | | M4 |
| LunarCrush | | | | M6 |
| CryptoPanic | | | | M6 |
| LLM provider (proposer) | | | | M6 |
| LLM provider (adversary) | | | | M6 |
| Notification channels | | | | M8a |
