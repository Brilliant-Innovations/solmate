# Execution Plan v4 — Solana Autonomous Trader (Blueprint v1.10)

**Plan date:** 2026-09-05
**Source:** `Solana_Autonomous_Trader_Blueprint_v1.10.md` (5,541 lines, 65 decisions, 11 phases)
**Supersedes:** Execution Plan v3 (same date). Replaces `C:\Distros\Solmate\EXECUTION_PLAN.md` and the published v1 artifact.
**Repo state today:** one blueprint file, no git, no code.

v4 folds in the implementation agent's reviews of v2 and v3. It changes **no §31-protected decision**. It does deviate from blueprint *text* in four places; each is an ADR written in M0, listed below, so an implementing session never has to guess whether plan-versus-blueprint differences are intentional.

**ADRs written in M0 (deviations from blueprint text):**

- **ADR-0001 — `PROTECTION_ONLY` split.** §6.10D lists `PROTECTION_ONLY` as an action-cycle final state. v4 models it as a *position review* state entered from an action cycle whose terminal state is `UNRESOLVED` with a six-value reason enum matching D39's causes (disagreement, adversary/model outage, timeout, spend budget, malformed output, exhausted revision budget). The cycle remains canonical for the final *action* disposition and keeps its unresolved-reason field.
- **ADR-0002 — Terraform deferral.** P0 acceptance expects Profile 4 Terraform manifests to exist unapplied. v4 defers the DigitalOcean Terraform to M11 but defines the D65 deployment profiles in configuration and CI in M2, which is what §35.2 actually needs.
- **ADR-0003 — Sequencing relative to §35.** v4 runs market data → first paper trade before the financial boundary, moves probes to their own milestone, runs M7 on `S0_SAFE` before M6 completes, splits M8, and builds research screens after replay. Scope is unchanged. Guard: the paper/live `ExecutionAdapter` contract and one shared Jupiter quote client are fixed in M1 so the paper path cannot grow a duplicate adapter and fail P7's "only the execution adapter differs."
- **ADR-0004 — Tiny-live strategy variant and readiness row set.** Defines the Profile 2 `S0_SAFE` variant (tier and intent expiry above `human_reaction_floor_ms`), the `READY_FOR_ATTENDED_TINY_LIVE` rows, and marks Probe A as a *preferred* rather than required row for `LIVE_APPROVAL`, since D55 scopes signer-side policy to `LIVE_AUTO`. **The verdict is computed per strategy class.** The row set below clears the deterministic `S0_SAFE` variant only; any S1–S4 strategy going live at Profile 2 additionally requires the §29 rows for adversary coverage (including `HOLD`), spend-budget enforcement and a `PROTECTION_ONLY` drill. A green `S0_SAFE` verdict is never clearance for an LLM strategy.

**What changed from v3** (A = implementation-agent review of v3):

- ADR-0001 wording fixed: D39 lists six causes, and the M1 enum has six values. [A]
- ADR-0004 states the tiny-live verdict is per strategy class; a green `S0_SAFE` verdict is not clearance for S1–S4. [A]
- M8a re-runs Probe C and the break-glass revoke/sweep on the actual Profile 2 trading wallet, not only the probe wallet (§29, D36). [A]
- Wallet reserve monitoring (D35, §33 item 18) is placed in M8a with the notifications work. [A]
- The minimum live operator surface gains Wallet/Custody basics: address, balances, recognized custody value against the attested ceiling, reconciliation state. [A]
- Signer-outage drill named as an M8a row (D51). [A]
- `STARTING` warm-up test moves into M5a's exit; "Live Readiness FAIL blocks arming" E2E into M8a's. [A]
- Profile 1B gains a start condition: after M5b, once M7's restart recovery exists. [A]

**What changed from v2** (A = implementation-agent review; F = Fable; C = ChatGPT):

- Preamble corrected: v2 claimed no blueprint text changed; four deviations are now ADRs. [A]
- Profile 2 path repaired: `S0_SAFE` gets a tiny-live variant whose expiry clears the human-reaction floor, otherwise it cannot bind to a `LIVE_APPROVAL` Release. [A]
- M8a gains a **minimum live operator surface**: Approval Queue (desktop + mobile), Release-bound arming review with WebAuthn, Live Readiness with the tiny-live rows, alert acknowledgement, mobile pause and emergency close. [A]
- M8a gains the cheap D50 artifact checks: forbidden-package artifact scan, runtime egress test, contract-digest match. Full SBOM tooling and Terraform stay in M11. [A]
- Profile 2 is `MONITORED_EXIT`-only unless the Trigger lifecycle test is green in M8a; Trigger acceptance moves into M8a as a conditional row. [A]
- Action cycle terminal states: `CLEARED` / `REJECTED` / `EXPIRED` / `UNRESOLVED(reason)`. [A]
- M2 defines deployment profiles in config and CI; Terraform to M11 by ADR. [A]
- M1 fixes the `ExecutionAdapter` contract and a shared Jupiter quote/order client. [A]
- M5a persists `S0_SAFE` decisions as action cycles with the deterministic gate recorded as the adversary. [A]
- Ground rule 2 CI semantic: fail only on unmapped invariants whose owning module exists. [A]
- M8b and M9 run in parallel. [A]
- Candidate-side self-influence guard added to M5b; data-retention jobs added to M4. [A]
- Probe wallet holds a token for Probe B's vault deposit, not gas only. [A]
- `CLAUDE.md` uses an `@docs/implementation/GUARDRAILS.md` import so every session actually loads the guardrails. [A]
- (Carried from v2) `/libs/solana-hard-state` in M3 [C]; `PROTECTION_ONLY` on the position machine [C]; Track B working priority [C, F]; probes milestone [F]; risk core in M5a [F]; M5 and M8 splits [F]; M7 on `S0_SAFE` [F]; research screens after M10 [F]; review #0 [F]; `GUARDRAILS.md` canonical [C]; plan-update boundary [C]; cost column [F]; calendar language removed [C]; M4 wording [C].

