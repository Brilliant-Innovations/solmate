# Implementation Guardrails (canonical)

This file is the single source of law for every implementing session, whichever model runs it. `CLAUDE.md` imports it; `AGENTS.md` points to it. Do not copy its content elsewhere.

Sources:

- Blueprint: `docs/blueprint/Solana_Autonomous_Trader_Blueprint_v1.10.md` (§31 and §32 reproduced verbatim below; heading levels demoted by one so this file has one title).
- Execution plan: `docs/implementation/Execution_Plan_v4.md` (§2 ground rules reproduced below).
- Deviations from blueprint text: `docs/decisions/ADR-0001` to `ADR-0004`. Anything not covered by an ADR follows the blueprint.

---

## Part 1 — Ground rules for every work session (Execution Plan v4 §2)

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

## Part 2 — Blueprint §31, verbatim

## 31. Implementation Guardrails for Claude/Kimi/Other Reviewers

Reviewers are encouraged to challenge architecture, missing failure modes, security weaknesses, data leakage and research validity.

However, distinguish clearly between:

- **DEFECT** — implementation would violate a stated invariant or cannot work as described;
- **MISSING REQUIREMENT** — blueprint omits something required to achieve its stated goal;
- **TRADE-OFF / DECISION** — multiple valid designs exist and the blueprint made one choice;
- **ENHANCEMENT** — useful but not necessary for the stated v1 system.

Do not silently “improve” these blueprint decisions during implementation:

- spot-only v1;
- agent has no signing/general wallet tool;
- risk sizing deterministic;
- live capability present but disabled by default;
- baseline strategy required;
- point-in-time first-seen enforcement;
- immutable strategy versions;
- one execution boundary;
- wallet/chain reconciliation is authoritative;
- critical stale data fails closed for entries;
- no self-modifying live strategies;
- database rows alone are not execution authority;
- risk cohorts are deterministic/versioned, not LLM-controlled;
- one physical live wallet uses explicit strategy sleeves/lots;
- own-wallet/vault activity cannot become trading evidence;
- normal live entries require durable pre-submit identity;
- DB-down execution is risk-reducing emergency close only;
- operator UX/interfaces in Section 20 are required product behavior, not optional polish;
- autonomous trading uses a versioned Trading Skill distinct from strategy, guidelines and automations;
- every discretionary autonomous exposure action, including open-position HOLD, receives adversarial review;
- mandatory risk-reduction actions cannot be blocked or delayed by an LLM;
- LIVE_AUTO requires a provider-independent emergency-exit capability;
- held-asset safety/executability is continuously revalidated;
- trading-wallet replenishment is manual; automated monitoring/alerts only;
- economic P&L includes direct strategy and shared platform operating costs;
- risk-authorizer is isolated from the general worker/LLM runtime;
- live configuration is immutable Release-bound and step-up attested;
- unresolved open-position adversarial review enters `PROTECTION_ONLY`;
- evidence refresh creates a new shared proposer/adversary cutoff;
- provider protection is lot-scoped;
- human risk-increasing controls require step-up while pause/close remain fast;
- critical alerts have out-of-app delivery/escalation/dead-man pause;
- discretionary autonomy obeys model/data spend circuit breakers;
- hard token protocol-state security fields are verified from chain truth;
- browser wallet connection never becomes trading/approval/auth authority and autonomous runtime does not depend on it;
- production live signer key remains non-exportable and is never regressed to a raw executor secret;
- canonical inter-service contracts come only from `/libs/contracts` and contract-digest mismatch fails readiness;
- `confirmed` operational exposure cannot be mistaken for `finalized` accounting state.

Any proposed change to those should be surfaced as a decision before implementation.

---

## Part 3 — Blueprint §32 Adversarial Review Checklist, verbatim