---

## 1. The blueprint in one paragraph

A four-deployable Nx/pnpm monorepo (`web`, `worker`, `risk-authorizer`, `execution-service`) on Next.js 16 + Supabase + Turnkey. Deterministic scanners find Solana spot candidates; a versioned Trading Skill (LLM) proposes actions; an independent Action Adversary challenges every discretionary action including `HOLD`; a process-isolated risk-authorizer signs an envelope after independently re-reading chain state; the executor validates by simulation and semantic balance deltas, persists before submit, and requests a signature from a non-exportable Turnkey key under a second signer-side policy. Live capability is built from day one but defaults to `OBSERVE`/`PAPER`. Hosting matures with evidence (Profiles 0–4). Done means the full §20 UI, replay, and Live Readiness gate exist even if live is never armed.

---

## 2. Ground rules for every work session

1. **Contract-first.** `/libs/contracts` is the only wire-schema source (D50). No deployable redefines a schema locally. Every milestone regenerates the contract-set digest.
2. **Invariant map is a build artifact.** `invariant-test-map` gains an entry the moment an invariant from §24.6 becomes implementable. CI fails on any unmapped invariant **whose owning module exists**; invariants for modules not yet built stay `status: unmapped` without failing the build. Property tests use `fast-check`.
3. **Prove dangerous, stateful parts early, but not on the critical path to the first paper trade.** Track B (M4 → M5a) has working priority. Track A (MP → M3) proceeds whenever Track B is not blocked and must finish before M7.
4. **Independent adversarial review at gates.** Reviews are run by a different model session or a human, never the authoring session (D50). Use §32 as the checklist.
5. **Developer-agent hygiene.** No live financial credential (Turnkey executor or probe credential, risk-authorizer private key) ever lives in a shell, `.env` or filesystem that a coding agent can read (D65). Development uses the software signer and throwaway keys. Probes run from the isolated environment described in MP.
6. **Never silently "improve" a §31 item.** Write `docs/decisions/ADR-NNNN.md`, classify it DEFECT / MISSING REQUIREMENT / TRADE-OFF / ENHANCEMENT, and stop for operator decision.
7. **Definition of done per work package:** code + Zod contracts + unit/property tests + invariant-map entries + plan checkbox ticked + ADR if any.
8. **Plan-update boundary.** Implementation sessions may tick checkboxes, attach evidence links and append to `docs/CHANGELOG.md`. They may not rewrite the scope, dependencies or acceptance gate of any milestone that is not yet complete. A needed change to a future milestone is an ADR with an operator decision, then a plan edit by the operator.
9. **Guardrails live in one file.** `/docs/implementation/GUARDRAILS.md` holds §31 verbatim, the §32 checklist, these ground rules and the trust-tag/boundary rules. `CLAUDE.md` contains the line `@docs/implementation/GUARDRAILS.md` (Claude Code loads `@` imports; it does not load files merely mentioned) plus Claude-specific workflow notes. `AGENTS.md` carries the equivalent for other models.

---

## 3. Prerequisites the operator must supply

Nothing paid or persistent is needed before M2. Nothing three-host before Profile 4. Record the actual monthly run-rate in `docs/costs.md` at every milestone exit; D43 budgets are configured from those numbers, not guessed.

| Item | Needed by | Cost posture | Notes |
| --- | --- | --- | --- |
| GitHub repo + Actions + GHCR | M0 / M2 | Free tier adequate | Actions environments for scoped deploy credentials |
| Vercel Pro project | M2 | First recurring cost | `/apps/web` only; later hosts `session-resume-watchdog` cron (M8a) |
| Supabase project | M2 | Free tier until OHLCV storage outgrows it (expect during M4) | Auth, Realtime Broadcast, Queues/`pgmq`; CLI migrations are schema authority |
| Sentry project(s) | M2 | Free tier adequate initially | Web + Node services |
| Second independent Solana RPC | M3 | Free/dev tier adequate for probes and paper | Simulation/reconciliation disagreement checks (D27, D49); must not be Helius |
| Jupiter API key | MP | Free | Swap V2 `/order` + `/execute`, Trigger V2, Price V3 |
| Turnkey organization | MP | Check current dev/free tier; usage-billed above it | Two principals (autonomous executor, break-glass), both with deny-export policy; a probe-only wallet |
| Probe wallet | MP | Gas **plus a small amount of one liquid SPL token** for Probe B's Trigger vault deposit | Created inside Turnkey; distinct from the trading wallet |
| Birdeye API plan | M4 | First meaningful provider cost; WebSocket access is tier-gated | REST-capable tier first; upgrade for streaming when M4 needs it; tier sets universe size |
| Helius plan | M4 | Free/dev tier first | RPC + webhooks/WSS; upgrade on measured need |
| LunarCrush plan | M6 | Paid | Normalized social metrics |
| CryptoPanic plan | M6 | Paid tier for full metadata | News + sentiment |
| Two LLM providers/models | M6 | Usage-billed; capped by D43 | Proposer and adversary differ (§11.2); record exact model IDs |
| Notification channels | M8a | Mostly free (Telegram, email); SMS usage-billed | Mobile push + at least one out-of-app channel; `CRITICAL` needs two |
| Cold-recovery wallet | M8a | None | Pre-registered, pinned outside the app (D54) |
| Dedicated isolated environment for live credentials | MP, Profile 2 | None (VM on existing hardware) | Separate from any coding-agent workspace (D65); also where probes run |
| Tiny mainnet trading wallet | Profile 2 | Tiny attested capital | Distinct from the probe wallet |

**Decisions to make early:** ADR-0001…0004 above in M0; initial §27 risk defaults and §7.2 eligibility thresholds (versioned config); proposer/adversary model policy and D43 budgets; operator timezone/display defaults.

---

## 4. Milestones

Sizes S / M / L / XL are **relative implementation complexity only**, not durations. The first functional slice is M0–M5a.

### M0 — Repo bootstrap (S)
Blueprint: §31, §35.1 preamble.
- `git init`; blueprint to `docs/blueprint/`; `docs/decisions/` with ADR template and **ADR-0001…0004 written**; `docs/probes/`, `docs/reviews/`, `docs/costs.md`, `docs/CHANGELOG.md`.
- `/docs/implementation/GUARDRAILS.md` with §31 verbatim, §32 checklist, §2 ground rules, trust-tag rules. `CLAUDE.md` with `@docs/implementation/GUARDRAILS.md` and Claude-specific notes; `AGENTS.md` equivalent.
- Empty `invariant-test-map.yaml` with §24.6 invariant IDs pre-listed and `status: unmapped`; CI rule per ground rule 2.
- `.gitignore`, `.editorconfig`, Node 24 LTS `.nvmrc`/`engines`, pnpm pinned.

**Exit gate:** repo committed; GUARDRAILS.md present and imported; four ADRs present; invariant IDs enumerated.

### M1 — Workspace, contracts and state machines (L)
Blueprint: P0, §35.1, §35.3, §35.4, §4.1, D58.
- Nx workspace: four apps + all `/libs/*` from §4.1 plus `/libs/solana-hard-state` (built in M3). Project tags by trust/scope; `@nx/enforce-module-boundaries` with external-import bans (no LLM/DEX/signer SDKs in `risk-authorizer`, read-only RPC permitted per §24.8; no signer credential path in `worker`; no service role in `web`).
- `/libs/contracts`: Zod schemas for every §6 entity and envelope: `TradingActionProposal`, `AdversarialReview`, `ActionCycle`, `RiskStateProjection`, `RiskAuthorizedIntentEnvelope`, `Approval`, `TradeIntent`, `SignedEmergencyCommand`, `PositionRiskShadow`, `ExecutorJournalEntry`, `Release`/`ReleaseAttestation`, `RuntimeSession`, `FundTradingWalletRequest`/`WalletFundingEvent`, queue message envelopes.
- **`ExecutionAdapter` contract** with two implementations planned (`paper`, `live`) and one shared **Jupiter quote/order client** in `/libs/execution` that both consume (ADR-0003 guard).
- Contract-set digest generator + cross-boundary encode/decode harness.
- `Clock` abstraction; lint rule banning `Date.now()` in strategy/replay code.
- State machines as pure code with property tests, separated by domain:
  - candidate;
  - **action cycle** — stages, cutoff versions, one revision round; terminal states `CLEARED` / `REJECTED` / `EXPIRED` / `UNRESOLVED` with `unresolved_reason` ∈ {`DISAGREEMENT`, `ADVERSARY_UNAVAILABLE`, `TIMEOUT`, `BUDGET`, `MALFORMED_OUTPUT`, `REVISION_EXHAUSTED`}. Canonical for final action disposition; owns no position behavior (ADR-0001).
  - **position review state** — `REVIEWED` / `PROTECTION_ONLY` / `BUDGET_PAUSED`, entered from an `UNRESOLVED` cycle per D39; a `trading.positions` concern.
  - intent; order attempt (`SIGNED_NOT_SUBMITTED` → `SUBMITTED` → `CONFIRMED_PROVISIONAL` → `FINALIZED` / `REORG_PENDING`); position/lot; custody;
  - runtime session (`OFF`/`STARTING`/`WATCH`/`ACTIVE`/`EVENT_WINDOW`/`WIND_DOWN`) × capital authority × sticky `PAUSED`.
- Signing/verification primitives for envelope, projection, approval and emergency-command keys, with tests.
- Forbidden-import static analysis config per deployable (§24.8 source half).

**Exit gate:** `nx affected -t lint,test` green; digest embedded in all four apps; boundary lint fails on a deliberate forbidden import; ≥12 §24.6 invariants mapped. **Adversarial review #0** of contracts and state machines by a fresh session, explicitly checking that no position behavior lives in the action cycle.

### M2 — Profile 0/1 foundation infrastructure (L)
Blueprint: P0, §35.2, §35.5, §5.3–5.9, §6, D65.
- Supabase migrations for every §6 table (schemas `core`, `market`, `intelligence`, `signals`, `agents`, `trading`, `risk`, `research`, `ops`, `audit`); RLS; generated types.
- Four durable `pgmq` queues (`trade-critical`, `reconciliation`, `trading-actions`, `research`); consumer with fixed risk-first drain order and bounded fairness; lease/visibility timeout; bounded backoff; dead-letter; idempotent handler harness; worker-death recovery test.
- Supabase Auth + roles (`viewer`/`operator`/`admin`); TOTP; production-stable WebAuthn step-up library selected.
- Realtime Broadcast event contracts from §20.23.
- Worker heartbeat/lease framework; mode/audit model; hash-chained `audit.events` with external checkpoint hook.
- Versioned config split into §26 trust classes.
- **Deployment profiles P0–P4 defined in configuration and CI** (profile manifests, per-service secret sources, which checks each profile requires). Profile 0/1 manifests runnable; Profile 3/4 manifests present as declarations; Terraform deferred to M11 (ADR-0002).
- Next.js 16 `web` skeleton on Vercel with Base UI + oklch tokens, auth, placeholder status bar. The Vercel deploy contains only `/apps/web`.
- Local Docker/process launch profiles for Profile 0/1A; GitHub Actions building GHCR images for the three services.
- OpenTelemetry + Sentry with correlation IDs; secret-redaction tests.

**Exit gate:** P0 acceptance (with ADR-0002 noted): mode changes audited; workers recover leases; Vercel has no worker/risk/executor entrypoint; Profile 0/1 manifests prove separate credentials per logical service; profile definitions exist in CI. Run-rate recorded.