Used at every adversarial review gate (#0 at M1, #1 at M3, #2 at M6, #3 at M8a, #4 at M11). The reviewer is a different model session or a human, never the authoring session. Findings go in `docs/reviews/`.

## 32. Adversarial Review Checklist

Before implementation is declared complete, specifically attempt to break the system by asking:

### Trading correctness

- Can one candidate create two live entries after a timeout/retry?
- Can a transaction land even though the API response says failure?
- Can the process die after signing/before submit or after submit/before response and still reconcile without duplicate entry?
- Can a price move make a formerly safe trade unsafe between analysis and signing?
- Can we sell the token under realistic current liquidity?
- What happens if a token becomes untradeable while held?
- What happens if an external protective order fills while our process is offline?
- Can a provider fill for one strategy lot accidentally reduce another strategy's same-mint lot?
- Can the system close through a direct pool when Jupiter is unavailable without discovering liquidity from scratch?
- Can Trigger vault deposit/withdraw movements be distinguished from unexplained custody movement?
- Can an explicit stop slippage cap fail safely during a gap rather than silently inheriting provider default?

### Data correctness

- Can a stale WebSocket connection continue to look healthy?
- Can provider zeros/nulls be mistaken for real market values?
- Can duplicate news inflate confidence?
- Can our own wallet/vault transaction inflate momentum, flow or smart-money evidence for another strategy?
- Can historical replay use a wallet label learned in the future?
- Can revised metadata overwrite what the strategy knew at the time?

### AI boundary

- Can any discretionary autonomous action reach risk authorization without a cleared adversarial action cycle?
- Can a `HOLD` decision keep exposure open without adversarial scrutiny?
- Can the adversary create or upgrade a proposal on its own?
- Can proposer/adversary disagreement loop indefinitely?
- Can a model outage prevent a hard stop/emergency exit?
- Can the Trading Skill call an unregistered HTTP/SQL/shell/wallet tool?
- Can the agent alter its own skill, guidelines or automations live?
- Can source text cause the agent to alter settings or execution behavior?
- Can hallucinated evidence IDs pass validation?
- Can the model nominate an asset that was not the candidate?
- Can model confidence affect position size outside deterministic policy?
- Can a model/provider outage leave an open position unmanaged rather than in deterministic `PROTECTION_ONLY`?
- Can an evidence refresh let proposer and adversary reason over different cutoffs?
- Can a speed tier skip its adversarial control to make latency budget?
- Can spend-budget exhaustion disable a mandatory hard exit?

### UX / operator correctness

- Can the operator mistake PAPER for LIVE_AUTO anywhere in the app?
- Can stale or missing market/risk data appear as a valid zero?
- Can an operator understand why the agent is holding a losing position?
- Can the agent be live while its emergency-exit adapter is unhealthy?
- Can a critical alert disappear as a toast without acknowledgement?
- Can mobile pause/close still function when non-critical panels fail?

### Security

- Can browser code call executor directly?
- Can a connected Wallet Standard wallet ever become or impersonate the executor trading signer?
- Can funding UI/provider compromise substitute a destination, mint, cluster or unrelated instruction without the typed funding guard rejecting it?
- Can a wallet-reported "success" change authoritative funding state before chain reconciliation?
- Can a stolen web session arm live mode alone?
- Can database tampering increase an intent amount or loosen any execution field after risk authorization?
- Can database tampering forge strategy sleeve/cohort capacity or a newer `RiskStateProjection` without the projector key?
- Can a valid-but-stale signed projection be replayed after wallet/custody state changes?
- Can the risk-authorizer sign an entry when its independent D45/wallet chain reads disagree with the signed projection?
- Can a stale/replayed approval authorize a different authorization hash?
- Can the executor be tricked into signing a transaction whose simulated wallet/custody deltas differ from the approved action?
- Can an unexpected signer, authority change, token debit or SOL debit pass validation?
- Can DB/web outage prevent the out-of-band kill or emergency-close path?
- Can secret material appear in logs/errors/traces?
- Can a compromised executor host extract the production trading-wallet private key, or only request signatures through the constrained signer identity?
- Can a compromised executor bypass the signer-side transaction policy and get arbitrary bytes/programs/recipients signed?
- Can a Turnkey/Jupiter versioned transaction hide a policy-relevant account behind `ADDRESS_TABLE_LOOKUP`, or cause legitimate routes to fail in a way that tempts an implementer to weaken the policy?
- Can either the autonomous or break-glass Turnkey principal export the production trading key?
- What happens to every open `MONITORED_EXIT` position when the production signer is unavailable?
- Can the executor's signing permission be revoked out-of-band while the executor and Postgres are unavailable?
- Can break-glass signing be activated outside a declared incident or target an arbitrary recovery address?
- Can a raw/local dev signer accidentally satisfy mainnet Live Readiness?
- Can post-arm funding or appreciation raise the wallet/custody blast radius above the attested capital ceiling without blocking new entries?
- Can an LLM/provider dependency, wallet/signing primitive or arbitrary public egress appear inside the built `risk-authorizer` artifact despite source-level rules, while still permitting the narrow read-only Solana RPC path D52 requires?
- Can an `OFFLINE_PROTECTED` resume deadline pass while the runtime is `OFF` without the external watchdog escalating and persisting entry pause?

### Research validity

- Does the baseline get the same candidate opportunity set?
- Are fees and slippage charged consistently?
- Are rejected trades included when evaluating filter value?
- Is survivor bias entering the token universe?
- Is parameter selection overfitting one regime?
- Are paper fills unrealistically optimistic?
- Does paper/replay model execution-path-specific MEV/adverse-execution while live attribution avoids falsely labeling every shortfall as MEV?
- Can a provider outage during adversarial review leave a position in `PROTECTION_ONLY` without active deterministic/provider protection?
- Can a `confirmed` transaction disappear before `finalized` and cause a duplicate replacement trade?
- Can independent RPC disagreement be mistaken for authoritative chain truth?
- Can two deployables with different contract digests both become live?

---

## Part 4 — Trust tags and module boundaries

Source-level enforcement of D58 and §24.8. Implemented in M1 with Nx project tags and `@nx/enforce-module-boundaries` `depConstraints`; verified again against built artifacts from M8a (§24.8).

### Tags

Every project carries exactly one `type:` tag, one `trust:` tag and one `scope:` tag.

| Tag | Meaning |
| --- | --- |
| `type:app` / `type:lib` | Deployable or library |
| `trust:web` | Browser-facing; anon Supabase key only; never service-role, signer or risk keys |
| `trust:worker` | General runtime; ingests untrusted provider text and runs LLM calls; never holds signer credentials or the risk-authorization private key |
| `trust:risk-authorizer` | Isolated policy process; no LLM, no provider-text ingestion, no wallet/signing capability; read-only Solana RPC permitted |
| `trust:execution-service` | Isolated transaction authority; no LLM, news or social SDKs |
| `trust:shared` | Pure, dependency-light code importable by any trust level (`contracts`, `observability`, `testing`, `replay` clock) |
| `trust:web-only` | Browser wallet code (`wallet-ui`); importable by `web` only |
| `scope:<domain>` | One per lib: `contracts`, `db`, `market`, `onchain`, `solana-hard-state`, `intelligence`, `signals`, `strategies`, `agents`, `skills`, `risk`, `execution`, `wallet-ui`, `replay`, `observability`, `testing` |

### Dependency constraints

| Project | May depend on | Must never import |
| --- | --- | --- |
| `apps/risk-authorizer` | `contracts`, `risk`, `solana-hard-state`, `db` (read paths), `observability`, `replay` (clock) | `agents`, `skills`, `intelligence`, `market`, `signals`, `strategies`, `execution`, `wallet-ui`; any LLM SDK; any wallet, keypair or `sendTransaction` capability; any DEX SDK; any browser code; generic provider/news clients |
| `apps/execution-service` | `contracts`, `execution`, `solana-hard-state`, `db`, `observability`, `replay` (clock) | `agents`, `skills`, `intelligence`, `wallet-ui`, `strategies`, `signals`; any LLM, news or social SDK; the risk-authorization private key module |
| `apps/worker` | every lib except `wallet-ui` | production signer SDK/credential path; risk-authorization private key module |
| `apps/web` | `contracts`, `wallet-ui`, `db` (anon/RLS client), `observability` | `execution`, `risk` signing modules, `agents`/`skills` runtime, service-role credentials, signer or risk keys |
| `libs/wallet-ui` | `contracts` | anything server-side; importable only by `apps/web` |
| `libs/contracts` | nothing internal | any other lib |
| `libs/solana-hard-state` | `contracts`, `observability` | any signer, keypair, wallet or `sendTransaction` API |

### External package bans by trust level

- `trust:risk-authorizer`: `@anthropic-ai/*`, `openai`, `@google/generative-ai`, `@jup-ag/*`, `@raydium-io/*`, `@orca-so/*`, `@meteora-ag/*`, `@turnkey/*`, `@privy-io/*`, `@solana/kit-plugin-wallet`, `@solana/react`, `react`, `next`.
- `trust:execution-service`: `@anthropic-ai/*`, `openai`, `@google/generative-ai`, `@solana/kit-plugin-wallet`, `@solana/react`, `react`, `next`, any news/social SDK.
- `trust:worker`: `@turnkey/*`, `@privy-io/*` (signer credential path lives only in `execution-service`).
- `trust:web`: `@turnkey/*`, `@privy-io/*`, `@jup-ag/*`, direct-DEX SDKs, any module that reads the service-role key.

The exact package list is versioned in `nx.json`/ESLint config from M1 and in the artifact scan from M8a. Adding a package to a financial deployable is a reviewed change, not a convenience.

### Credentials

- Production signer credential: `execution-service` only, and only in Profile 2+ inside the isolated environment. Never in this workspace.
- Risk-authorization private key: `risk-authorizer` only. The executor holds the public key.
- Projection signing key: worker state-projector role only.
- Emergency-command private key: operator tooling only; worker and executor hold the public key.
- Break-glass credential: outside every application deployable.
- No live credential, including probe credentials, in any `.env`, shell history or file readable from a coding-agent workspace (D65).