### MP — Provider probes (S) — *Track A, start*
Blueprint: D47, D55, §15.7A, §16.5, §29, §45.1.
Small scripts against real providers whose answers can change design. Run from the isolated environment (ground rule 5) with the probe-only wallet. They do not block Track B.
- **Probe A (Turnkey + Jupiter lookup tables):** deny-export verified for both principals; real Jupiter v0 `/order` transactions for the route classes we will use, evaluated against the pinned Solana policy: legitimate routes sign; `ADDRESS_TABLE_LOOKUP` placeholder, transfer and program-key cases deny. Result in `docs/probes/turnkey-alt-policy.md`.
- **Probe B (Jupiter Trigger V2):** seeded per-order balance isolation for the exact mode/version, including a real vault deposit and two-step cancel/withdraw. Result in `docs/probes/trigger-lot-isolation.md`.
- **Probe C (signer contract):** Ed25519 signature compatibility, latency, timeout-retry determinism, audit-log presence.

**Exit gate:** all three results recorded; consequences captured as ADRs (signer fallback: Privy with correlated-provider risk accepted, or an isolated signer-policy gateway; protection default: Trigger where Probe B passed, else `MONITORED_EXIT`). MP closes before M3 contracts harden and before M7.

### M3 — Financial boundary skeletons (XL) — *Track A*
Blueprint: P6 (partial), §35.7–9, §13.7, §15, D21/D22/D27/D45/D47/D49/D52/D55.
- **`/libs/solana-hard-state`** — authoritative read-only chain inspection only: wallet/token balances, mint program ownership, mint and freeze authority, Token-2022 extensions, transfer-fee/hook state, top-N token accounts. No signer, keypair or send capability. M4 builds eligibility on it.
- `risk-authorizer`: isolated process; loads Release + attestation; verifies signed `RiskStateProjection`; allowlisted read-only RPC reads via `solana-hard-state`; emits signed envelope; deny-by-default egress.
- `execution-service`: envelope verification with pinned public key; deployment absolute caps; append-only `ExecutorExposureLedger`; local durable journal; `EMERGENCY_CLOSE` path with D22 constraints (Jupiter route only until M8b); authenticated internal API; out-of-band signed command endpoint; local pause.
- `TradingWalletSigner` interface; dev software signer; Turnkey adapter shaped by Probe A/C.
- `live` `ExecutionAdapter` over the shared Jupiter client: `/order` → validate `requestId`/mints/amount/expiry → structural checks → independent-RPC simulation → semantic balance-delta assertions → re-check chase/expiry → sign → persist `SIGNED_NOT_SUBMITTED` → `/execute` → staged reconciliation.
- Execution harness (§24.3): fake Jupiter/Solana covering every listed case including crash at every boundary.
- `traderctl` CLI skeleton (D25 plane 1) and `recoveryctl` runbook skeleton (plane 2).

**Exit gate:** P6 acceptance items needing no market data: cannot sign arbitrary tx; duplicate deliveries do not double-enter; DB tamper detected on envelope and projection; signed tx durably identifiable before submit; malicious tx fails simulation; DB-down emergency close reduces only. **Adversarial review #1** (security + trading-correctness sections of §32).

### M4 — Market data, chain truth and eligibility (L) — *Track B, working priority after M2*
Blueprint: P1, P2, §35.10–11, §3.1–3.3, §7, §25, D45, D34, D26, D63.
- Birdeye adapter behind the provider contract, REST first, WebSocket when the tier allows; discovery universe; OHLCV storage with partitioning, **retention jobs per §25**; `market.snapshots`; reconnect/backfill with `BACKFILL` tagging.
- Jupiter Price V3 secondary price adapter; freshness/health contracts per data class (§21.1) sized to purchased tiers.
- Eligibility/security system on `/libs/solana-hard-state`: analytics corroboration, mismatch blocking, hard rejects with reason codes, route/price-impact probes at standard sizes, emergency exit-route snapshot discovery and persistence (§6.2).
- Held-asset `position_safety_state` and the independent exit-compatibility check.
- Helius adapter: RPC, webhooks/WSS, tracked-wallet events, chain/custody reconciliation worker, unknown-movement pause.
- Owned-address registry and feature-level self-influence exclusion (D26).

**Exit gate:** P1 + P2 acceptance: live eligible/watch universe populates; live market streams and persisted bars/snapshots update continuously while the runtime session is active; stale feed blocks candidate progression; unsafe fixtures deterministically rejected; entry ineligibility never by itself disables the independent exit-compatibility path; retention jobs prune on schedule. No chart UI in M4. Run-rate recorded.

### M5a — First paper trade (M) — *Track B*
Blueprint: P3 (part), P7 (part), §8.1–8.3, §9.1, §12.1 (S0), §13.1–13.5, §17, D60–D63.
- Price/momentum, volume/flow and liquidity features with versioned `feature_snapshots`.
- One candidate trigger family (momentum continuation) with dedupe/cooldown/expiry.
- **Deterministic risk core** (§13.1–13.5): sizing, portfolio and trade-level rules, stop models, take-profit/trailing policies, kill conditions, versioned risk policy. Authority, signing and sleeves stay in M7.
- `S0_SAFE` with the deterministic second-look gate; `S0_RAW` recorded as the shadow counterfactual. **Every `S0_SAFE` decision is persisted as an action cycle with the deterministic gate recorded as the adversary**, so M7's cleared input and the Inspector's counterfactual have data.
- `paper` `ExecutionAdapter` over the shared Jupiter client: real quote at decision time, no signing, latency and path-specific MEV/adverse-execution allowance (§17.4).
- Position monitor with `MONITORED_EXIT` stop/target/trail/time policies; portfolio snapshots.
- Minimal runtime session: `STARTING` gates → `WATCH`/`ACTIVE` → `WIND_DOWN` → `OFF`; sticky `PAUSED`; attended presence heartbeat.
- Thin operational UI: status bar, Control Room basics (session widget, positions, alerts), Positions table, System Health.
- Start Level B data capture for replay (M10).

**Exit gate:** **First end-to-end PAPER trades from live market data using S0 only, in an attended Profile 1A session**, each visible as an action cycle in the ledger. `STARTING` warm-up test green: no candidate can be scored before every enabled indicator's lookback history exists (D63).

### M5b — Signal breadth and research features (M) — *Track B*
Blueprint: P3 (rest), §8.4–8.6, §9.2–9.7, §12.3, D26, D32, D62.
- Relative strength, regime classifier, deterministic taxonomy cohorts and rolling correlation clusters.
- Remaining candidate trigger families; explainable trigger records.
- **Candidate-side self-influence guard** (§8.6): our own fill cannot qualify a candidate; suppression/re-baselining window per token.
- Speed-tier contract; session/regime labels on every candidate (D62).

**Exit gate:** P3 acceptance complete including the self-influence guard; S0 paper continues across the full trigger set.

### M6 — Intelligence layer and autonomous agent layer (XL)
Blueprint: P4, P5, §35.13–14, §10, §11, §12.1 (S1–S4), D29–D32, D39, D40, D43, D64.
- LunarCrush + CryptoPanic adapters; event normalization; dedupe/clustering; source quality; source time vs `first_seen_at`; asset entity matching; catalyst age from source time.
- Model gateway (`ReasoningModel`), provider-pluggable, per-run cost/latency/version logging.
- Trading Skill v1: typed tool manifest (§11.4 only), point-in-time context builder, guidelines v1, `TradingActionProposal` schema enforcement, `agents.tool_invocations`.
- Automations: candidate, open-position, system triggers; spend/rate budgets → `BUDGET_PAUSED`.
- Action Adversary: independent run, `CONFIRM`/`CHALLENGE`/`REJECT`, one revision round, cutoff versioning, evidence-refresh semantics; unresolved open-position review terminates the cycle as `UNRESOLVED(reason)` and hands off to the position review state; non-blocking recording for mandatory exits.
- S1–S4 strategy versions bound to skill/guideline/automation versions; `EVENT_WINDOW` proposal → deterministic cap.
- Prompt-injection fixtures; hallucinated-ID rejection; forbidden-tool tests.

**Exit gate:** P4 + P5 acceptance. **Adversarial review #2** (AI-boundary section of §32). S1–S4 run in PAPER alongside S0 with separate virtual books. Run-rate recorded.

### M7 — Signed authorization, sleeves and full lifecycle (L) — *join point; depends on M3 + M5a*
Blueprint: P6 (rest), P7, §35.15–16, §13.6–13.7, §14, §15.3–15.6, D24, D38, D41, D44, D56.
Runs with `S0_SAFE` as the cleared input; M6 feeds it but does not gate it.
- Worker state projector emitting signed/sequenced `RiskStateProjection`.
- Strategy sleeves and position lots; lot-scoped exits; reconciliation of lots to physical + custody.
- Full intent path: cleared action cycle → risk evaluation → signed envelope → mode check → `LIVE_APPROVAL` approval bound to envelope hash with WebAuthn step-up and human-reaction floor → intent → executor.
- **Tiny-live `S0_SAFE` variant** declared per ADR-0004: speed tier and intent expiry above `human_reaction_floor_ms` so it can bind to a `LIVE_APPROVAL` Release.
- Releases + attestations; risk-authorizer verifies attested digest; live-arming preconditions (§15.9).
- Capital attestation ceiling and `CAPITAL_REATTEST_REQUIRED`.
- Staged `confirmed`/`finalized` accounting, `REORG_PENDING`, RPC divergence, chain-health tracking.
- Restart recovery (§21.3); manual close/reduce/pause; `EXPIRED_BY_LATENCY`/`CHASE_REJECT` recording.

**Exit gate:** P7 acceptance: same strategy code in paper and live with only the `ExecutionAdapter` differing; browser closure has no effect; live arming requires all four conditions; restart recovers open positions; the tiny-live variant binds to a `LIVE_APPROVAL` Release in test. Reconciliation suite (§24.4) green.

### M8a — Tiny-live prerequisites (L)
Blueprint: §16 (conditional), §15.10–15.10A, §20.3, §20.8, §20.20, §20.22, §20.28, §21.2, §21.2C, §24.8, D22, D25, D42, D50, D51, D53, D54, D61.
- **Minimum live operator surface** (pulled forward from M9): Approval Queue on desktop and mobile with expiry countdown; Release-bound arming/resume review with WebAuthn step-up; Live Readiness screen showing the tiny-live rows with `Run drill`; alert center with acknowledgement; mobile pause and emergency close (one position, all positions); **Wallet/Custody basics** — trading-wallet address for funding by address, SOL/USDC and risk-asset balances, recognized custody value against the attested ceiling, reconciliation state (§20.18, D56). Built on M5a's thin shell.
- **D50 artifact checks** (pulled forward from M11): forbidden-package scan on built images, runtime egress test per deployable, contract-digest match across all four deployables, wired into CI as a Live Readiness row. Full SBOM tooling stays in M11.
- Jupiter Trigger V2 adapter where Probe B passed: JWT challenge, vault registration, `TRIGGER_DEPOSIT`/`TRIGGER_CANCEL_WITHDRAW` validation, explicit `slSlippageBps`, order/fill reconciliation, lot-scoped mapping, **and the §29 Trigger lifecycle test**. Trigger vault movements reconcile as known custody. Provider protection is enabled for Profile 2 only if this row is green; otherwise **Profile 2 is `MONITORED_EXIT`-only**, stated explicitly in the readiness record.
- `PositionRiskShadow` journal in worker + executor; DB-down stop evaluation and emergency close; reconciliation import with operator review gate.
- `traderctl` complete (`PAUSE_NEW_ENTRIES`, `EMERGENCY_CLOSE_ASSET`, `EMERGENCY_CLOSE_ALL`); `recoveryctl` + Turnkey break-glass activation, executor-identity revocation, `SWEEP_TO_COLD_RECOVERY`, exercised on the probe wallet.
- Notifications: severity routing, mobile push + out-of-app channel, delivery persistence, escalation, dead-man `PAUSE_NEW_ENTRIES`, `SYSTEM_ALIVE` heartbeat.
- **Wallet reserve monitoring** (D35): gas SOL and settlement reserve thresholds, provider-vault and sleeve commitments, threshold alerts through the notification channels; no automatic funding.
- **Trading-wallet verification**: Probe C (signer contract) and the break-glass revoke/sweep drill re-run against the actual Profile 2 trading wallet, proving the configured public key, signer identity and recovery path for the wallet that will hold capital (§29, D36).
- `OFFLINE_PROTECTED` evaluation at `WIND_DOWN`; Vercel Cron `session-resume-watchdog`; `STARTING` honors the persisted pause.
- Signer health monitoring, `CRITICAL_SIGNER_UNAVAILABLE_WITH_EXPOSURE`, signer-outage unprotected-exposure cap, and a **signer-outage drill** (signer unreachable with an open position: entries blocked, alert raised, provider protection unaffected, cap enforced).

**Exit gate:** `READY_FOR_ATTENDED_TINY_LIVE` computable and green **for the `S0_SAFE` tiny-live variant**. Row set per ADR-0004 (required unless marked): risk-authorizer isolation and tamper tests; deny-export and pinned signer policy; persist-before-submit drill; approval binding and replay tests; tiny-live strategy variant bound to a `LIVE_APPROVAL` Release; wallet holds only tiny attested capital; reconciliation clean; `CRITICAL` out-of-app delivery and dead-man tested; out-of-band pause/close tested; break-glass revoke + sweep exercised on the probe wallet **and re-run on the trading wallet**; Probe C re-run on the trading wallet; signer-outage drill green; DB-down emergency close tested; wallet SOL/USDC reserve thresholds healthy; presence heartbeat; capital attestation; credentials in the isolated environment; artifact/egress/digest checks green; minimum live operator surface E2E green (approve, reject, arm, pause, mobile close, **Live Readiness FAIL blocks arming**); Trigger lifecycle test green **if** provider protection is enabled; Probe A passed for routes in use (**preferred**, not required for `LIVE_APPROVAL` per D55 scope); no open sev-1. **Adversarial review #3** (security + trading-correctness with emergency paths). Profile 2 may begin under `LIVE_APPROVAL` after this gate.

### M8b — `LIVE_AUTO` prerequisites (L) — *parallel with M9*
Blueprint: §14.6, §35.17–18, D33.
- Direct-pool emergency adapters (Raydium AMM v4/CPMM/CLMM, Orca Whirlpools, Meteora DLMM) behind one execution contract; periodic unsigned build+simulate dry-runs; stale dry-run blocks `LIVE_AUTO` entry for that asset; Jito-style landing option.
- Emergency-route snapshot consumption in the executor's `EMERGENCY_CLOSE` path.

**Exit gate:** remaining P6 acceptance: emergency adapter reduces risk when Jupiter is down; same-mint lot attribution preserved.

### M9 — Full product UI/UX (XL) — *parallel with M8b*
Blueprint: P8, §35.19, §20 entire.
Operational surfaces first; research surfaces after M10. Items already delivered in M5a/M8a are completed to full spec here rather than rebuilt.
1. Shell, global scope selector, persistent status bar with live treatment, `Shift+P` pause.
2. Control Room (full), Positions Workspace with review state, Agent Activity, Decision/Action Inspector with baseline counterfactual and cutoff visibility.
3. System Health (full), alert center (full), Audit Log with checkpoint verification.
4. Scanner, Watchlist, Asset Workspace (Lightweight Charts with attribution; Recharts for ops).
5. Approval Queue, arming review, Live Readiness (full verdict set), Releases with diff/promote/retire.
6. Risk & Policy; Wallet/Custody with the Solana Kit/Wallet Standard funding connector (`FUND_TRADING_WALLET` only, chain-reconciled `ops.wallet_funding_events`).
7. Autonomy workspace: Skill Console, Guidelines, Automations, Adversary Console.
8. *After M10:* Strategy Lab (`S0_RAW` vs `S0_SAFE` distinct), Trade History with export, Attribution/Economic P&L (three layers).
9. Settings/Operator Security; mobile operational surface (full); accessibility pass (§20.24).
10. Playwright E2E suite (§24.7).

**Exit gate:** P8 acceptance; §24.7 E2E green; wallet-connector negative tests (wrong cluster, destination substitution, injected instruction, fake success) pass.

### M10 — Replay and research framework (L)
Blueprint: P9, §35.20, §18, §19, §30.
- Replay clock; Level A/B/C fidelity kept distinct; look-ahead enforcement across proposer, adversary and every skill tool; cost model incl. path-specific MEV allowance; reproducibility record.
- Strategy comparison, proposer/adversary disagreement attribution, latency-cost attribution, confidence calibration bins, three-layer economic P&L, queries for the §30 research questions.

**Exit gate:** P9 acceptance: a replay test that reaches for future evidence fails; baseline and AI strategies run against the same timeline; results carry all version IDs. Unblocks M9 step 8.

### M11 — Adversarial hardening and Live Readiness closure (L)
Blueprint: P10, §35.21–22, §24.8, §29, §32, §33, §5.9.
- Every P10 drill automated where possible and exposed via Live Readiness `Run drill`.
- Full container/SBOM tooling and transitive forbidden-package policy; egress and digest checks already in CI since M8a extended to all profiles.
- Terraform for Profile 3/4 written here, applied only at promotion (ADR-0002).
- Invariant map: zero unmapped §24.6 invariants.
- Runbooks: complete-infrastructure-loss chain-first recovery, wallet reserve/manual funding, signer outage, executor compromise.
- **Adversarial review #4**, full §32 including compositional cases, by a fresh session or human. No unresolved critical/high finding.
- Live Readiness verdicts: `READY_FOR_ATTENDED_TINY_LIVE` (re-confirmed), `READY_FOR_UNATTENDED_LIVE_PILOT`, `READY_FOR_HARDENED_LIVE_AUTO`.

**Exit gate:** §33 Definition of Done checked with evidence links. Live path fully implemented; operating mode remains whatever the current profile permits.

### M12 — Profile promotion (operational, evidence-driven, not scheduled)
Blueprint: D65, §5.2, §29, §12.4.
- 1A attended PAPER → 1B unattended all-session PAPER (cheapest measured runtime; collects Asia/Europe/US/weekend data). **May begin after M5b once M7's restart recovery exists**; downtime risks research data only, so notifications and the resume watchdog are not prerequisites.
- Profile 2 tiny attended live may begin after M8a, `LIVE_APPROVAL` first, `MONITORED_EXIT`-only unless the Trigger row is green, credentials in the isolated environment, presence heartbeat, tiny attested ceiling.
- Profile 3 single fixed-price VM unattended pilot after M11; Profile 4 three-host topology only when capital justifies it.
Promotion evidence follows §12.4 and the §29 gate. No code deliverable beyond drill records.

---

## 5. Dependency graph and tracks

```text
M0 → M1 → M2 ─┬─► Track B (working priority): M4 → M5a ──► M5b → M6 ──┐
              │                                     │                 │
              └─► Track A (fills gaps):  MP → M3 ───┼─────────────────┤
                                                    ▼                 ▼
                                                   M7 (needs M3 + M5a; M6 feeds it)
                                                    ▼
                                                   M8a ──► Profile 2 tiny live (LIVE_APPROVAL)
                                                    ▼
                                    ┌───────────────┴───────────────┐
                                    M8b (LIVE_AUTO prereqs)    M9 steps 1–7, 9–10
                                    └───────────────┬───────────────┘
                                                   M10 → M9 step 8 → M11 → M12
```

- **Track B has working priority after M2.** The first thing to learn is whether the platform can consume market data, find candidates, paper-execute realistically and manage positions. M3 must not delay that checkpoint.
- **MP and M3 fill gaps** whenever Track B is blocked. MP closes before M3's contracts harden; M3 closes before M7.
- **M7 is the join point** and runs on `S0_SAFE`. M6 can land before, during or after it.
- **M8a is the gate to real money.** M8b and M9 are independent and run in parallel after it.
- **Level B capture starts in M5a** even though the replay engine lands in M10.

---

## 6. Critical path and early risks

| Risk | Where it bites | Mitigation |
| --- | --- | --- |
| Turnkey policy cannot safely constrain Jupiter v0 transactions with lookup tables (D55, §45.1) | `LIVE_AUTO` signer choice | Probe A in MP, off the critical path. Fallback ADR: Privy (correlated-provider risk accepted) or an isolated signer-policy gateway. Not a hard block for `LIVE_APPROVAL` (ADR-0004). |
| Trigger V2 does not prove per-order lot isolation | Provider protection | Probe B in MP; Profile 2 defaults to `MONITORED_EXIT` unless the M8a Trigger row is green. |
| `S0_SAFE` expiry below the human-reaction floor | Profile 2 cannot arm | Tiny-live variant declared in M7 per ADR-0004; binding tested in M7's gate. |
| Paper adapter diverges from the live execution contract | P7 acceptance | `ExecutionAdapter` contract and shared Jupiter client fixed in M1 (ADR-0003). |
| Risk-authorizer chain reads depend on eligibility code | M3/M4 parallelism | `/libs/solana-hard-state` in M3; M4 consumes it. |
| Position behavior leaks into `agents.action_cycles` | Domain integrity | Separate machines in M1 (ADR-0001); review #0 checks it explicitly. |
| Provider plan limits smaller than assumed | Universe size, freshness | REST-first Birdeye; §21.1 contracts sized to purchased tier; tier shown read-only in Settings. |
| Pinned versions drift (Next.js 16, `@solana/kit`, Base UI, Nx) | M1/M2 setup | Verify current docs at M1 start; pin exact versions; record in an ADR. |
| A session "improves" a §31 decision or rewrites a future gate | Anywhere | GUARDRAILS.md canonical and `@`-imported; ground rule 8; ADR required. |
| Live or probe credentials reach an agent-readable environment | MP, Profile 2 | Isolated environment for probes and live; software signer everywhere else; secret-redaction tests from M2. |
| Real trading deferred until everything is built | Learning speed | M8a defines `READY_FOR_ATTENDED_TINY_LIVE` including the minimum operator surface; Profile 2 opens before M9–M11. |

---

## 7. Session playbook for implementation agents

**Start of session**
1. `GUARDRAILS.md` is loaded via `CLAUDE.md`/`AGENTS.md`; read this plan's current milestone and the blueprint sections listed for it.
2. Pick one work package. State it in a sentence. Check its dependencies are ticked below.

**During**
- Contracts first, then implementation, then tests, then invariant-map entries.
- Any temptation to change a §31 item or a future milestone → stop, write the ADR, surface it.
- Provider integrations get recorded fixtures and a schema-drift test that fails on unexpected zeros/nulls (§24.2).
- Position review behavior belongs to `trading.positions`; action-cycle behavior belongs to `agents.action_cycles`. Do not merge them (ADR-0001).
- Both `ExecutionAdapter` implementations use the shared Jupiter client; never add a second quote path (ADR-0003).

**End of session**
- `nx affected -t lint,test` green; digest regenerated if contracts changed.
- Tick the checkbox in §8; add a one-line entry to `docs/CHANGELOG.md`; update `docs/costs.md` if a provider or tier changed.
- If a gate milestone closed, open a **fresh session** with the §32 checklist and the diff, and record findings in `docs/reviews/`.
- Do not edit the scope or gate of any unticked milestone.

---

## 8. Milestone checklist

- [x] **M0** Repo bootstrap: git, docs layout, GUARDRAILS.md + `@`-import in CLAUDE.md, AGENTS.md, ADR template, **ADR-0001…0004**, invariant IDs enumerated — done 2026-09-05; evidence: `docs/CHANGELOG.md`, `node tools/check-invariant-map.mjs` OK, `.github/workflows/guardrails.yml`
- [x] **M1** Nx workspace, tags + boundaries, `/libs/contracts` complete, `ExecutionAdapter` + shared Jupiter client (contract in M1; implementation deferred to M3/M5a per review #0 #12), digest harness, `Clock`, separated state machines with `UNRESOLVED(reason)` + property tests, signing primitives, **adversarial review #0** — done 2026-09-05 at `26c7820`; evidence: `docs/reviews/review-00-m1-contracts-state-machines.md` (Gate PASS), `node tools/check-invariant-map.mjs` 12/28 mapped, `nx run-many -t lint typecheck test build` 20 projects / 89 tests green, CI workflows green
- [x] **M2** Supabase migrations + RLS, four `pgmq` queues, Auth/roles/TOTP/WebAuthn lib, Broadcast contracts, heartbeat/lease, hash-chained audit, config trust classes, **deployment profiles in config + CI**, web skeleton on Vercel, Docker profiles, GH Actions/GHCR, OTel/Sentry — done 2026-09-06 at `7c7ac10` (packages f6cb662 → 7c7ac10); evidence: 12 migrations + 6 pgTAP suites / 64 tests green from `supabase db reset`; exit gate: mode changes audited (`libs/db/src/server/audit.integration.spec.ts`), workers recover leases (`libs/db/src/server/queue-processing.integration.spec.ts`, CI `database` job), Vercel deploy is `apps/web` only (`apps/web/vercel.json`; the three services ship as GHCR images from `.github/workflows/images.yml`, run 34063365545 green, every image reports the locked digest), Profile 0/1 manifests prove separate credentials per logical service (`config/profiles/*.json` + `checkManifest` tests, `deploy/profile-0/` one env file per service), profile definitions and D50 artifact checks run in CI (`ci.yml`), run-rate recorded in `docs/costs.md` (0/month); ADR-0002 (Terraform deferral) and ADR-0006 (step-up stack) noted; 20 projects `lint typecheck test build` green; hosted Supabase carries all 11 migrations (applied by the operator via SQL editor, 2026-09-06) with email sign-up disabled
- [ ] **MP** Probe A (Turnkey + lookup tables), Probe B (Trigger deposit/isolation/withdraw), Probe C (signer contract) recorded; ADRs written
- [ ] **M3** `/libs/solana-hard-state`, risk-authorizer, execution-service, `TradingWalletSigner` + Turnkey adapter, live `ExecutionAdapter` with persist-before-submit, execution harness, `traderctl`/`recoveryctl` skeletons, **adversarial review #1**
- [ ] **M4** Birdeye (REST → WS), OHLCV/snapshots + **retention jobs**, Price V3, eligibility on `solana-hard-state`, route probes + emergency route snapshots, held-asset safety, Helius reconciliation + tracked wallets, owned-address registry
- [ ] **M5a** Core features, one trigger family, risk core (§13.1–13.5), `S0_SAFE`/`S0_RAW` **persisted as action cycles**, paper `ExecutionAdapter`, position monitor, minimal session lifecycle + **`STARTING` warm-up test**, thin operational UI, Level B capture, **first PAPER trades**
- [ ] **M5b** Relative strength, regime, cohorts/clusters, remaining trigger families, **candidate self-influence guard**, speed tiers, session labels
- [ ] **M6** LunarCrush/CryptoPanic, normalization/dedupe/source time, model gateway, Trading Skill + tools + guidelines + automations, Action Adversary + cutoffs + `UNRESOLVED` handoff, spend budgets, S1–S4, injection tests, **adversarial review #2**
- [ ] **M7** State projector, sleeves/lots, signed envelope path on `S0_SAFE`, approvals + step-up, **tiny-live variant above reaction floor**, Releases + attestation, capital attestation, staged finality/REORG, restart recovery, manual actions
- [ ] **M8a** **Minimum live operator surface incl. Wallet/Custody basics**, **artifact/egress/digest checks in CI**, Trigger V2 + lifecycle test (conditional), position shadow + DB-down close, `traderctl` complete, break-glass + cold sweep exercised **and re-run on the trading wallet with Probe C**, notifications/escalation/dead-man, **wallet reserve monitoring**, `OFFLINE_PROTECTED` + resume watchdog, signer health + **signer-outage drill**, **adversarial review #3**, `READY_FOR_ATTENDED_TINY_LIVE` green for `S0_SAFE`
- [ ] **M8b** Direct-pool emergency adapters + dry-runs, executor emergency-route consumption *(parallel with M9)*
- [ ] **M9** §20 UI steps 1–7 and 9–10; step 8 after M10; wallet connector; mobile (full); accessibility; Playwright E2E *(parallel with M8b)*
- [ ] **M10** Replay clock, fidelity levels, look-ahead enforcement, cost model, attribution, calibration, economic P&L, §30 queries
- [ ] **M11** Drills automated, full SBOM tooling, Terraform written, invariant map complete, runbooks, **adversarial review #4**, Live Readiness verdicts, §33 DoD evidence
- [ ] **M12** Profile promotions recorded with evidence (1A → 1B after M5b + M7 restart recovery → 2 after M8a → 3 after M11 → 4 when justified)
