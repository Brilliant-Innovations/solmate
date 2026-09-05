# Solana Autonomous Trader — Blueprint v1.10

**Status:** Proposed implementation blueprint  
**Date:** 2026-09-05  
**Working name:** `sol-agent-trader`  
**Primary objective:** Build a production-grade Solana ecosystem trading application that can discover opportunities, analyze market/on-chain/news/social context, paper trade, and execute real spot trades autonomously through a strictly controlled execution boundary. The finished platform supports unattended autonomous operation, but runtime availability and physical hosting are deliberately maturity-, session-, catalyst-, and exposure-dependent rather than requiring 24/7 hardened infrastructure before the strategy is proven.

---

# 0. Executive Summary

This is not a chatbot connected to a wallet and it is not a technical-analysis script with an LLM bolted onto it.

The system is a live trading platform with five distinct layers:

1. **Observation** — ingest Solana market, liquidity, on-chain, wallet, social, and news data whenever the trading/research runtime is active; unattended PAPER may later run continuously to collect unbiased all-session research data.
2. **Detection** — deterministic scanners identify unusual or potentially tradeable conditions.
3. **Reasoning** — one or more AI analysts investigate why a candidate is moving, whether the move is likely to continue, and what would invalidate the thesis.
4. **Risk and execution** — deterministic policy independently decides whether the proposal is allowed, calculates position size, and executes through a dedicated signer/execution service.
5. **Measurement** — every observation, signal, decision, quote, trade, fill, and outcome is recorded so the system can prove whether the AI adds value.

The application is **live-trading capable from the first complete release**. Live execution is not a later architectural retrofit. However, the system defaults to `OBSERVE` or `PAPER` mode, and live execution requires deliberate arming.

The first supported market is **Solana spot tokens** routed through Jupiter. BTC/ETH and centralized-exchange trading are not part of the initial strategy universe. Perpetuals are deliberately excluded from v1 because leverage, liquidation, funding, collateral, and cross-margin semantics constitute a separate risk system rather than an incremental feature.

The central design principles are:

> **The autonomous trading agent may initiate and manage trades, but it may never authorize its own risk.**

> **Every discretionary autonomous action is challenged by an independent adversarial pass before deterministic policy can authorize it.**

The system therefore includes a first-class, versioned **Trading Skill** rather than relying on a prompt plus a few automation rules. The skill defines the agent's permitted trading workflows, tools, action contracts, evidence requirements, position-management behavior, and handoff into the adversarial and deterministic authorization layers. Guidelines constrain how the skill should reason; automations determine when it is invoked. Neither substitutes for the skill itself.

The LLM never holds a private key, never signs a transaction, never chooses an arbitrary destination, never bypasses token eligibility, and never directly controls position size. The executor accepts only typed trade intents that have passed the mandatory adversarial action loop and deterministic policy. Hard stops and emergency risk-reduction actions are never delayable or vetoable by an LLM.

---

# 1. Product Definition

## 1.1 What we are building

An authenticated web application with a session-capable financial runtime that can operate attended or unattended according to deployment maturity and exposure state, and that:

- monitors a dynamic universe of Solana ecosystem tokens;
- discovers unusual price, volume, liquidity, wallet, holder, social, and news activity;
- rejects unsafe/untradeable tokens before AI analysis;
- computes technical and market-structure signals deterministically;
- enriches interesting candidates with on-chain, social, and news context;
- invokes an AI analyst only when a candidate warrants reasoning;
- invokes a mandatory independent adversarial reviewer for every discretionary autonomous action before it can advance;
- equips the autonomous agent with a versioned Trading Skill capable of proposing entries, position holds/reassessments, reductions, discretionary exits, and allowed protection changes;
- creates a structured trade action proposal or explicit no-trade decision;
- runs the proposal through deterministic portfolio and risk policy;
- supports observation, paper trading, approval-required live trading, and fully autonomous live trading;
- executes Solana swaps through Jupiter;
- optionally uses Jupiter protective trigger orders where the custody/operational trade-off is accepted;
- continuously reconciles positions against on-chain reality;
- records every decision and outcome;
- compares multiple strategies against a non-AI baseline;
- supports point-in-time replay and backtesting without look-ahead leakage;
- exposes a complete operator/research UI with system health, agent activity, approval queues, strategy/skill/automation configuration, audit drill-down, and global emergency controls.
- provides a browser-side Solana Wallet Standard connector for an operator-controlled external funding wallet, with explicit user-signed manual funding into the dedicated trading wallet; the connected browser wallet never becomes the autonomous trading signer or an operator-auth authority.

## 1.2 What success means

The project is successful even if the AI ultimately fails to produce alpha, provided the system can answer that question rigorously.

A successful system must be able to tell us:

- whether trades proposed by the AI outperform deterministic baselines after fees/slippage;
- which signal families predict continuation and which are noise;
- whether AI confidence is calibrated against actual outcomes;
- which strategies perform in which market regimes;
- whether news/social/on-chain enrichment improves expectancy beyond pure momentum;
- where profits and losses are coming from;
- how much performance degrades when realistic latency, price impact, failed transactions, and trading costs are applied.

## 1.3 Non-goals for v1

- High-frequency or sub-second market making.
- Arbitrage requiring colocated infrastructure.
- Leveraged perpetual/futures trading.
- Copy trading without independent analysis.
- Blind trading of every newly created Pump.fun token.
- Allowing an LLM to construct/sign arbitrary Solana transactions.
- A public multi-tenant SaaS product.
- Claims of guaranteed returns or autonomous “money printing.”

---

# 2. Architectural Decisions

These are blueprint-level decisions. An implementation agent should not silently replace them with a different product behavior.

## D1 — Solana spot only for v1

The initial execution domain is Solana ecosystem spot assets. SOL and USDC are settlement/reference assets. Other Solana tokens are candidates.

**Reason:** The intended experiment depends on faster, more volatile ecosystem moves. Perpetuals introduce an entirely different risk domain.

## D2 — Live capability is implemented, but capital authority is disabled by default

The complete application contains the live execution path from day one. **Capital authority** is one axis:

- `OBSERVE`
- `PAPER`
- `LIVE_APPROVAL`
- `LIVE_AUTO`

`LIVE_APPROVAL` means the full deterministic pipeline completes but a human approves the exact authorized exposure-increasing intent envelope before execution. `LIVE_AUTO` removes that final human approval, not the deterministic authorization boundary.

Runtime/activity state is a separate axis under D60. `PAUSED` is a sticky operator safety override, not a capital-authority mode; schedule/window automation may not clear it without explicit operator re-arm.

## D3 — AI never owns hard policy

AI can determine:

- thesis;
- catalyst interpretation;
- narrative quality;
- expected horizon;
- evidence for and against continuation;
- confidence;
- invalidation logic;
- whether the opportunity should be ignored.

AI cannot determine or override:

- maximum portfolio exposure;
- maximum trade risk;
- token safety eligibility;
- hard liquidity thresholds;
- maximum slippage;
- daily drawdown stops;
- account kill switches;
- active risk cohorts/correlation limits;
- whether an arbitrary mint or recipient is allowed;
- signing or transaction submission permissions.

Position size is computed by deterministic risk code.

## D4 — The agent never receives a general-purpose wallet tool

The AI outputs a typed `TradeProposal` referencing a server-created `candidate_id`. It does not submit mint addresses, wallet destinations, or raw transactions to the signer.

The execution service resolves the candidate to an already-approved asset and builds the Jupiter request itself.

## D5 — Deterministic scanners run continuously while the runtime is active; LLMs are event-driven

We do not call a model for every tick/token. While a research/trading session is active, cheap deterministic code continuously computes features and candidate scores. Optional unattended PAPER may run this continuously across global sessions. LLM analysis is invoked only when thresholds or event conditions are met.

## D6 — Every strategy competes against a non-AI baseline

At minimum, the system runs:

- Momentum baseline — deterministic only.
- Momentum + context agent.
- Catalyst agent.
- Smart-money/on-chain agent.
- Hybrid ensemble.

All receive the same point-in-time inputs and use separate virtual books in paper/replay modes.

## D7 — Strategy and prompt versions are immutable

A changed prompt, weight, threshold, model, or risk rule creates a new strategy version. Historical results remain attributed to the exact version used.

There is no silent “improvement” of a strategy in place.

## D8 — Point-in-time truth is mandatory

Every external observation carries both source/event time where available and `first_seen_at` in our system.

Replay may only expose information where:

`first_seen_at <= simulated_decision_time`.

This rule applies especially to news, social content, holder data, labels, security assessments, and project metadata.

## D9 — Chain/custody truth outranks internal state

The database is an operational ledger, but actual Solana balances, registered provider-vault balances, provider order state and transaction status are authoritative. The reconciliation worker continuously compares them.

Unknown balance movement, unexpected token accounts, unregistered custody locations, or irreconcilable transaction state triggers a trading pause. A movement is not “unknown” when it is tied to a previously authorized execution/protective-order lifecycle and a registered custody account.

## D10 — One normal autonomous signing boundary

`execution-service` is the only **application trading process** allowed to originate a normal autonomous signing request. The production private key itself remains non-exportable inside the configured signing backend/HSM/server-wallet boundary; it is never mounted as raw key material into the executor. No Next.js route, scanner, agent worker, scheduled task, database function, risk service or LLM may originate a wallet-signing request.

The validated request may pass through D55's independent signer-policy layer/gateway before the backend actually signs. If a future byte-only signing backend is ever approved, the policy gateway — not the executor — must hold its signing permission. Native-policy signer providers enforce the equivalent second-layer policy internally. Neither layer constructs routes or makes trading decisions.

This normal boundary covers Swap V2 transactions, Trigger V2 deposits/cancellation withdrawals/JWT challenge signing, and direct-pool emergency exits. D53 is the only exception: an incident-only break-glass principal exists outside the application and cannot be used for routine autonomous trading.

## D11 — New entries fail closed when critical data is stale

If market data, wallet state, token security state, quote data, or system time freshness exceeds configured limits, no new entry can be placed.

Exit attempts are treated differently: the system makes a best effort to reduce/close risk during partial provider or database degradation using the narrow emergency-exit authority defined in D22.

## D12 — Exact-once intent semantics

Network calls are not exactly once, but trade intent creation must be idempotent.

Every actionable intent receives a stable idempotency key. Repeated worker delivery must not create duplicate entries.

## D13 — Protective exit architecture is pluggable

Two implementations are supported:

1. `MONITORED_EXIT`: our worker monitors stop/target/trailing conditions and executes an exit swap.
2. `JUPITER_TRIGGER`: a provider-side trigger/OCO order protects the position independently of our worker.

The second option has a custody/provider trade-off and therefore is explicitly configured per strategy/account rather than hidden.

## D14 — No newly discovered token is immediately trusted

Discovery and eligibility are separate states. A token can be interesting without being tradeable.

## D15 — No strategy may change its own code or policy live

Agents can propose research observations. They cannot modify thresholds, prompts, scoring formulas, allowlists, risk cohorts, or risk policy in production.

Strategy optimization is a controlled human/research workflow that creates a new version.

## D16 — The dashboard is not the trading runtime

Closing the browser must have no effect on ingestion, monitoring, stops, reconciliation, or execution.

## D17 — Fees, slippage, transfer fees, price impact, failed execution and latency are first-class performance inputs

Gross theoretical returns are never treated as trading performance. Token-2022 transfer fees or hooks, where supported, are included in executable sizing and actual fill/P&L accounting.

## D18 — Data-source adapters are replaceable

The initial provider choices are practical defaults, not business logic. Provider-specific schemas terminate at adapter boundaries.

## D19 — No trade solely because an influencer/social account mentioned a token

Social activity is evidence, not authorization. The system looks for corroboration with market structure, liquidity, on-chain behavior, or a real catalyst.

## D20 — Human emergency control works from mobile

The app is desktop-first for research, but pause/kill, open positions, account exposure, and emergency close controls must be usable on a phone.

## D21 — Database rows are not execution authority

The deterministic risk-authorizer is an isolated OS process/container with no LLM runtime, provider-text ingestion, browser surface or wallet key. It signs a canonical `RiskAuthorizedIntentEnvelope` with an asymmetric signing key unavailable to the browser, database, general worker and executor. The executor verifies that signature before any normal live signing operation.

An already-authorized action is bound to the exact asset, side, maximum amount, strategy/sleeve, stop/protection policy, slippage/chase limits, expiry, policy/Release identifiers and nonce. Database mutation after authorization cannot widen or substitute that action.

Live policy is also bound to an immutable `Release` (D38). A database row cannot silently substitute a different live strategy/risk/skill/model bundle merely by changing an `active` pointer.

The **inputs** to authorization are also tamper-evident. Current portfolio, exposure, eligibility, freshness and cohort-capacity projections consumed by the risk-authorizer are emitted as signed, sequenced `RiskStateProjection` records by the trusted worker state projector. The risk-authorizer verifies projection signature, sequence, source digest, chain slot/as-of time and freshness before using them; a database-only attacker cannot mint or widen a valid projection by editing rows.

For every exposure-increasing authorization, the risk-authorizer additionally performs independent allowlisted Solana RPC reads for D45 hard protocol/security state and current trading-wallet/custody balances before signing. Application-only derived facts such as strategy-lot attribution, drawdown and cohort capacity remain projection inputs, but are Release/policy bound, signed by the projector and reconciled against chain/custody totals. A projection mismatch, stale projection or independent-chain disagreement denies the entry.

This mechanism specifically protects against **database-only tampering**. A compromised worker can still emit bad projections, so worker compromise remains a separate threat addressed by independent chain reads, reconciliation, executor caps, signer-side policy and adversarial/runtime monitoring rather than pretending the projection signature makes the worker trustworthy.

The executor additionally enforces deployment-level absolute caps that cannot be raised by a database change. Dynamic portfolio/eligibility inputs are never treated as trustworthy merely because they happen to be stored in Postgres.

## D22 — Emergency exits have a narrow DB-independent authority

If Postgres is unavailable, new entries stop. The executor may still perform a strictly risk-reducing `EMERGENCY_CLOSE` without a normal database intent only when all of the following are true:

- the input asset is confirmed by chain/provider custody state as currently held by the trading account;
- the output is one of the deployment-level settlement mints (`SOL` and/or `USDC`);
- the action cannot increase exposure or buy a new risk asset;
- the amount does not exceed the chain-confirmed available amount;
- a deployment-local emergency policy and absolute caps pass;
- an authenticated position monitor or out-of-band operator command requests the close;
- transaction semantic validation still passes.

Emergency actions are written to a local durable execution journal and reconciled into Postgres when service returns.

## D23 — Risk cohorts are deterministic and versioned

Narrative/sector exposure limits never depend on live LLM classification. Active cohort membership comes from versioned manual/provider taxonomy and/or deterministic return-correlation clustering.

An AI may suggest a cohort label for later human review, but that suggestion is never immediately active risk policy.

## D24 — Live strategies use virtual capital sleeves over one physical wallet

The live wallet is one physical pool, but each promoted strategy receives a deterministic, versioned capital sleeve and risk budget. Global portfolio limits always dominate sleeve limits.

Physical holdings are decomposed into strategy-attributed position lots so P&L and exits remain attributable even when multiple strategies own portions of the same mint.

## D25 — The system has DB-independent emergency and signer-control paths

The dashboard is the normal control surface, but emergency authority does not depend on Next.js or Postgres.

Two deliberately separate out-of-band planes exist:

1. **Application emergency control** (for example `traderctl`) reaches the worker/executor over the private control network and supports at minimum `PAUSE_NEW_ENTRIES`, `EMERGENCY_CLOSE_ASSET`, and `EMERGENCY_CLOSE_ALL`. The executor immediately applies a pause locally and journals the command even if Postgres is unavailable.
2. **Signer/custody break-glass control** (for example `recoveryctl` plus the signer provider/control plane) does **not** route through the executor. It can revoke the executor workload identity's signing permission, activate a time-boxed incident signing identity, recover provider-vault assets where supported, and execute the narrowly defined cold-recovery sweep in D53/D54.

The two planes use different credentials/keys and are exercised independently. Compromise or outage of the executor must not prevent the operator from revoking its signing authority at the signer backend.

## D26 — The system cannot use its own trading as evidence

Trading-wallet addresses, registered Jupiter vault addresses and other application-controlled accounts are marked as owned addresses. Their flows are excluded from smart-money and wallet-flow features.

Candidate generation includes a self-influence guard so the application’s own entry cannot create or materially strengthen another strategy’s candidate. Where an aggregate provider metric cannot subtract our trade exactly, the affected token enters a short self-trade suppression/re-baselining window.

## D27 — Transaction authorization is semantic, not router-specific

The executor does not make brittle instruction-by-instruction knowledge of every Jupiter router the primary security boundary.

For every live transaction it performs:

1. cheap structural checks (expected fee payer/taker, signer set, input/output identity and expiry);
2. simulation through an approved independent Solana RPC;
3. predicted wallet/custody balance-delta validation against the signed intent envelope;
4. final post-chain reconciliation.

Simulation is the primary semantic preflight, but not sufficient by itself because chain state may change between simulation and landing.

## D28 — Operator UX is a first-class product boundary

The project is not complete when the backend can trade. It is complete only when a human operator can understand what the system is doing, why it is doing it, what is at risk, whether information is fresh, and how to intervene safely.

All important backend concepts therefore require explicit UI states and operator workflows. A configuration that exists only in environment variables, database rows, or logs is not considered operationally complete if the operator needs to understand or control it.

## D29 — Autonomous trading is implemented as a versioned Trading Skill

The autonomous agent receives a dedicated Trading Skill with a typed tool manifest and explicit workflows for candidate assessment, entry proposal, open-position reassessment, hold, reduction, discretionary exit, and permitted protective-order adjustment.

The Trading Skill is distinct from:

- **strategy** — the economic hypothesis/trigger and parameter set;
- **guidelines** — behavioral reasoning instructions and constraints;
- **automations** — deterministic events/schedules that invoke the skill;
- **risk policy** — hard deterministic authorization rules;
- **execution** — transaction construction/signing/submission.

A live strategy binds to immutable versions of all of these artifacts. The agent cannot create, edit, enable, or promote its own live skill, guidelines, automations, strategy, or risk policy.

## D30 — Every discretionary autonomous action passes an adversarial loop

Every autonomous action that can create, maintain, alter, or voluntarily remove market exposure must be independently challenged before deterministic authorization. This includes:

- enter;
- add/increase if a future strategy explicitly permits it;
- hold an open position at a scheduled/event-driven reassessment;
- reduce;
- discretionary exit;
- tighten/replace/cancel protective orders where agent discretion is permitted;
- any proposed change to an agent-managed position state that affects exposure.

The adversarial control receives the same point-in-time evidence plus the proposed action and independently searches for failure cases/counter-evidence. For LLM strategies it is an independent model run that may `CONFIRM`, `CHALLENGE`, or `REJECT`; for `T0_FAST` deterministic strategies it is an independent deterministic counter-signal/safety gate so speed tiering cannot eliminate the second-look invariant. A challenge returns to the proposer for a bounded revision cycle where the tier permits one.

For a candidate/entry, unresolved disagreement means no trade. For an already-open position, unresolved review never invents either `HOLD` or discretionary `EXIT`; the position enters `PROTECTION_ONLY` under D39 until review recovers. The adversary can never directly create an executable trade.

## D31 — Mandatory risk reduction cannot be blocked by an LLM

Hard stops, portfolio circuit breakers, critically unsafe-asset exits, operator emergency closes, and DB-independent emergency exits execute through deterministic risk-reduction policy without waiting for model approval.

An adversarial review is still recorded for learning/audit where available, but it is non-blocking and cannot delay, loosen, cancel, or reverse a mandatory risk-reduction action.

## D32 — Every strategy declares a latency/speed class

The platform supports different opportunity horizons rather than assuming every trade should wait for the same reasoning stack. Each strategy version declares a maximum decision latency, maximum candidate age, quote age, chase tolerance, and reasoning tier.

Initial classes are:

- `T0_FAST` — deterministic only; seconds to a few minutes;
- `T1_MOMENTUM` — deterministic + optional lightweight contextual check; minutes to tens of minutes;
- `T2_CONTEXTUAL` — full Trading Skill proposer + adversary; tens of minutes to hours;
- `T3_CATALYST` — deeper evidence packet and reasoning; hours to days.

No strategy may bypass D30 merely by labeling itself fast. `T0_FAST` is a deterministic strategy class, not an autonomous LLM shortcut. Every tier publishes an end-to-end decision budget that includes its required adversarial control. A tier that cannot clear within budget expires rather than silently skipping review.

## D33 — Critical exits require Jupiter-independent execution capability, with signer outage explicitly bounded

Jupiter remains the primary execution provider, but `LIVE_AUTO` readiness requires at least one independently operable emergency-exit adapter for supported settlement paths. The fallback is intentionally risk-reducing only: held risk asset -> approved SOL/USDC settlement asset.

"Provider-independent" here means **Jupiter-independent execution/routing**, not cryptographic signer independence. Every new on-chain transaction still requires the production wallet signer. Signer-backend availability is therefore a critical dependency under D51 and is monitored/tested separately.

`LIVE_AUTO` strategies default to provider-side protective orders where the token/protection mode is compatible and the custody trade-off is accepted. Any lot using `MONITORED_EXIT` counts toward a versioned deployment/risk-policy **signer-outage unprotected-exposure cap**. A new entry that would exceed that cap is denied. This bounds the amount of live exposure that would become non-exitable if both the application/executor path and remote signer become unavailable while already-installed provider protection continues independently.

The fallback does not need feature parity with Jupiter and is not used to increase exposure. This buys Jupiter-outage exit availability without falsely claiming that a remote signer outage can be solved by choosing another DEX.

## D34 — Held-asset safety and executability are continuously revalidated

Eligibility is not an entry-time certificate. While a position is open, the system periodically and event-drivably re-evaluates liquidity, route availability, Token-2022 extensions/hooks/fees, authority/security state, concentration and other execution-relevant behavior.

Before every exit attempt, the execution layer performs a fresh exit-compatibility check. A token becoming ineligible for new entries is a reason to consider reducing exposure, not a reason to refuse to sell it.

## D35 — Wallet replenishment is manual; reserve monitoring is automatic

The platform tracks available settlement capital, gas SOL reserve, USDC reserve, provider-vault commitments and per-strategy sleeve commitments. It alerts when operational or strategy reserve thresholds are crossed.

It does not automatically pull funds from a larger treasury/holdings wallet. Manual funding preserves the blast-radius cap of the dedicated trading wallet.

## D36 — Disaster recovery starts from chain truth and uses a separate break-glass signer identity

Complete infrastructure loss must be recoverable from the trading wallet/custody addresses and independently stored recovery/control material. The runbook starts by enumerating chain balances, provider vault balances and transaction history, reconstructing current exposure, invoking the separate D53 break-glass signing path to close/recover risk when necessary, and only then restoring/reconciling application state.

Trading-wallet recovery must exist outside the application deployment, executor and database. For an exportable development/test key this may mean offline recovery material; for the required production non-exportable signer it means a separately controlled provider/HSM identity and recovery mechanism that preserves access to the same wallet public key without exporting the private key.

The break-glass identity is not an application signing API. It is MFA/quorum protected, disabled or non-usable in ordinary operation, time-boxed to a declared incident, separately audited, and exercised in the disaster-recovery drill. The executor workload identity and break-glass identity are different principals.

## D37 — Economic performance includes operating cost

The platform reports:

1. **Trading P&L** — realized/unrealized trading result after execution fees, slippage, priority fees and token transfer fees;
2. **Strategy economic P&L** — trading P&L minus directly attributable model/data/RPC costs;
3. **Platform economic P&L** — aggregate strategy result minus shared providers, hosting, database and infrastructure costs.

A strategy that produces gross alpha but costs more to operate than it earns is not economically successful.

## D38 — Live configuration is an immutable, operator-attested Release

A **Release** is the immutable binding of strategy version, Trading Skill, guidelines, automation set, proposer/adversary model policy, risk policy, cohort/taxonomy policy, data-freshness policy and executor-visible policy reference used for a live strategy.

Promotion/arming of a Release requires operator step-up authentication. The resulting attestation is bound to the Release digest; the risk-authorizer verifies the attested digest before it can issue live authorization envelopes. Editing any bound artifact creates a new draft Release rather than changing a live Release in place.

For the initial private deployment, accepted administrator passkey/WebAuthn credential public keys or trust fingerprints are pinned/configured outside mutable trading tables. This prevents a database-only change from silently replacing the live bundle.

## D39 — Unreviewed open positions enter `PROTECTION_ONLY`

If an open-position discretionary reassessment cannot be adversarially cleared because of disagreement, model/adversary outage, timeout, spend budget, malformed output or exhausted revision budget, the runtime does not guess whether to `HOLD` or `EXIT`. The position enters `PROTECTION_ONLY`.

In `PROTECTION_ONLY`:

- the last valid deterministic stop/trail/time-stop/circuit-breaker policy remains active;
- no discretionary `HOLD`, `REDUCE`, `EXIT` or `ADJUST_PROTECTION` is executed;
- mandatory risk-reduction actions remain available and cannot be blocked;
- reassessment retries with bounded backoff;
- repeated unresolved cycles raise `HIGH` alerts;
- strategy policy may only **tighten**, never loosen, to a predeclared deterministic `unreviewed_stop` after the configured threshold.

## D40 — Evidence refresh creates a new shared cutoff version

A proposer/adversary cycle may not mix evidence from different hidden cutoffs. If a permitted refresh is requested, the action cycle records a new cutoff version and both the proposer revision and subsequent adversarial review run against that same refreshed cutoff.

The action cycle retains the ordered cutoff history (`cutoff_v1`, `cutoff_v2`, ...) and which run consumed each cutoff. A proposal produced under an older cutoff cannot be cleared against a newer one without a proposer revision.

## D41 — Human controls that can increase risk require step-up authentication

Passkey/WebAuthn is the primary step-up mechanism; TOTP may be configured as fallback. Step-up is required for arming/resuming live modes, exposure-increasing `LIVE_APPROVAL` approvals, Release promotion, live risk-policy changes, executor-visible configuration changes, operator/credential changes and other controls that can widen financial authority.

Pause and risk-reducing emergency controls deliberately do not require step-up beyond an already-authenticated operator session or the separate signed out-of-band authority.

## D42 — Critical alerting must work while the dashboard is closed during an active/responsible runtime period

`CRITICAL` operational events are delivered through mobile push plus at least one independent out-of-app channel, with delivery health, acknowledgement and escalation. Selected unacknowledged unable-to-exit/wallet-mismatch/executor-or-signer-with-open-position events automatically impose `PAUSE_NEW_ENTRIES` after a configured interval; they never automatically invoke `EMERGENCY_CLOSE_ALL`.

`OFF` is a declared safe state: heartbeat silence while the runtime is intentionally `OFF` and holds no unmanaged exposure is normal. Heartbeat/dead-man expectations apply while a runtime session is `STARTING`, `WATCH`, `ACTIVE`, `EVENT_WINDOW` or `WIND_DOWN`, or whenever exposure requires the runtime under D61.

## D43 — Autonomy has explicit model/data spend circuit breakers

The platform enforces versioned limits on action cycles per strategy/hour, model spend per strategy/day, platform model spend/day and provider request/rate budgets. Budget exhaustion blocks new discretionary cycles and puts affected open positions into `PROTECTION_ONLY`; mandatory deterministic protection/exits remain active.

## D44 — Provider protection is strategy-lot scoped

Provider protective orders must map one-to-one to a strategy-attributed protected lot (or an explicitly recorded sub-lot) so a provider fill has deterministic attribution. The platform never derives a shared mint-wide stop by taking the tightest strategy stop and applying it to unrelated lots.

Where the provider exposes isolated per-order custody/balance semantics, each protective order reserves only its attributed quantity and reconciles by provider order id. If the configured provider protection mode cannot guarantee lot/order isolation for a same-mint multi-strategy holding, those affected lots use `MONITORED_EXIT` instead.

## D45 — Hard security fields use chain truth, not one analytics provider

Security authority is field-specific:

- mint/freeze authority, token program, Token-2022 extensions, transfer fees/hooks and on-chain ownership/program state are read directly from Solana and are authoritative; analytics-provider copies are corroboration only;
- chain-verifiable concentration metrics use direct RPC/account state: mint supply plus the largest token accounts (for example top-1/top-5/top-10/top-20 account concentration); material mismatch against analytics/indexed copies blocks new entries;
- full holder count/distribution, beneficial-owner clustering and wallet-entity aggregation are **not** treated as cheaply/directly chain-verifiable RPC facts and remain indexed/analytics-derived evidence with explicit source/freshness semantics;
- dev/insider/bundler/smart-money labels remain analytics-derived evidence and fail closed for strategies that require them when unavailable;
- liquidity/exitability is proven by direct pool state plus executable route probes.

No single analytics provider may silently fabricate a hard protocol-state fact used to authorize a live entry.

## D46 — Browser wallet connection is a funding interface, never a trading authority

The product includes a Solana Wallet Standard connector in the Next.js web application for an **operator-controlled external wallet** (for example Phantom, Solflare or Backpack). Its purpose in v1 is to make manual funding and wallet visibility usable without weakening the dedicated trading-wallet boundary.

The connected browser wallet is explicitly **not** the trading wallet and is not an alternative execution signer. Connection grants no trading, risk, release, approval or authentication authority. In particular, connecting a wallet cannot:

- authenticate or step-up an operator session;
- arm/resume `LIVE_APPROVAL` or `LIVE_AUTO`;
- approve a trade authorization;
- attest/promote a Release;
- change risk/executor policy;
- sign Jupiter/Trigger/direct-pool autonomous execution;
- satisfy the executor's wallet-signature boundary;
- authorize an arbitrary destination or treasury pull.

The browser connector may only connect/disconnect, read the connected public account and balances, and request a **user-initiated, user-reviewed funding transaction** whose destination is the configured dedicated trading wallet (or its canonical settlement-token ATA) and whose asset is an allowed funding asset such as SOL/USDC. The user wallet signs through its own wallet UI. There is no scheduled/automatic pull from the connected wallet.

Autonomous trading, protection, emergency exits and restart recovery remain fully functional when no browser wallet is connected and when every browser is closed.

## D47 — Production live wallet signing uses a non-exportable Ed25519 key boundary

A production/mainnet live deployment may not load a raw Solana seed/private key into the executor container or filesystem. The trading-wallet private key is generated/imported into and remains non-exportable from a dedicated signing backend that supports Solana-compatible Ed25519 signing.

The executor owns **authorization to request a signature**, not possession of the private key. The signer adapter accepts only the exact validated transaction/message bytes plus narrow signing context and returns the signature/public-key metadata. Acceptable implementations include Turnkey, Privy server wallets, or an equivalent Solana signing/custody service whose production policy makes the trading key non-exportable to all normal and break-glass principals. The v1 reference implementation is Turnkey.

For Turnkey specifically, **non-exportable is an enforced configuration/policy property, not an assumed provider property**: both the autonomous principal and the break-glass principal must be unable to invoke wallet/private-key export activities. Live Readiness verifies the deny-export policy and its policy/version identity before mainnet live use. Break-glass recovery uses the narrowly permitted D53/D54 signing/recovery actions; it does not export the trading key.

Local software keys are allowed only in unit/dev/test environments with no real trading capital and can never satisfy Live Readiness.

## D48 — MEV/extraction risk is a measured execution cost, not hidden inside slippage

The platform treats sandwich/front-running/back-running/adverse-selection extraction as an execution-quality risk distinct from configured slippage and quoted price impact. Normal Jupiter `/order` managed execution may use provider-side MEV mitigation, but the system still records realized execution shortfall against the contemporaneous executable expectation.

Provider-independent direct-pool emergency exits are assumed to have higher MEV exposure. They may use an approved private/Jito-style landing path when healthy, but an urgent mandatory risk exit must not be delayed solely to obtain MEV protection.

Paper/replay cost models include a configurable MEV/adverse-execution allowance by execution path; live measurement uses actual pre-trade expectation versus confirmed/finalized balance deltas rather than claiming every shortfall was definitively MEV.

## D49 — Chain state has staged confirmation semantics

`processed`, `confirmed` and `finalized` are not interchangeable.

- `processed` is telemetry only and never sufficient to create authoritative trading/accounting state.
- `confirmed` may advance **provisional operational state** so the system can recognize a landed fill and install/maintain protection promptly.
- `finalized` promotes the transaction/fill into durable final accounting, realized P&L and irreversible audit state.

If a previously confirmed transaction disappears or conflicts before finalization, the affected execution enters `REORG_PENDING`, new entries pause as policy requires, wallet/custody state is reconciled from multiple RPC views, and the system never blindly resubmits until the original transaction is conclusively dead/non-landable.

During a chain halt, stalled finality or materially divergent RPC views, new entries fail closed. Existing provider-side protection remains active where applicable, and risk-reducing submission is attempted only when the configured chain-health policy says the network is accepting safely reconcilable transactions.

## D50 — AI-generated implementation is contract-first and invariant-gated

Build speed is not evidence of correctness. `/libs/contracts` is the single canonical schema source for all deployables; no application may maintain a hand-copied variant of an inter-service contract.

Every live-capable artifact embeds a canonical contract-set digest and must pass cross-boundary serialization tests, property/invariant tests, deployable-specific forbidden-import/network-policy checks, and a separate adversarial code-review pass before promotion. A compiled/running service that has not satisfied these gates is not considered implemented.

## D51 — Production signer availability is a critical position dependency

The non-exportable signer is part of the live safety path, not merely a custody implementation detail. Its health, latency, authentication state, policy state and outage behavior are monitored independently from the executor.

If signer health is lost:

- no new live entries or protection changes may be signed;
- already-installed provider-side protective orders continue independently;
- `MONITORED_EXIT` lots are explicitly recognized as signer-dependent exposure and count against D33's signer-outage unprotected-exposure cap;
- the system raises `CRITICAL_SIGNER_UNAVAILABLE_WITH_EXPOSURE` when open signer-dependent exposure exists;
- break-glass recovery may be attempted only through D53's separate signer/control identity, not by weakening the executor path.

## D52 — Risk-state projections are signed, sequenced and independently checked where chain truth exists

The worker state projector owns a distinct projection-signing credential unavailable to Postgres/web. Each `RiskStateProjection` canonically binds portfolio/custody totals, strategy sleeves/lots, exposure, drawdown, cohort capacity, eligibility summary, freshness summary, source-event digests, chain slot/as-of time and monotonic sequence.

The risk-authorizer rejects missing, stale, rollback-sequence or signature-invalid projections. Before an entry it independently re-reads D45 hard token state and current wallet/custody balances from allowlisted Solana RPC/control-plane endpoints and compares them with the projection. Database-only modification therefore cannot manufacture a valid wider risk state.

## D53 — Break-glass signing is outside the application and narrowly incident-scoped

A production non-exportable wallet requires a separate recovery signer principal that does not route through `web`, `worker`, `risk-authorizer` or `execution-service`.

The break-glass principal:

- requires strong MFA and/or quorum approval appropriate to the signer provider;
- receives short-lived credentials only for a declared incident;
- is separately logged/alerted and never used for routine trading;
- may sign only incident runbook actions: risk-reducing held-asset -> SOL/USDC swaps, Trigger/provider vault cancel/withdraw/recovery flows, and the D54 pre-registered cold-recovery sweep;
- cannot promote Releases, widen strategy/risk policy or become an autonomous trading identity.

For Turnkey/Privy/equivalent implementations this uses a separately controlled owner/quorum/recovery identity with MFA/short-lived incident authority and policy separation from the autonomous executor identity.

## D54 — Executor/signer compromise response revokes first, then recovers/sweeps

A suspected executor compromise triggers an incident state, immediate `PAUSE_NEW_ENTRIES`, and out-of-band revocation/disablement of the executor workload identity at the signing backend. A Solana public key cannot be "rotated" in place; cutting off the compromised requester is therefore the first containment action.

After revocation, the D53 break-glass principal may recover provider-vault funds and sweep wallet-owned SOL/SPL balances to a **pre-registered cold recovery wallet** whose address/trust record is pinned outside mutable trading tables and outside the compromised executor deployment. `SWEEP_TO_COLD_RECOVERY` is the only incident transfer-to-external-address class and cannot accept a caller-supplied recipient.

The incident remains live-blocking until chain/custody reconciliation, credential rotation/redeployment, signer-policy verification and operator closure are complete.

## D55 — `LIVE_AUTO` requires a second signer-side transaction policy layer

Executor semantic validation is one security layer; it must not be the only layer able to constrain what the non-exportable wallet signs during autonomous operation.

For `LIVE_AUTO`, the signer path must enforce transaction-aware policy **outside the executor**. A signer provider with native Solana transaction policy (for example program/instruction/recipient constraints) may satisfy this directly. A byte-only signer backend, if ever introduced, must be fronted by a separately isolated signer-policy gateway; the executor may not hold unrestricted signing permission directly.

The policy is deny-by-default and versioned. It permits only the approved execution/protection/recovery program and account classes required by the current deployment, constrains System/Token transfers so arbitrary external recipients cannot be introduced, and denies raw/general message signing for the autonomous principal. A Jupiter route containing an unapproved program is rejected/requoted rather than silently widening the policy.

**Turnkey address-lookup-table constraint.** Turnkey does not resolve account addresses loaded through Solana address lookup tables into policy-visible addresses; those account fields surface as `ADDRESS_TABLE_LOOKUP`, while program addresses resolved through lookup tables are rejected by Turnkey. Because Jupiter versioned transactions may use lookup tables heavily, the signer policy must not assume every routed account can be address-allowlisted. Before Turnkey can satisfy D55 for `LIVE_AUTO`, contract tests against real Jupiter `/order` versioned transactions must prove that the exact route classes we intend to sign are both (a) accepted when legitimate and (b) denied when lookup-table placeholders, top-level System/SPL transfers, static program keys, or other policy-visible fields violate the pinned policy. The signer policy remains a second layer: it never replaces executor simulation and semantic balance-delta validation, because policy-visible transfer lists do not necessarily expose all inner/CPI effects. If the selected Jupiter transaction shapes cannot be constrained safely under the tested Turnkey policy, Turnkey fails the D55 readiness gate for that route/mode rather than weakening the policy.

The break-glass principal in D53 has a different incident policy and does not weaken the normal autonomous signer policy.

## D56 — Live capital/blast-radius attestation includes post-arm funding

Live arming records a versioned **capital attestation ceiling** for total value under the trading wallet and registered custody locations. Confirmed browser/manual funding, external transfers, provider-vault movements and material mark-to-market increases are reconciled against that ceiling.

If total recognized custody value rises above the attested ceiling, new entries automatically pause in `CAPITAL_REATTEST_REQUIRED`, a `HIGH` alert is raised, and an operator step-up re-attestation (or risk-reducing sweep) is required before another exposure-increasing intent may execute. Existing exits/protection are never blocked by this state.

## D57 — Vercel is the product/control plane and an allowed early-stage runtime substrate, but not a mandatory hardened live host

Vercel remains the reference host for `/apps/web`: Next.js UI, authenticated read/control routes, browser wallet integration and presentation/research APIs.

For **Profiles 0–2** under D65, Vercel Sandbox/Workflow/Functions may also host request-shaped or session-shaped runtime work when that profile's durability, lifecycle and cost requirements are satisfied. In particular, an attended PAPER session may use a Vercel Sandbox, and unattended PAPER may use the cheapest measured session runtime because downtime loses research data rather than capital.

This does **not** mean traditional Vercel Functions/Cron may impersonate an indefinite daemon. Any runtime responsible for open exposure must satisfy D61's availability/durability contract for the entire responsibility interval. A Vercel Sandbox may host a live experimental session only if its execution-journal durability and session-lifecycle behavior pass the profile's contract tests; otherwise attended live runs locally or on a fixed-price persistent VM.

For **unattended meaningful-capital `LIVE_AUTO`**, the reference hardened topology remains persistent compute whose process/disk/network guarantees are independent of an HTTP/function lifetime. Physical isolation is capital/maturity-driven under D65 rather than a prerequisite for proving the strategy.

## D58 — The reference technology stack is pinned; physical deployment is maturity-dependent

The implementation reference stack for v1 is:

- **Web/control plane:** Next.js 16 Active LTS App Router + React + TypeScript on Vercel Pro; Base UI (`@base-ui/react`) for accessible unstyled primitives; project-owned pure CSS/CSS Modules with `oklch()` design tokens; TanStack Query/Table; TradingView Lightweight Charts for market charts and Recharts for operational/research charts. No Tailwind or shadcn/ui dependency is introduced.
- **Browser Solana:** `@solana/kit`, `@solana/kit-plugin-wallet`, `@solana/react` and Wallet Standard.
- **Database/platform:** Supabase managed Postgres + Auth + Realtime Broadcast + Supabase Queues (`pgmq`); SQL/Supabase CLI migrations are schema authority; no ORM may silently own/alter production schema.
- **Backend runtime/workspace:** Node.js 24 LTS + TypeScript in a pnpm + **Nx** monorepo; Zod is the canonical wire-boundary schema layer; `@solana/kit` is the primary Solana JS client stack. Nx project tags plus `@nx/enforce-module-boundaries` are part of the security architecture: source-level dependency rules enforce which apps/libs and external packages `web`, `worker`, `risk-authorizer` and `execution-service` may import, complementing the built-artifact checks in §24.8.
- **Logical deployables:** `web`, `worker`, `risk-authorizer`, `execution-service`. These boundaries and contracts exist from the first build; physical host isolation is introduced according to D65 rather than required before paper evidence exists.
- **Session runtime:** local Docker/Node processes and Vercel Sandbox are valid early-profile substrates; a fixed-price Linux VM is the reference persistent substrate once unattended live responsibility warrants it.
- **Hardened persistent compute:** DigitalOcean Basic Droplets remain the reference fixed-price implementation when physical isolation is warranted, but three Droplets are a **Profile 4 hardened target**, not an initial operating cost.
- **Durable local financial state:** the executor and worker use storage satisfying D22/D23 for any profile allowed to hold live risk. Local workstation/VM durable disk is acceptable when its profile explicitly accepts single-host risk. Vercel snapshot/session persistence is not assumed to satisfy persist-before-submit unless an executable durability contract test proves it; PAPER does not require a financial emergency journal.
- **Production trading-wallet signer:** **Turnkey is the reference v1 signer** because its Solana-aware policy engine can enforce D55 outside the executor while keeping the key non-exportable. Privy/equivalent non-exportable policy-capable signers remain adapter alternatives; AWS is not part of the reference or alternate stack.
- **Container delivery:** GitHub Actions + GHCR for persistent-host deployments; local/Sandbox profiles may run the same versioned images or workspace processes.
- **Observability:** OpenTelemetry + Sentry across web/services; Vercel Observability for Vercel-hosted components; host-native metrics/alerts for persistent VMs.
- **Testing:** Vitest, `fast-check`, Playwright, Supabase CLI/local Postgres fixtures and provider/chain contract-test harnesses.

The software stack is therefore stable while hosting cost scales only after evidence. An implementation agent may not collapse logical trust boundaries in code merely because early profiles co-reside physically.

## D59 — No AWS dependency is permitted in the v1 reference build

The v1 implementation does not use AWS for compute, signing, storage, networking, secrets, logging, CI identity, recovery or any hidden auxiliary service.

If a future design proposes an AWS component, that is a new blueprint decision requiring explicit operator approval and a cost/security justification. An implementation agent may not reintroduce AWS merely because a library example, Terraform module or previous blueprint revision referenced it.

## D60 — Runtime activity and capital authority are orthogonal axes

Runtime activity state is:

- `OFF` — runtime intentionally inactive; no unmanaged exposure is permitted;
- `STARTING` — feeds/reconciliation/backfill/warm-up/readiness are being established; no new candidate may execute;
- `WATCH` — observation/detection are active, but new entries are not authorized by activity policy;
- `ACTIVE` — normal strategy candidate/action cycles may run subject to capital authority;
- `EVENT_WINDOW` — a bounded catalyst-driven intensive window is active; it does not widen capital/risk policy;
- `WIND_DOWN` — no new entries; open/in-flight state is being closed, protected or reconciled so the runtime can safely become `OFF`.

Capital authority remains `OBSERVE` / `PAPER` / `LIVE_APPROVAL` / `LIVE_AUTO`. `PAUSED` is a sticky operator override across both axes and requires explicit operator re-arm. A schedule may move `WATCH <-> ACTIVE` or end an `EVENT_WINDOW`; it may not clear `PAUSED`.

## D61 — Availability is exposure-driven, not 24/7 by definition

The runtime must remain continuously available for the entire period in which it is responsible for **unmanaged exposure**, not merely because crypto markets trade 24/7.

A live position is `OFFLINE_PROTECTED` only when **all** of the following hold:

- strategy policy explicitly permits bounded offline protection;
- required provider-side protective order(s) are confirmed active and reconcile to the exact protected lot quantity;
- no execution is `SIGNED_NOT_SUBMITTED`, `SUBMITTED`, `CONFIRMED_PROVISIONAL` or `REORG_PENDING`;
- no Trigger/provider deposit, cancel, withdrawal or custody transfer is mid-flight;
- last token-safety, custody and emergency-route state was healthy at wind-down;
- the strategy defines a maximum offline duration and the planned resume occurs before that deadline;
- any provider protection/custody expiry or maintenance deadline falls after the required resume;
- the operator/runtime has a defined wake/resume path.

Anything else is **unmanaged exposure** and prevents the runtime from becoming `OFF`. `END SESSION` therefore either reaches zero exposure or proves every remaining lot is `OFFLINE_PROTECTED` within policy. On resume, reconciliation, provider-order/fill refresh, token-safety refresh and emergency-route refresh complete before entries can re-open.

Provider-side price stops do not by themselves make a position indefinitely safe offline; D34 safety changes, route deterioration, gap/slippage failure and custody/provider problems remain reasons for bounded offline duration.

## D62 — Strategies are session-, regime- and schedule-aware

A strategy may declare allowed/blocked global market sessions, weekdays/weekends, local/custom time windows, minimum activity/volatility/breadth conditions and behavior outside its preferred window (`WATCH`, `NO_NEW_ENTRIES`, or research-only PAPER).

Session labels are research features, not assumed alpha. The platform records Asia, Europe, US and overlap/session metadata plus market-regime features so §30 can test whether apparent session effects survive fees and regime controls.

The operator may manually start/end an attended session. Later autonomous operation may start sessions from schedules/automations without changing the strategy/risk/Release boundary.

## D63 — Cold start is explicit and cannot score warmed indicators from empty history

Every runtime start enters `STARTING`. It cannot progress to `WATCH`, `ACTIVE` or `EVENT_WINDOW` until the configured profile's required checks pass:

- chain/custody/intent/provider-order reconciliation clean;
- required feeds connected and fresh;
- eligible/watch universe refreshed;
- OHLCV/backfill sufficient for every enabled indicator's lookback/warm-up requirement;
- feature baselines/relative-volume/reference-series warm;
- held-asset safety and emergency-route snapshots refreshed where applicable;
- required signer/protection/readiness checks healthy for the selected capital authority.

Historical provider data loaded for warm-up is tagged `BACKFILL` with provider source/event time and ingestion time. It may seed deterministic indicators but is never treated as a live-observed event or assigned a fabricated live `first_seen_at` for replay/novelty purposes.

## D64 — Catalyst windows are source-time bounded and deterministically capped

A Trading Skill may propose that a catalyst deserves an `EVENT_WINDOW`, including expected action horizon/half-life, but deterministic strategy/automation policy caps the maximum window, allowed actions and extension rules.

Catalyst age is measured from trustworthy **source/event time**, not from when a sleeping/offline runtime happened to ingest the story. `first_seen_at` remains mandatory for replay truth and novelty availability, but it cannot reset catalyst age. If trustworthy source time is absent or ambiguous, the event cannot open a fresh high-speed catalyst window solely from a new `first_seen_at`; policy must use a conservative fallback or require corroborated real-time evidence.

A later genuinely new source event may create a new cutoff/window. Repeated or recycled content does not.

## D65 — Deployment and supervision mature with evidence; full autonomy remains the destination

The platform is built with the full autonomous architecture from day one, but operational profiles are promoted progressively:

- **Profile 0 — Development/replay:** local workstation + Vercel/Supabase; no live capital; physical isolation not required.
- **Profile 1A — Attended PAPER:** local runtime or Vercel Sandbox; operator usually present; session-oriented; no live capital.
- **Profile 1B — Unattended all-session PAPER:** optional cheap 24/7/near-24/7 runtime once stable, specifically to collect unbiased Asia/Europe/US/weekend data. Downtime costs research coverage, not capital. Planned restarts are acceptable and measured.
- **Profile 2 — Tiny attended live experiment:** deliberately small attested wallet; operator-presence heartbeat required; local durable workstation or single fixed-price VM is the default. Vercel Sandbox is allowed only if its synchronous execution-journal durability contract is proven. Logical service boundaries, Turnkey signer/policy, risk authorization, caps and adversarial loop remain intact even if processes co-reside physically. **Developer-agent hygiene:** when Profile 2 runs on the development workstation, live financial-control credentials — at minimum the executor's Turnkey credential and the risk-authorizer's private authorization key — run in a dedicated local VM/service boundary with no repository mount/shared shell environment and no credential path exposed to VS Code/Codex/Claude/Kimi/other coding-agent processes. Co-residency on one physical machine is accepted; co-residency in the same agent-accessible user/runtime environment is not.
- **Profile 3 — Unattended live pilot:** after technical + strategy + tiny-live evidence, use a boring persistent fixed-price VM/runtime with durable disk and watchdogs; split executor from general worker when capital/risk warrants it.
- **Profile 4 — Hardened autonomous `LIVE_AUTO`:** meaningful capital/unattended operation; physically isolate `worker`, `risk-authorizer` and `execution-service` as justified by blast radius, with the three-host DigitalOcean topology as the reference implementation.

Promotion increases infrastructure/security cost only when evidence and capital justify it. It never deletes the autonomous Trading Skill, Action Adversary, signer policy, deterministic risk, emergency execution or Live Readiness requirements.

For attended Profile 2 live sessions, browser/operator presence is itself a health signal. Loss of the configured presence heartbeat triggers `PAUSE_NEW_ENTRIES` after the grace interval; it never disables exits/protection. An explicit operator action can deliberately transition to a policy-permitted unattended profile instead of pretending presence still exists.

---

# 3. Current External Data and Execution Stack

Provider adapters isolate all dependencies.

## 3.1 Birdeye — primary market/discovery/risk intelligence

Use for:

- token search/discovery;
- prices;
- OHLCV;
- real-time price/transaction streams;
- liquidity and trading activity;
- token overview;
- token security;
- holder distribution;
- holder profiles;
- smart-money token discovery;
- top traders;
- wallet PnL/quality analysis.

Birdeye's current Solana WebSocket supports very short candle intervals as well as price/transaction updates. Its holder/security APIs are useful for concentration, wallet quality, and token-risk gates.

## 3.2 Helius — on-chain event truth and tracked-wallet stream

Use for:

- Solana RPC;
- parsed/enhanced webhooks;
- selected account/program monitoring;
- transaction/account event streaming;
- wallet movement verification;
- optional higher-performance streaming later.

We should not require the highest Helius streaming tier to make the application function. The adapter should support normal webhooks/WSS first and a lower-latency stream as a deployment option.

## 3.3 Jupiter — quotes, routing, swaps, optional protective orders

Use Swap V2 `/order` + `/execute` for normal spot execution.

Current Jupiter Meta-Aggregator behavior includes competition among multiple routers and managed transaction landing. Jupiter handles route construction, slippage estimation and network landing concerns, but our risk system still owns maximum acceptable price impact/slippage and transaction intent validation.

Use Trigger V2 through a separate adapter if provider-side stop/OCO protection is enabled.

## 3.4 LunarCrush — social intelligence

Use for normalized:

- mention velocity;
- social interactions;
- sentiment;
- contributor growth;
- trending/rank movement;
- influential creator/posts where licensed by the plan.

Raw social-source integration should not be required for the first working system if LunarCrush supplies sufficient normalized context.

## 3.5 CryptoPanic — crypto news aggregation

Use for:

- recent crypto news;
- token/project-specific news;
- sentiment metadata where available;
- source URL and publication time.

The application stores normalized event metadata and only the source content permitted by provider terms.

## 3.6 Optional direct sources

Adapters may later add:

- project RSS/blogs;
- official X/project account feeds;
- Solana ecosystem announcement feeds;
- macro calendar/news provider;
- exchange/listing feeds.

Direct-source events should carry higher provenance weight than anonymous reposting.

## 3.7 Solana Kit / Wallet Standard — browser funding-wallet connector

For the new Next.js operator UI use the current Solana frontend stack:

- `@solana/kit` as the primary TypeScript Solana SDK;
- `@solana/kit-plugin-wallet` for Wallet Standard discovery/connection;
- `@solana/react` for React provider/hooks;
- generated `@solana-program/*` clients as needed for standard SOL/SPL funding instructions.

Do not introduce legacy `@solana/wallet-adapter-*` as the default architecture for this new application. Wallet Standard discovery should allow modern compatible wallets without one adapter dependency per wallet.

The connector is **web/UI infrastructure only**. It must not be imported into `worker`, `risk-authorizer` or `execution-service`, and a disconnected/unavailable browser wallet is not a trading-runtime health failure.

Live deployment is pinned to the configured Solana cluster. The funding UI must show network/cluster prominently and refuse to prepare a funding transfer when the connected wallet cannot operate on the deployment's configured chain.

---

# 4. High-Level System Architecture

```text
 ┌──────────────────────┐
 │ Operator browser     │
 │ Wallet Standard      │
 │ funding wallet       │
 └──────────┬───────────┘
            │ connect/read + user-signed FUND ONLY
            ▼
 ┌──────────────────┐          ┌────────────────────────┐
 │ Web (Next.js)    │          │ traderctl              │
 │ operator UI +    │          │ signed out-of-band     │
 │ control API      │          │ emergency commands     │
 └────────┬─────────┘          └───────────┬────────────┘
          │ read/control                   │ private control path
          ▼                                │
 ┌────────────────────────────────┐        │
 │ Postgres / Supabase            │        │
 │ ledger · config · queue · audit│        │
 └──┬────────────┬──────────────┬─┘        │
    │            │              │          │
    ▼            ▼              ▼          ▼
 ┌──────────┐ ┌──────────────┐ ┌──────────────────────────────┐
 │ worker   │ │ risk-        │ │ execution-service            │
 │ ingest   │ │ authorizer   │ │ caps · tx validator ·        │
 │ signals  │ │ isolated     │ │ local journal · Trigger      │
 │ agents   │ │ signer of    │ │ JWT/vault · emergency close  │
 │ trading  │ │ risk envelope│ │ + direct-pool fallback       │
 │ recon    │ └──────┬───────┘ └──┬────────┬───────────┬─────┘
 └────┬─────┘        │             │        │           │
      │              │             │        │           │ validated tx bytes
      ▼              │             ▼        ▼           ▼
 Birdeye · Helius/RPC│        Jupiter   Independent  Direct-pool
 LunarCrush · news   │        Swap/     simulation   emergency exit
 LLM proposer/       │        Trigger   RPC          Raydium/Orca/
 adversary           │                              Meteora adapters
                     │                         ┌───────────┴───────────┐
                     │                         │ signer policy layer   │
                     │                         │ native or isolated    │
                     │                         │ gateway (D55)         │
                     │                         └───────────┬───────────┘
                     │                                     ▼
                     │                         ┌───────────────────────┐
                     │                         │ non-exportable        │
                     │                         │ Ed25519 signer        │
                     │                         │ Turnkey (reference)   │
                     │                         └───────────┬───────────┘
                     │                                     │ signature only
                     └─ signed authorization envelope only │
                                                           ▼
                                                  dedicated trading wallet

 Browser funding wallet ── user-signed SOL/USDC transfer ──► trading wallet/custody
 (never an autonomous signer)

 recoveryctl / signer control plane ── MFA/quorum break-glass ──► signer backend
 (revocation, incident signing, cold-recovery sweep; never through executor)
```

## 4.1 Recommended repository structure

Keep logical boundaries while isolating the two financial authority processes from the untrusted/general worker:

```text
/apps
  /web                    Next.js dashboard and authenticated control API
  /worker                 multi-role runtime worker: ingest, signals, agents, trading, reconciliation
  /risk-authorizer        isolated policy process; no LLM/provider-text runtime; owns risk-authorization key
  /execution-service      isolated transaction authority: validator, caps, Trigger custody and emergency journal; requests remote signatures

/libs
  /contracts              shared Zod schemas / typed events
  /db                     database clients and repositories
  /market                 market data domain
  /onchain                on-chain intelligence + hard security state
  /intelligence           news/social normalization
  /signals                deterministic indicators/features
  /strategies             versioned strategy implementations
  /agents                 model gateway, proposer/adversary runtime, structured outputs
  /skills                 versioned Trading Skill, guidelines, tool manifests, automations
  /risk                   deterministic policy, cohorting, sizing, Release verification, signed authorization
  /execution              intent/quote/order/custody/direct-pool abstractions
  /wallet-ui              Wallet Standard/Kit browser connector + typed manual-funding flow; web-only
  /replay                 point-in-time clock and replay engine
  /observability          structured logs, metrics, tracing
  /testing                fixtures, fake providers, simulation harnesses
```

`worker` may run multiple independently leased roles/queues in one deployment. `risk-authorizer` and `execution-service` are separate logical processes/containers from the first build and receive distinct credentials/secrets even when an early no-capital/tiny-capital profile co-resides on one physical host. Physical host separation becomes mandatory only at the D65 profile/readiness level that requires it. Compromise of the general worker must never expose the risk-authorization private key or production wallet private key. The production wallet key remains non-exportable at the signer backend; executor compromise yields at most the constrained ability to request signatures until the signer policy/revocation controls stop it.

The risk-authorizer has no LLM access and no unbounded provider/network tooling. It reads the canonical proposal/action-cycle, immutable attested Release and versioned policy; verifies a fresh signed `RiskStateProjection`; independently re-reads D45 hard security state and wallet/custody balances through narrowly allowlisted Solana RPC/control-plane endpoints; then computes and writes the signed authorization envelope.

Use the D58 Node.js 24 LTS/TypeScript pnpm + Nx monorepo. Do not duplicate contracts between apps. Apply Nx tags/boundary rules from the first commit so `risk-authorizer`/`execution-service` forbidden dependencies fail at source lint time as well as artifact verification time.

---

# 5. Technology Stack, Runtime and Deployment

This section is normative for the reference v1 **technology stack and deployment profiles**. Provider adapters remain replaceable. Logical trust boundaries are fixed; physical hosting is maturity-dependent under D65. An implementation agent must not silently treat the Profile 4 hardened topology as a prerequisite for Profiles 0–2, nor use an early co-resident profile as justification to erase the final isolation design.

## 5.1 Web application — Next.js on Vercel

Reference stack:

- Next.js 16 Active LTS, App Router;
- React + TypeScript;
- Base UI (`@base-ui/react`) primitives;
- project-owned pure CSS/CSS Modules with `oklch()` design tokens; no Tailwind/shadcn dependency;
- TanStack Query for client query/cache coordination;
- TanStack Table for dense operational/research tables;
- TradingView Lightweight Charts for OHLCV/market charts; retain the required TradingView attribution notice/link (or its built-in attribution logo) on user-visible chart surfaces as required by the library license;
- Recharts for P&L, attribution, exposure and operational charts;
- Supabase Auth/session handling;
- `@solana/kit-plugin-wallet` + `@solana/react` for browser Wallet Standard discovery/connection.

Deployment: **Vercel Pro**. Choose web/control geography near the active Supabase/runtime profile where practical; no DigitalOcean region is required before a persistent-host profile is promoted.

The Vercel application is the product UI and authenticated control plane. Its server routes may validate operator requests, create versioned DB control records and return reads. They do **not** run the autonomous trading loop, own durable queues, monitor positions or sign/submit autonomous trades.

Vercel Workflow may be used for request-shaped durable orchestration (for example proposer/adversary/research/replay or scheduled session start requests) when its latency/durability contract is appropriate. Traditional Functions/Cron chaining may not own a tight position-monitor loop, resident provider stream or other responsibility that requires uninterrupted process residency. Production dashboard state should use Supabase Realtime Broadcast or normal reads so the web function lifecycle is not a financial dependency.

## 5.2 Runtime profiles — session-capable first, persistent/hardened when earned

The four logical apps remain `web`, `worker`, `risk-authorizer`, and `execution-service`. How the latter three are physically hosted depends on D65:

| Profile | Typical runtime | Physical isolation | Live capital | Availability expectation |
| --- | --- | --- | --- | --- |
| 0 Development/replay | local workstation/processes | no | none | on demand |
| 1A Attended PAPER | local or Vercel Sandbox | no | none | trading/research session only |
| 1B Unattended PAPER | cheapest measured always/near-always runtime; Sandbox acceptable | no | none | maximize research coverage; planned restart acceptable |
| 2 Tiny attended live | local durable workstation or one fixed-price VM; Sandbox only after journal durability proof | logical/process isolation | deliberately tiny | continuous for attended session and any D61 unmanaged exposure |
| 3 Unattended live pilot | one persistent fixed-price VM initially; split executor as capital warrants | increasing | limited pilot | continuous while responsible for exposure |
| 4 Hardened LIVE_AUTO | separate persistent hosts for worker / authorizer / executor | yes | meaningful | unattended production availability + DR |

### Vercel Sandbox use

Vercel Sandbox is an allowed **session runtime**, not a magical substitute for all persistence guarantees. It is especially suitable for Profile 1A and may be used for Profile 1B where scheduled restart/recovery is measured. For Profile 2, it is permitted only after an executable test proves the exact persist-before-submit journal semantics required by §15; otherwise use the operator workstation or a fixed-price persistent VM.

Traditional Vercel Functions/Cron are not used for tight position-monitor loops or resident provider streams merely by chaining invocations. Vercel Workflow/Queues may be used for request-shaped durable orchestration such as proposer/adversary/research/replay tasks when doing so preserves contracts, cutoffs and latency budgets.

### Persistent fixed-price runtime

DigitalOcean remains the reference fixed-price provider when a persistent VM is needed. A single small VM is sufficient for early live pilots when the operator explicitly accepts the single-host blast radius and the attested capital ceiling is small. Profile 4 uses separate fixed-price hosts for the three financial runtime services.

At no point does a physical-host shortcut permit code-level trust-boundary collapse: credentials, IPC/API contracts, signer policy and risk authorization remain distinct.

## 5.3 Database/platform — Supabase

Use one managed Supabase project for:

- Postgres operational/research ledger;
- Supabase Auth;
- RLS;
- Realtime Broadcast for browser-facing state changes;
- Supabase Queues (`pgmq`) for durable background jobs/events;
- generated TypeScript database types;
- optional Storage only for exports/reports that should not live in DB rows.

SQL migrations committed in the repository and applied through Supabase CLI are the database schema authority. Do not make Prisma/Drizzle/another ORM migration system a competing schema authority. Application repositories may use `@supabase/supabase-js` and/or a typed Postgres client where appropriate.

Long-lived DigitalOcean services consume queues through database/service credentials unavailable to the browser. Queue tables/functions are never exposed merely for frontend convenience.

For dashboard realtime, prefer Supabase **Broadcast** over broad Postgres Changes subscriptions. Realtime is presentation/notification transport; database/chain state remains authoritative.

## 5.4 Queueing — Supabase Queues / `pgmq`

Supabase Queues is the required initial durable job/event queue. Use logged/durable queues for trading work; unlogged queues are not permitted for intents, execution, risk, position management or reconciliation.

Required semantics:

- visibility timeout/lease ownership;
- retry with bounded exponential backoff;
- explicit archive/dead-letter handling;
- idempotent handlers;
- recover after worker death;
- queue message contracts versioned through `/libs/contracts`.

`pgmq`/Supabase Queues is FIFO and has no native priority level. Priority is therefore implemented with **separate durable queues**, not a fictional `priority` field. At minimum use queue classes equivalent to:

1. `trade-critical` — hard/urgent exits, protection repair, custody emergency work;
2. `reconciliation` — chain/provider reconciliation and ambiguous execution recovery;
3. `trading-actions` — candidate/action-cycle/risk/execution work that is not already urgent;
4. `research` — enrichment, replay, reports and non-critical analysis.

Consumers poll/drain in that order with bounded burst/fairness rules so research cannot delay risk reduction and a permanently busy critical queue does not corrupt queue semantics. Truly synchronous hard-stop/emergency paths may bypass generic research/action queues entirely where the relevant state machine already provides a direct authenticated path.

If later throughput requires NATS/Redis/Kafka, migration occurs behind the queue adapter and must preserve these semantics.

## 5.5 Solana/execution libraries

- `@solana/kit` is the primary TypeScript Solana client foundation.
- Browser wallet discovery uses `@solana/kit-plugin-wallet`, `@solana/react` and Wallet Standard.
- Jupiter Swap/Trigger integrations use the documented HTTP/API contract through a typed adapter rather than leaking Jupiter response shapes through the domain.
- Raydium, Orca and Meteora direct emergency adapters use their supported SDK/instruction libraries where available, wrapped behind our own execution contract and semantic simulation validation.
- Helius is the primary enhanced RPC/on-chain event provider; independent Solana RPC endpoints are retained for simulation/reconciliation/finality disagreement checks.

## 5.6 Production signer

The reference production signer is **Turnkey** using its Solana `SIGN_TRANSACTION`/Policy Engine path, because D55 requires transaction-aware policy enforcement outside the executor. The exact Turnkey policy, wallet identity and API behavior are versioned/contract-tested before Live Readiness can pass.

Privy or another non-exportable Solana signer may replace Turnkey only through the `TradingWalletSigner` adapter and only if its transaction-policy, recovery, availability and audit behavior passes the same contract/readiness tests.

Development/local testing may use a software signer behind the same `TradingWalletSigner` interface; it can never pass production Live Readiness.

## 5.7 Authentication and operator step-up

Supabase Auth owns primary application sessions and role identity. TOTP MFA uses Supabase MFA. Passkey/WebAuthn step-up must use a production-stable implementation; do not make Live Readiness depend on an experimental auth feature. The reference implementation may use a dedicated WebAuthn library/service while keeping Supabase user identity canonical.

Wallet Standard connection is funding UX only and remains outside operator authentication per D46.

## 5.8 Observability

- OpenTelemetry is the common trace/metric instrumentation contract;
- Sentry captures application errors/traces across Next.js and Node services;
- runtime/host metrics capture CPU/memory/disk/load/network health for whichever D65 profile is active (local/Sandbox/persistent VM);
- Vercel Observability covers the web deployment;
- critical financial/audit state remains in the append-only application audit ledger, not merely in log platforms.

Correlation IDs must traverse Vercel → Supabase/control records → queue → worker → risk-authorizer → executor → signer/provider.

## 5.9 Infrastructure and CI/CD

- Git repository: GitHub;
- workspace/build orchestration: pnpm + Nx;
- infrastructure as code: Terraform for any persistent-host Profile 3/4 infrastructure; no paid persistent infrastructure is required merely to begin development/paper testing;
- web deploy: Vercel Git integration/CI;
- backend images: GitHub Actions → GHCR for Sandbox/persistent-host/container deployments where images are used;
- backend deploy authentication: profile-specific scoped deployment credentials stored only in protected GitHub Actions environments; rotate periodically and never bake into images;
- service secrets: remain service-specific even when logical services co-reside on an early profile; persistent hosts use root-owned `0600` files/Docker secrets or an equivalent profile-appropriate secret mechanism;
- Supabase migrations: Supabase CLI from gated CI;
- production deploys require contract/invariant/security gates from §24/§40 before promotion.

A frontend deployment must never implicitly redeploy/restart the financial runtime. Backend deployments are service-specific and must pass health plus chain/custody reconciliation before accepting new entries after restart.

## 5.10 Region and latency selection

Do not pin the research system to a paid region before measurements justify it. Vercel/Supabase/local/Sandbox profiles use the closest practical supported geography while recording provider/RPC latency. When Profile 3/4 persistent compute is introduced, place financial services together in one primary region chosen from measured Jupiter/Helius/Turnkey/Supabase latency and reliability, with Panama operator latency as a secondary UI/control consideration.

Profile promotion records the selected region and evidence. Services sharing financial state are not casually scattered across regions.

---

# 6. Data Model

Schemas below are conceptual; exact column types/indexes are implementation work, but the entities and invariants are required.

## 6.1 `core.assets`

Canonical asset identity.

Key fields:

- `id`
- `chain = solana`
- `mint_address` UNIQUE
- `symbol`
- `name`
- `decimals`
- `token_program`
- `first_observed_at`
- `estimated_created_at`
- `status` — discovered / evaluating / eligible / blocked / retired
- metadata timestamps

Never identify a token by symbol alone.

## 6.2 `core.asset_eligibility`

Latest deterministic safety decision plus versioned history.

Fields include:

- asset id;
- evaluated_at;
- policy_version;
- eligible boolean;
- liquidity_usd;
- volume_24h_usd;
- holder_count;
- top-holder concentration;
- mint authority state;
- freeze authority state;
- Token-2022 risk extensions;
- honeypot/security flags;
- transfer restrictions/fees;
- Jupiter route availability;
- estimated price impact for standard test sizes;
- insider/dev/sniper/bundler metrics where available;
- rejection reason codes.

Eligibility is never merely an AI score.

Token-2022 assets with transfer-fee or transfer-hook behavior require an explicit compatibility state. All sizing and P&L use actual net balance deltas; a provider route being technically available does not by itself prove that a protective-order path supports that token.


Eligibility records also persist an **emergency exit route snapshot** for any asset considered for `LIVE_AUTO`: known direct-pool path(s) from the asset to SOL/USDC, pool/program ids, expected hop count, last on-chain refresh, quoted capacity/impact at configured emergency sizes, Token-2022 compatibility, and last dry-run result. Snapshot discovery happens during eligibility/held-asset revalidation, never for the first time during a panic exit.

## 6.3 `core.risk_cohorts`, `core.asset_cohort_memberships`, `risk.correlation_clusters`

Risk grouping is deterministic and versioned.

`core.risk_cohorts` defines human/provider taxonomy such as memes, liquid staking, DEX, DePIN, gaming or a narrower narrative group. `core.asset_cohort_memberships` records source, effective version and confidence/approval state.

`risk.correlation_clusters` stores deterministic rolling return-correlation clusters with calculation window/version. Portfolio risk may enforce limits against both taxonomy cohorts and empirical clusters.

LLM-suggested tags may be stored as inactive research suggestions but never become active membership automatically.

## 6.4 `market.candles`

Partitioned time-series OHLCV.

Suggested stored resolutions:

- 15s: short retention for currently tracked candidates/positions;
- 1m: primary intraday research series;
- 5m/15m/1h/4h: retained longer or derived.

Columns include provider, observed_at and event/bucket time.

## 6.5 `market.snapshots`

Compact point-in-time market state for a token:

- price;
- liquidity;
- volume windows;
- buy/sell counts/volume;
- relative volume;
- volatility/ATR;
- momentum windows;
- market cap/FDV if known;
- SOL-relative return;
- universe-relative strength;
- route/impact test results.

These snapshots are persisted whenever a candidate is scored and whenever a trade decision is made.

## 6.6 `intelligence.events`

Normalized evidence table for news/social/on-chain/catalyst items.

Fields:

- `id`
- `kind` — news/social/onchain/project/macro/listing/security/etc.
- `source_provider`
- `source_id`
- `source_url_hash`
- `source_published_at`
- `first_seen_at`
- `last_seen_at`
- `asset_ids[]` or relation table
- normalized title/summary where permitted;
- source quality;
- novelty score;
- sentiment dimensions;
- event classification;
- immutable payload hash;
- raw payload retention pointer if permitted.

Unique provider/source IDs prevent duplicate news from masquerading as independent evidence.

## 6.7 `intelligence.wallets`

Tracked wallet intelligence:

- wallet address;
- source of discovery;
- classifications — smart-money / whale / dev / insider / sniper / bundler / exchange / treasury / unknown;
- PnL windows;
- win rate where reliable;
- trade count;
- confidence in label;
- label source and first_seen timestamp.

A label is evidence with provenance, not permanent truth.

## 6.8 `signals.feature_snapshots`

Immutable feature vector generated for a token at a decision time.

This is the bridge between live trading and replay.

Include feature-engine version.

## 6.9 `signals.candidates`

Candidate lifecycle:

- id;
- asset;
- discovered_at;
- trigger family;
- scanner score;
- status — detected / enriching / rejected / agent_review / qualified / expired;
- feature snapshot id;
- eligibility evaluation id;
- expiry time;
- deterministic rejection reason.

A candidate should expire quickly if the market condition disappears.

## 6.10 `agents.runs`

Every model call:

- run id;
- candidate/trade id;
- role — trading proposer / action adversary / event classifier / summarizer;
- model provider/model;
- prompt/version;
- temperature/reasoning config;
- input evidence IDs;
- point-in-time cutoff;
- structured output;
- token/cost/latency metrics;
- success/failure;
- schema validation result.

Store prompts by version, not merely rendered strings.

## 6.10A `agents.skill_versions`

Immutable Trading Skill definitions. Store:

- skill id/name;
- semantic/version id;
- code/git SHA;
- tool-manifest version;
- guideline version;
- supported action types;
- workflow graph/version;
- context-builder version;
- proposer model policy;
- adversary policy requirement;
- status — draft / paper / eligible_live / retired;
- effective dates.

A live strategy always points to an immutable skill version.

## 6.10B `agents.tool_invocations`

Append-only record of every tool call made by the Trading Skill:

- agent run/action cycle;
- tool name/version;
- typed request hash;
- response/evidence references;
- point-in-time cutoff;
- latency/error;
- whether the tool was read-only or proposal-only.

The Trading Skill has no arbitrary HTTP, shell, SQL, wallet or signing tool.

## 6.10C `agents.automation_definitions`, `agents.automation_runs`

Versioned deterministic triggers that invoke the Trading Skill. Definitions include:

- trigger type;
- strategy + skill version;
- event/filter conditions;
- minimum interval/cooldown;
- priority;
- position/candidate scope;
- enabled mode(s);
- context deadline;
- last/next eligible invocation.

Runs record trigger event, point-in-time cutoff, skill invocation, resulting action cycle and disposition.

Agents cannot create or alter live automations.

## 6.10D `agents.action_cycles`, `agents.adversarial_reviews`

Every discretionary autonomous exposure decision is represented as an action cycle:

- trigger/automation id;
- candidate or position;
- strategy/skill/guideline versions;
- proposed action;
- proposer run id;
- adversary run id(s);
- review verdict and reason codes;
- revision round;
- final cleared/rejected/expired/`PROTECTION_ONLY` state;
- ordered evidence cutoff versions (`cutoff_v1`, `cutoff_v2`, ...);
- proposer/adversary run -> cutoff-version mapping;
- unresolved/budget/outage reason when review cannot clear;
- downstream risk evaluation/intent if any.

The **action cycle is canonical for the final action state**. `trading.proposals` is the immutable proposer/deterministic-strategy artifact referenced by the cycle; it does not independently override the cycle's final disposition.

This allows the UI and research layer to answer both "why did it trade?" and "why did it keep holding?".

## 6.11 `trading.proposals`

Structured AI or deterministic strategy proposal.

Fields:

- proposal id;
- candidate id;
- strategy version;
- source — AI / deterministic;
- action — ENTER / IGNORE / HOLD / REDUCE / EXIT / ADJUST_PROTECTION (and ADD only for a separately enabled future strategy);
- direction — LONG for v1 spot;
- thesis;
- evidence IDs;
- counter-evidence IDs;
- confidence;
- expected horizon;
- invalidation thesis;
- urgency;
- created_at;
- expires_at.

The proposal contains no executable wallet destination.

## 6.12 `trading.risk_evaluations`

Immutable deterministic decision:

- proposal id;
- policy version;
- allowed boolean;
- reason codes;
- current equity;
- current exposure;
- cohort/correlation exposure;
- strategy sleeve exposure;
- asset eligibility state;
- computed max loss;
- computed position amount;
- max slippage;
- stop policy;
- target/trailing policy;
- daily drawdown state;
- stale-data checks.

## 6.13 `trading.intents`

Canonical immutable desired action.

Contains:

- stable intent id;
- idempotency key;
- portfolio/account;
- strategy/sleeve;
- candidate/asset resolved server-side;
- action;
- input asset;
- output asset;
- exact maximum input amount;
- risk-evaluation reference;
- expiration;
- execution constraints;
- protective-exit policy reference;
- approval requirement.

A database intent row alone is **not** sufficient execution authority.

## 6.14 `trading.risk_authorizations`

The risk-authorizer canonicalizes the authorized fields and signs them with an asymmetric key unavailable to the database/web/general workers.

Store:

- intent id and immutable intent hash;
- action-cycle id + cleared cutoff version;
- Release id/digest + verified attestation reference;
- policy version/hash;
- strategy/sleeve id;
- input/output mints;
- action/side;
- maximum input amount;
- maximum permitted slippage/price impact/chase;
- expiry and nonce;
- allowed protective-order type;
- approval-required boolean;
- detached signature and signer key id.

Executor possession of the corresponding verification public key is sufficient to detect post-authorization DB tampering.

## 6.14A `risk.state_projections`

Append-only, signed current-risk projections emitted by the worker state projector for D21/D52. These are inputs to authorization, not authorizations themselves.

Each projection binds at minimum:

- monotonic projection sequence;
- projector key id/signature and canonical payload hash;
- source-event/state digest(s);
- chain slot and observed/as-of timestamps;
- wallet + registered-custody balances and settlement availability;
- aggregate non-settlement exposure;
- strategy sleeve usage and open-lot totals;
- drawdown/circuit-breaker state;
- cohort/correlation exposure/capacity;
- asset eligibility/freshness summary for referenced candidates;
- critical provider/data freshness summary.

The risk-authorizer requires a fresh valid projection, rejects sequence rollback/replay, and independently verifies chain-verifiable D45 fields and wallet/custody balances before exposure-increasing authorization. Projection signatures make database-only mutation detectable; they do not make a compromised worker trustworthy.

## 6.15 `trading.approvals`

For `LIVE_APPROVAL`, an approval is short-lived and binds to the exact `risk_authorization` envelope hash.

Fields include:

- authorization hash;
- intent id;
- approver;
- operator role;
- step-up credential/assertion reference for exposure-increasing approval;
- granted_at;
- expires_at;
- nonce;
- approval-service signature/key id;
- revoked_at if applicable.

Changing any authorized field requires a new risk authorization and therefore a new approval.

## 6.16 `trading.strategy_sleeves`, `trading.position_lots`

`strategy_sleeves` defines each live strategy’s capital allocation/risk budget inside the one physical wallet.

`position_lots` attributes physical holdings to strategy-originated lots, including quantity, cost basis, entry intent, realized P&L and exit allocation. The aggregate of open lots for an asset must reconcile to the physical wallet + registered custody balance, subject only to explicitly modeled dust/fees.

## 6.17 `trading.custody_accounts`

Registry of known balance locations:

- primary trading wallet;
- associated token accounts;
- registered Jupiter Trigger vault;
- future explicitly approved custody locations.

Each has owner/provider, address, allowed movement types, active dates and verification state. D9 treats movements to/from these accounts as expected only when tied to an authorized lifecycle.

## 6.17A `ops.wallet_funding_events`

Audit/reconciliation record for **manual browser-wallet funding only**. It is not an execution authorization and is never consumed as authority by the risk-authorizer or executor.

Store:

- operator user id;
- connected source-wallet public key;
- configured destination trading-wallet address;
- funding asset/mint;
- requested amount;
- canonical destination ATA where applicable;
- deployment cluster;
- state — `PREPARED`, `WALLET_PROMPTED`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `ABANDONED`;
- submitted transaction signature;
- confirmed source/destination balance deltas;
- created/submitted/confirmed timestamps;
- failure reason.

A funding event becomes `CONFIRMED` only from chain reconciliation, not merely because the browser/wallet provider reported success. No secret/seed/session capability from the connected wallet is persisted.

Every confirmed funding event immediately recomputes D56's recognized custody value. If the capital attestation ceiling is exceeded, `CAPITAL_REATTEST_REQUIRED` blocks the next exposure-increasing action until operator step-up re-attestation or a risk-reducing sweep restores the account below the ceiling.

## 6.18 `trading.orders`, `trading.order_attempts`, `trading.fills`

Separate desired order from network attempts and actual fills.

`order_attempts` must persist the pre-submit execution record **before** network submission:

- intent/risk-authorization hash;
- Jupiter `requestId`/router when applicable;
- signed transaction hash;
- locally known wallet signature and expected transaction signature when derivable;
- blockheight/quote expiry;
- `SIGNED_NOT_SUBMITTED` timestamp/state;
- submission attempts/results;
- provider response signature;
- reconciliation outcome.

A failed network request does not mean a failed trade until the transaction is reconciled on-chain.

## 6.19 `trading.positions`

Fields:

- account;
- asset;
- aggregate quantity;
- average entry;
- cost basis;
- realized/unrealized PnL;
- current stop/target state;
- custody split — wallet / registered provider vault;
- status;
- strategy-lot references;
- opened/closed times.

## 6.20 `trading.portfolio_snapshots`

Periodic equity/exposure/PnL snapshots for drawdown and performance analysis, including per-strategy sleeve and per-risk-cohort exposure.

## 6.21 `research.strategy_versions`

Immutable strategy configuration:

- code version/git SHA;
- feature version;
- prompt versions;
- model selections;
- threshold config;
- risk policy reference;
- active dates;
- status — experimental / paper / eligible_live / retired.

## 6.16A `research.releases`, `research.release_attestations`

`research.releases` stores the immutable digest/binding tuple used for live change control:

- release id/digest;
- strategy version;
- Trading Skill/guideline/automation-set versions;
- proposer/adversary model-policy versions;
- risk/cohort/freshness policy versions;
- executor-policy reference;
- status — draft / paper_validated / eligible_live / armed / retired;
- created/promoted times.

`research.release_attestations` stores the step-up/WebAuthn promotion/arming evidence bound to the exact Release digest, operator identity/role, credential id/fingerprint, challenge, verification result and expiry where applicable.

## 6.16B `ops.spend_budgets`, `ops.spend_usage`

Versioned budget policy and current usage for model calls, action-cycle rate, provider requests and attributable/shared operating cost. Budget state is consumed by the automation runtime and System Health rather than enforced only in UI.

## 6.16C `trading.position_shadow_journal`

A durable operational mirror (also persisted locally by worker/executor) of the minimum state required to continue deterministic protection during a Postgres outage:

- account/asset/lot ids and last chain-confirmed quantities;
- deterministic stop/trail/time-stop state and `unreviewed_stop`;
- protection/custody mode and provider order ids;
- last validated primary/emergency exit-route snapshot ids;
- version/sequence/hash;
- created/synchronized time.

It is not authority for quantity: chain/custody truth still caps emergency sells.

## 6.16D `ops.notifications`, `ops.notification_deliveries`

Persist alert severity/class, acknowledgement/escalation state, delivery attempts/channel confirmation, dead-man deadline and resulting automated `PAUSE_NEW_ENTRIES` action where applicable.

## 6.22A `ops.runtime_sessions`

Durable session/activity record:

- session id;
- deployment/profile id (`P0`, `P1A`, `P1B`, `P2`, `P3`, `P4`);
- activity state (`OFF`, `STARTING`, `WATCH`, `ACTIVE`, `EVENT_WINDOW`, `WIND_DOWN`);
- capital authority (`OBSERVE`, `PAPER`, `LIVE_APPROVAL`, `LIVE_AUTO`);
- sticky `PAUSED` override state/reason;
- operator-attended flag and last presence heartbeat where required;
- scheduled/session start and intended end;
- actual start/end;
- active market-session labels/regime snapshot;
- catalyst/event-window reference and source-time deadline where applicable;
- cold-start/warm-up gate results;
- D61 unmanaged/offline-protected exposure count/value at each transition;
- wind-down blockers/in-flight execution ids;
- planned offline resume deadline for any `OFFLINE_PROTECTED` lots;
- external resume-watchdog expected/check status and last successful check when an offline deadline exists;
- actor/automation that caused each transition.

Every transition is audited. `OFF` with unmanaged exposure is invalid.

## 6.22 `audit.events`

Append-only security/control ledger:

- mode changes;
- live arming;
- approvals/rejections;
- risk setting changes;
- kill switch;
- secret/provider changes without secret values;
- execution errors;
- reconciliation anomalies;
- admin actions.

---

# 7. Token Universe and Eligibility Engine

## 7.1 Two universes

Maintain:

### Discovery universe
Broad and noisy. Tokens can enter through:

- trending tokens;
- volume acceleration;
- price acceleration;
- smart-money activity;
- holder growth;
- social acceleration;
- news/catalyst mention;
- manually watched mints.

### Tradable universe
Only tokens that pass deterministic eligibility.

A token can be `DISCOVERED` but not `ELIGIBLE`.

## 7.1A Security-field authority

Hard on-chain facts are decoded directly from Solana account/RPC state first: mint/freeze authority, token program, Token-2022 extensions, transfer-fee/transfer-hook configuration and program ownership. Analytics-provider copies are corroboration only and cannot override chain truth.

Chain-verifiable concentration uses mint supply plus direct largest-token-account balances (top-1/top-5/top-10/top-20). Full holder count/distribution, beneficial-owner clustering and related-wallet aggregation remain indexed/analytics-derived and are labeled accordingly. Material disagreement on a chain-verifiable metric blocks new entry. Dev/insider/bundler/smart-money labels remain analytics-derived evidence and strategies that require them fail closed when those labels are unavailable/stale. Liquidity/exitability is proven from direct pool state plus executable route probes.

## 7.2 Eligibility policy categories

Exact numeric thresholds are configuration, not hardcoded blueprint constants.

Required gates:

### Identity/security

- valid Solana mint;
- recognized token program;
- inspect mint/freeze authority;
- inspect Token-2022 extensions where applicable;
- reject known honeypot/transfer-block risks;
- evaluate permanent delegate/transfer-hook/transfer-fee implications;
- token-security provider response is fresh.

### Liquidity/execution

- minimum usable liquidity;
- minimum recent real volume;
- viable Jupiter route;
- maximum simulated/quoted price impact at proposed size;
- confirmed ability to route token back to SOL/USDC;
- spread/route quality within policy.

### Ownership

- top-holder concentration policy;
- holder-count floor;
- dev/insider/bundler/sniper concentration;
- suspicious synchronized wallet behavior flags.

### Age/stability

- default minimum token age for autonomous eligibility;
- manual override class for deliberately testing younger assets;
- newly discovered tokens require repeated safety checks before promotion.

### Manipulation

- wash-trading indicators;
- abrupt liquidity changes;
- volume unsupported by holder/trader distribution;
- price movement isolated to poor-quality pools.

## 7.3 Eligibility score vs hard rejects

Do not reduce everything to one score.

Some conditions are hard rejects regardless of momentum:

- cannot demonstrate exit route;
- unacceptable freeze/transfer restriction;
- liquidity below hard floor;
- price impact over hard limit;
- stale critical security data;
- explicitly denylisted asset.

Other factors contribute to an eligibility/risk grade.

## 7.4 Re-evaluation

Eligibility must be refreshed:

- periodically for all tradable tokens;
- immediately before entry;
- after material liquidity change;
- after security/provider alert;
- after large dev/insider movement;
- while a position is open if relevant.

A token can become ineligible while held. This should normally prevent adding and may trigger an exit policy depending on the reason.

## 7.5 Open-position safety and exit compatibility

For every open position, maintain a current `position_safety_state` distinct from entry eligibility. Re-evaluate on:

- periodic safety heartbeat;
- material liquidity/volume change;
- authority/Token-2022 metadata change;
- provider security alert;
- route loss or large price-impact change;
- holder/concentration shock;
- every requested exit.

States include `NORMAL`, `DEGRADED`, `EXIT_RECOMMENDED`, and `CRITICAL_EXIT`.

An entry-eligibility failure while held must never mechanically prevent an exit. Exit logic asks which approved route can reduce exposure now and escalates to the emergency-exit adapter if necessary.

---

# 8. Market Feature Engine

All classic technical analysis belongs here, not in the LLM.

## 8.1 Price/momentum features

Compute at multiple horizons:

- return: 15s / 1m / 3m / 5m / 15m / 30m / 1h / 4h;
- acceleration of return;
- ATR / normalized volatility;
- realized volatility;
- RSI;
- EMA relationships;
- MACD;
- Bollinger location/width;
- VWAP distance;
- local high/low breakout;
- breakout/retest state;
- trend persistence;
- drawdown from local high;
- candle body/wick behavior.

## 8.2 Volume/flow

- relative volume vs rolling baseline;
- buy vs sell volume;
- trade count acceleration;
- average trade size;
- large-trade share;
- unique buyer/seller acceleration where available;
- volume-price divergence.

## 8.3 Liquidity/executability

- liquidity level/change;
- estimated spread;
- quoted price impact at multiple standard sizes;
- route diversity;
- route degradation;
- failed quote frequency.

## 8.4 Relative strength and deterministic cohorts

Every token is compared against:

- SOL;
- eligible Solana universe;
- active versioned taxonomy cohort(s);
- deterministic rolling correlation cluster where available.

A +4% token is less interesting if its whole cohort is +8%.

The feature engine never asks an LLM to assign the live cohort used by portfolio risk.

## 8.5 Regime model

Deterministically classify broad market regime, e.g.:

- risk-on trend;
- broad selloff;
- SOL-led rally;
- meme/narrative rotation;
- low-liquidity chop;
- volatility shock;
- post-event instability.

The regime can suppress or modify strategy eligibility.

## 8.6 Self-influence guard

All application-controlled wallet/vault addresses are tagged as `OWNED`. Their transfers, swaps and wallet PnL are excluded from smart-money, whale-flow and holder-behavior features.

After our own fill in an asset:

- known self-flow is subtracted where the raw source allows it;
- a candidate cannot use the just-created self transaction as a qualifying on-chain event;
- if aggregate provider volume/price metrics cannot isolate our trade, candidate confirmation for that token is suppressed or re-baselined for a configured short window proportional to our estimated market impact;
- strategies that were already evaluating the same pre-trade snapshot may complete, but a later strategy cannot treat our fill as fresh confirmation.

---

# 9. Candidate Detection

Candidate detection should be cheap, frequent and explainable.

Example trigger families:

## 9.1 Momentum continuation

Conditions may include:

- abnormal short-horizon return;
- relative volume expansion;
- breakout or trend continuation;
- liquidity adequate;
- relative strength vs SOL/universe;
- not yet excessively extended by configurable volatility measure.

## 9.2 Early acceleration

Search for increasing slope/flow before an obvious breakout rather than only buying after a large move.

## 9.3 Smart-money accumulation

- multiple independently high-quality wallets buying;
- accumulation not dominated by known related/insider wallets;
- market structure confirms rather than contradicts.

## 9.4 Catalyst response

A fresh news/project/listing/security event followed by market confirmation.

## 9.5 Social acceleration

Social mention/contributor velocity rises materially above baseline, but a candidate does not become tradeable based on social data alone.

## 9.6 Holder/liquidity expansion

Rapid holder growth + healthy liquidity growth + price confirmation.

## 9.7 Candidate deduplication/cooldown

Do not invoke five analyses for the same ongoing move.

Candidate state should aggregate related triggers inside a configured window unless genuinely new evidence arrives.

---

# 10. Intelligence Layer

## 10.1 Event normalization

Every source event should be transformed into a common record describing:

- what happened;
- affected asset(s);
- when source says it happened;
- when we first saw it;
- source quality;
- novelty;
- direction/sentiment if appropriate;
- likely time horizon;
- corroboration/duplication relationships.

## 10.2 News deduplication

Ten sites repeating the same press release is one catalyst, not ten.

Cluster by:

- canonical URL/source;
- title/text similarity;
- underlying event/entity/time;
- source-chain lineage where detectable.

## 10.3 Novelty, source time and catalyst age

Every normalized event retains both **source/event time** (when the underlying information/event occurred or was published, with confidence/provenance) and **`first_seen_at`** (when our system first had access to it).

The AI receives explicit first-seen information and recent related events so it can distinguish:

- genuinely new catalyst;
- confirmation of known catalyst;
- recycled story;
- social rediscovery of old news.

These clocks serve different purposes:

- replay/availability truth uses `first_seen_at <= simulated_decision_time`;
- catalyst age, half-life and `EVENT_WINDOW` expiry use trustworthy source/event time;
- ingesting a six-hour-old article at session start does not make it a fresh six-minute-old catalyst;
- missing/low-confidence source time cannot silently fall back to `first_seen_at` for a high-speed catalyst strategy; use conservative policy or corroborated real-time evidence.

A later new source event can extend/create a window only as a separately stored event, never by rewriting the old event's timestamp.

## 10.4 Source quality

Maintain source classes such as:

- official project;
- official exchange/protocol;
- primary government/regulatory;
- reputable financial/crypto publication;
- analytics provider;
- identified creator;
- unknown social source.

Quality influences reasoning but does not mechanically dictate direction.

---

# 11. Agent Runtime, Trading Skill and Adversarial Loop

The agent layer is an autonomous decision system, not a chatbot prompt. It is capable of initiating and managing trades in `LIVE_AUTO`, but it remains bounded by tool permissions, mandatory adversarial review and deterministic risk authorization.

## 11.1 Four artifacts: strategy, skill, guidelines, automations

These must remain conceptually separate:

| Artifact | Purpose | May agent modify live? |
| --- | --- | --- |
| **Strategy** | Defines the economic hypothesis, trigger family, parameters, speed tier and promotion status | No |
| **Trading Skill** | Defines how the agent investigates, proposes and manages a trade using approved tools/workflows | No |
| **Guidelines** | Defines reasoning behavior, evidence discipline, escalation rules and stylistic/decision constraints | No |
| **Automations** | Defines when the skill is invoked by market/position/system events or periodic reassessment | No |
| **Risk policy** | Defines hard deterministic limits and sizing | No |
| **Execution adapter** | Converts authorized intents into validated transactions | No |

A live autonomous strategy is therefore a binding of immutable versions:

```text
StrategyVersion
  + TradingSkillVersion
  + GuidelineVersion
  + AutomationSetVersion
  + RiskPolicyVersion
  + ModelPolicyVersion
  + ExecutionPolicyVersion
```

Changing any one creates a new research/live version rather than silently changing behavior.

## 11.2 LLM/model gateway

Models are provider-pluggable.

Required interface:

```ts
interface ReasoningModel {
  proposeTradingAction(input: TradingSkillContext): Promise<TradingActionProposal>
  adversariallyReviewAction(input: AdversarialReviewInput): Promise<AdversarialReview>
  classifyEvent(input: EventInput): Promise<EventClassification>
  summarizeEvidence(input: EvidenceInput): Promise<EvidenceSummary>
}
```

The strategy/action record stores exact provider/model identifiers. The proposer and adversary may use different models/providers so the review is not merely the same prompt paraphrased twice.

## 11.3 Trading Skill — purpose

The Trading Skill gives the autonomous agent a bounded operational capability across the full position lifecycle.

It must be able to:

1. inspect a qualified candidate and its point-in-time evidence;
2. determine whether a trade thesis exists;
3. propose an entry or ignore decision;
4. monitor/reassess an existing position when invoked;
5. explicitly propose `HOLD`, `REDUCE`, or `EXIT`;
6. propose tightening or replacing protection where allowed;
7. detect thesis invalidation/catalyst decay/regime conflict;
8. request fresh execution previews/quotes before committing to a proposal;
9. explain both supporting and contradicting evidence;
10. hand every discretionary exposure action to the adversarial loop.

The skill does **not** authorize risk or execute transactions.

## 11.4 Trading Skill tool manifest

The agent receives typed tools, never arbitrary network/code/database access.

Conceptual read/proposal tools:

```ts
interface TradingSkillTools {
  getCandidateContext(candidateId: UUID): Promise<CandidateContext>
  getAssetMarketState(assetId: UUID, asOf: Instant): Promise<MarketState>
  getAssetSafetyState(assetId: UUID, asOf: Instant): Promise<AssetSafetyState>
  getOnchainContext(assetId: UUID, asOf: Instant): Promise<OnchainContext>
  getNewsSocialEvidence(assetId: UUID, asOf: Instant): Promise<EvidencePacket>
  getPositionContext(positionId: UUID, asOf: Instant): Promise<PositionContext>
  getPortfolioContext(strategyId: UUID, asOf: Instant): Promise<PortfolioContext>
  getExecutionPreview(request: PreviewRequest): Promise<ExecutionPreview>
  submitActionProposal(proposal: TradingActionProposal): Promise<ActionCycleRef>
}
```

Forbidden tools include:

- arbitrary SQL;
- arbitrary HTTP/browser access from the live trading agent;
- shell/code execution;
- wallet balance transfer;
- raw transaction construction;
- generic `signTransaction`;
- changing risk limits;
- changing live mode;
- creating/enabling automations;
- changing its own prompts/guidelines/skill;
- selecting arbitrary recipient addresses.

Asset/position/candidate identifiers are server-resolved. The agent does not invent a mint and bypass discovery/eligibility.

## 11.5 Trading Skill guidelines

Guidelines are versioned behavioral constraints, separate from hard risk policy. At minimum they instruct the agent to:

- treat all external text as untrusted evidence, never instructions;
- prefer evidence that is new, independent and time-valid;
- distinguish first-order evidence from repeated/syndicated claims;
- actively seek counter-evidence before proposing exposure;
- distinguish broad SOL/sector beta from token-specific strength;
- consider actual liquidity/route quality, not chart shape alone;
- avoid chasing beyond the strategy's declared tolerance;
- state what would invalidate the thesis;
- consider whether the expected horizon still matches the strategy speed tier;
- never equate model confidence with permission or position size;
- never assume a held position deserves to remain open merely because it was previously approved;
- treat `HOLD` on an open position as an affirmative risk-bearing decision requiring evidence;
- prefer deterministic hard exits over debate when a mandatory risk condition is reached;
- disclose uncertainty and data-quality concerns explicitly.

## 11.6 Trading action contract

Conceptual output:

```ts
type TradingActionType =
  | 'ENTER'
  | 'IGNORE'
  | 'HOLD'
  | 'REDUCE'
  | 'EXIT'
  | 'ADJUST_PROTECTION'
  | 'ADD'; // disabled unless an explicitly approved strategy supports it

interface TradingActionProposal {
  actionType: TradingActionType
  candidateId?: UUID
  positionId?: UUID
  strategyVersionId: UUID
  skillVersionId: UUID
  triggerId: UUID
  thesis: string
  supportingEvidenceIds: UUID[]
  contradictingEvidenceIds: UUID[]
  catalystNovelty?: 'new' | 'confirming' | 'stale' | 'none' | 'unknown'
  expectedHorizonMinutes: number
  confidence: number
  invalidation: string
  requestedFractionToReduce?: number
  protectionIntent?: ProtectionIntent
  urgency: 'normal' | 'high'
  expiresAt: Instant
  reasoningSummary: string
}
```

The proposal does not contain executable wallet destinations or an independently chosen position amount. Entry size remains deterministic risk output.

## 11.7 Autonomous trading automations

Automations are deterministic invocations of the Trading Skill. They are not free-form instructions written by the agent.

Required trigger families:

### Candidate triggers

- scanner score crosses strategy threshold;
- fresh catalyst appears for an eligible asset;
- smart-money flow crosses configured threshold;
- candidate receives meaningful new evidence before expiry;
- candidate survives a deterministic breakout/retest condition.

### Open-position triggers

- periodic reassessment heartbeat appropriate to strategy speed tier;
- price excursion threshold;
- profit target/trailing milestone;
- volatility regime shift;
- material liquidity/route degradation;
- smart-money reversal/distribution;
- new token/security evidence;
- new catalyst or catalyst invalidation;
- expected-horizon/time-stop checkpoint;
- protective-order state change;
- position recovery after worker restart.

### System triggers

- provider/data health degradation affecting a strategy;
- strategy sleeve becomes constrained;
- self-influence suppression window ends and evidence is re-baselined.

Automations can enqueue analysis; they cannot bypass eligibility, adversarial review, risk authorization or mode gates.

### Automation/spend budgets

Before starting a discretionary cycle, automation runtime checks strategy/hour cycle budget, per-strategy/day model budget, platform/day model budget and provider request/rate budgets. Breach creates `BUDGET_PAUSED`; new candidate cycles stop and open positions enter `PROTECTION_ONLY`. Mandatory deterministic exits and already-installed protection do not depend on discretionary model budget.

## 11.8 Mandatory adversarial action loop

Every discretionary autonomous exposure decision follows:

```text
Automation / event
      ↓
Point-in-time context builder
      ↓
Trading Skill proposer
      ↓
Structured action proposal
      ↓
Independent Action Adversary
      ↓
 CONFIRM ───────────────→ deterministic risk/policy
 CHALLENGE → proposer revision → adversary re-review
 REJECT ────────────────→ no discretionary action
```

The adversary's job is not to be generally pessimistic. It must test whether the **specific proposed action** survives hostile scrutiny.

Required checks include:

- stale or circular evidence;
- overextension/chase;
- contradictory market regime;
- liquidity/route degradation;
- ownership/insider changes;
- self-influence contamination;
- catalyst already priced in;
- manipulated social activity;
- position thesis no longer matching actual facts;
- proposed `HOLD` ignoring emerging downside;
- proposed exit occurring from temporary noise rather than invalidation;
- protection change that would loosen risk beyond policy;
- expected edge after actual execution cost;
- opportunity likely to expire before execution.

## 11.9 Adversarial-loop rules

- The proposer and adversarial control use an explicit evidence cutoff version.
- The adversary cannot add future evidence or browse outside the evidence boundary.
- A permitted refresh creates `cutoff_vN+1`; it invalidates clearance of the older proposal. The proposer revision and the next adversarial review must both use the refreshed cutoff.
- The action cycle stores every cutoff version and which runs consumed it for replay.
- The adversary never edits the proposal directly.
- `CHALLENGE` returns typed objections to the proposer.
- Maximum normal LLM revision rounds: 1 additional proposal/review cycle. T0 deterministic gates do not invent a revision loop unless the strategy contract defines one.
- For a candidate/entry, unresolved challenge/reject/outage/timeout/budget exhaustion = no discretionary trade.
- For an open position, the same unresolved states transition it to `PROTECTION_ONLY` under D39; they do not fabricate a cleared `HOLD` or discretionary exit.
- The adversary cannot turn an `IGNORE` candidate into a trade by itself; it can only review submitted exposure decisions.
- The final risk engine consumes only an action cycle adversarially cleared for the current cutoff version.
- Every strategy speed tier includes the adversarial control in its latency budget. If the budget expires, the cycle expires rather than bypassing the control.

## 11.10 Mandatory/non-discretionary actions

The adversarial loop is intentionally non-blocking for hard risk reduction.

Examples:

- stop price reached;
- portfolio drawdown circuit breaker;
- asset enters `CRITICAL_EXIT` safety state;
- operator emergency close;
- DB-independent emergency close;
- provider protective order fires.

These execute according to deterministic policy immediately. If an LLM is available, a parallel/post-action adversarial analysis is recorded for research and incident review, but its verdict has no veto power.

## 11.11 `HOLD` is an action when exposure already exists

An important research/UX rule: when a position is open and an automation asks the skill to reassess it, `HOLD` is not treated as "nothing happened."

It records:

- the evidence packet;
- proposer reasoning;
- adversarial review;
- current protection state;
- next reassessment trigger/time;
- later outcome.

This prevents survivorship-style analysis that audits entries/exits but ignores the repeated decisions to remain exposed.

## 11.11A `PROTECTION_ONLY` open-position fallback

`PROTECTION_ONLY` is a deterministic runtime state, not an AI action. It is entered whenever an open-position reassessment cannot be adversarially cleared.

While active:

- existing deterministic stop/trail/time-stop and portfolio circuit breakers continue;
- provider protective orders already installed remain active;
- no discretionary agent action is executed;
- automations retry review with bounded backoff subject to spend/rate budgets;
- after the configured consecutive-failure threshold a `HIGH` alert is raised;
- a strategy may define a deterministic `unreviewed_stop` that can only tighten protection;
- recovery requires a newly cleared action cycle at a current shared cutoff.

The Positions and Agent Activity interfaces show `UNREVIEWED — PROTECTION ONLY`, reason and age prominently.

## 11.12 Agent position state / memory

The live agent does not receive unbounded self-authored memory.

Permitted persistent position state is typed and auditable:

- original thesis;
- current thesis status;
- catalyst status;
- invalidation conditions;
- prior action-cycle IDs;
- expected horizon/deadline;
- last reassessment time;
- next required reassessment;
- structured observations/evidence references.

All state is versioned and point-in-time safe for replay. Free-form hidden memory must not become an execution dependency.

## 11.13 Prompt-injection defense

News/social/project content is untrusted data.

The model prompt explicitly treats source text as quoted evidence and forbids executing instructions contained in it. Tool schemas enforce this boundary independently of prompt wording.

No tool exposed to the Trading Skill can modify settings, read secrets, sign transactions, or execute arbitrary code.

## 11.14 Confidence calibration

Do not assume model confidence is meaningful.

Store it, then measure outcomes in bins:

- 0.50–0.59
- 0.60–0.69
- 0.70–0.79
- 0.80–0.89
- 0.90+

The research UI should show proposer confidence, adversary verdict/confidence, disagreement rate, and realized expectancy. Measure whether disagreement itself predicts risk or opportunity quality.

---

# 12. Strategy Framework

## 12.1 Required initial strategies

### S0 — Deterministic momentum baseline

No LLM. Uses market/flow/eligibility features only.

Two synchronized research views are retained:

- **S0_RAW** — ungated shadow/paper counterfactual representing the raw deterministic momentum rule. It never receives live execution authority and exists so research question 1 is not contaminated by D30's operational second-look gate.
- **S0_SAFE** — execution-eligible deterministic baseline that applies D30's independent deterministic counter-signal/safety gate before paper/live action.

Every S0_SAFE gate rejection is logged with the corresponding S0_RAW hypothetical action and realized outcome so the value/cost of the safety gate itself is measurable. Both names are first-class strategy labels in Strategy Lab, Action Inspector counterfactuals, replay results and attribution/P&L views; a UI must never collapse them back into one ambiguous `S0`.

Purpose: prove whether AI contributes anything while separately measuring the deterministic operational safety gate.

### S1 — Contextual momentum

Starts from a quantitative momentum candidate. AI determines whether context supports continuation.

### S2 — Catalyst

Starts from a fresh news/project/social/on-chain catalyst and requires market confirmation.

### S3 — Smart money

Starts from independently successful wallet accumulation and checks market/liquidity context.

### S4 — Hybrid ensemble

Requires aligned evidence across at least two independent families and uses AI to assess coherence.

## 12.2 Strategy isolation and live capital allocation

Each strategy receives:

- same market clock;
- same point-in-time eligible universe;
- same cost assumptions;
- its own virtual portfolio in paper/replay;
- a versioned live capital sleeve if promoted;
- versioned parameters.

In live mode the physical wallet is shared, but allocation is not implicit. The deterministic capital allocator applies:

1. strategy sleeve available capital/risk;
2. per-token and per-cohort limits;
3. global wallet reserve and portfolio limits.

Global limits always win.

If multiple strategies own the same asset, each entry creates a separate strategy lot. Exits specify which lots are being reduced; the execution layer may aggregate compatible simultaneous sells only if accounting preserves exact lot attribution.

Provider protection is lot-scoped under D44. Each provider order/sub-account is mapped to one strategy lot/sub-lot and may consume only its reserved quantity. If the selected provider protection mode cannot preserve that isolation for same-mint concurrent strategies, those lots use `MONITORED_EXIT` rather than a shared mint-wide provider stop.

## 12.3 Strategy execution contract

Every strategy version declares:

- Trading Skill version (or `NONE` for deterministic S0);
- guideline version;
- automation-set version;
- risk-policy version;
- speed tier (`T0_FAST`/`T1_MOMENTUM`/`T2_CONTEXTUAL`/`T3_CATALYST`);
- maximum decision latency;
- maximum candidate age;
- maximum quote age;
- chase tolerance;
- allowed action types;
- open-position reassessment cadence/trigger policy;
- adversarial proposer/reviewer model policy;
- allowed/blocked market-session and day-of-week rules;
- minimum activity/volatility/breadth regime conditions;
- scheduled-window behavior outside preferred hours (`WATCH`, `NO_NEW_ENTRIES`, research-only PAPER);
- cold-start warm-up requirements;
- `EVENT_WINDOW` maximum duration/extension policy;
- offline-protection permission and maximum offline duration;
- attended-presence requirement by deployment profile.

A strategy whose decision arrives after its own latency/candidate-age contract expires produces an `EXPIRED` action cycle, not a late trade.

Each strategy also declares a `human_reaction_floor_ms`. If its live intent expiry is shorter than that floor, the strategy is not eligible for `LIVE_APPROVAL`; it may remain PAPER/OBSERVE or eventually use `LIVE_AUTO` after promotion/readiness. Exposure-reducing cleared actions may be configured to auto-execute in `LIVE_APPROVAL` and default to doing so.

## 12.3A Session and event-window policy

Trading schedules are **entry policy**, not an assumption that crypto is closed outside conventional market hours. Strategies may be active around Asia, Europe, US, overlap, weekends or custom windows, and the runtime records the market-session/regime context of every candidate whether or not that strategy is allowed to trade it.

`EVENT_WINDOW` is deterministic runtime state. The Trading Skill may propose one from a fresh catalyst, but the strategy/automation policy sets:

- trustworthy source-time T0;
- maximum duration;
- allowed entry/reassessment cadence;
- whether a confirmation/retest is required after the initial fast period;
- maximum extensions and what constitutes genuinely new information;
- expiry behavior (`WATCH` or ordinary `ACTIVE`).

A schedule can activate a strategy or move it back to `WATCH`; it cannot clear `PAUSED`, widen capital authority, bypass `STARTING`, or extend stale catalyst age.

Attended live profiles and unattended PAPER are deliberately both supported. Attended live reduces financial-operational risk during early testing; unattended PAPER later samples market sessions the operator is not awake for so session-performance research is not attendance-biased.

## 12.4 Ensemble/live promotion

No strategy becomes live merely because it had a good week.

Promotion evidence should include:

- minimum trade count;
- positive expectancy after cost;
- acceptable drawdown;
- robustness across more than one regime;
- no single-token dependence;
- adequate live-paper/shadow performance;
- stable result under modest parameter perturbation.

Exact thresholds are research configuration.

---

# 13. Risk Engine

This is deterministic code with tests and versioned policy. Its output is not merely a database row: approved live intents are cryptographically authorized as described in §15.

## 13.1 Portfolio-level rules

Configurable controls include:

- maximum total portfolio exposure;
- minimum uncommitted SOL/USDC reserve;
- maximum number of open positions;
- maximum exposure per token;
- maximum exposure to one active taxonomy cohort;
- maximum exposure to one deterministic return-correlation cluster;
- maximum allocation/risk per promoted strategy sleeve;
- maximum daily realized + unrealized drawdown;
- maximum rolling drawdown;
- maximum consecutive-loss circuit breaker;
- cooldown after circuit breaker;
- no new entries while system health is degraded.

Cohort memberships and correlation-cluster versions are stored inputs to the risk evaluation. LLM output cannot create or override them.

## 13.2 Trade-level rules

- token currently eligible;
- proposal not expired;
- source data fresh;
- quote fresh;
- price has not moved beyond chase tolerance since proposal;
- expected price impact below hard ceiling;
- slippage below hard ceiling;
- Token-2022 transfer behavior compatible with selected execution/protection path;
- minimum expected reward relative to deterministic stop distance;
- position sizing respects strategy sleeve and global risk budget;
- available balance confirmed across wallet + registered custody;
- duplicate intent absent.

## 13.3 Position sizing

Position size is calculated from equity, hard exposure caps, strategy sleeve and stop/invalidation distance.

Conceptually:

```text
risk_budget = min(portfolio_equity * risk_per_trade, strategy_sleeve_risk_remaining)
size_by_stop = risk_budget / stop_distance_fraction
final_size = min(
  size_by_stop,
  strategy_sleeve_cap,
  max_position_value,
  cohort_remaining_cap,
  correlation_cluster_remaining_cap,
  liquidity_based_cap,
  available_capital
)
```

The agent does not choose `risk_per_trade` or its sleeve.

## 13.4 Stops

Support stop models:

- volatility/ATR;
- structure low;
- percentage cap;
- strategy-specific invalidation translated into deterministic price logic where possible.

Every live autonomous entry requires a defined exit policy before execution.

## 13.5 Take-profit / trailing policy

Support:

- fixed R multiples;
- partial profit tiers;
- trailing stop after threshold;
- volatility trail;
- momentum-decay exit;
- time stop;
- emergency risk exit.

A strategy declares the policy type; the runtime computes and enforces it.

## 13.6 Kill conditions

Immediate new-entry pause on:

- portfolio drawdown limit;
- wallet/custody mismatch;
- stale primary and required secondary market feeds;
- database unavailable for normal durable ledger;
- repeated execution anomalies;
- provider authentication failure affecting safe operation;
- clock drift beyond tolerance;
- explicit operator kill switch from either normal or out-of-band control path.

## 13.7 Executor absolute caps

The execution service has deployment-level non-database upper bounds, including at minimum:

- maximum input notional per live entry;
- maximum aggregate non-settlement exposure;
- maximum signer-outage unprotected (`MONITORED_EXIT`) exposure;
- allowed settlement mints;
- allowed chain/network;
- maximum emergency-close transaction size if less than full position;
- accepted risk-authorization signer public keys;
- accepted operator emergency-control public keys.

Versioned database risk policy can always be **stricter** than these values but cannot make the executor exceed them. Raising an executor cap requires a deliberate deployment/configuration change, not a database edit.

The executor does not rely on a mutable database dollar total to enforce `maximum aggregate non-settlement exposure`. It maintains an append-only local `ExecutorExposureLedger` from its own confirmed entry/exit/protective-fill observations and reconciled quantities. The hard cap uses conservative open **cost basis / authorized entry notional** as the DB-independent primary measure; current Jupiter/secondary price may be used only as an additional sanity/mark-to-market escalation check. On disagreement, the larger/conservative exposure view is used and new entries fail closed.

The same local ledger tracks signer-dependent `MONITORED_EXIT` exposure for D33/D51's unprotected-exposure cap.

---

# 14. Trade Lifecycle

## 14.1 Autonomous discretionary entry flow

```text
Candidate detected
  -> eligibility fresh/pass
  -> strategy automation fires
  -> Trading Skill context assembled with point-in-time cutoff
  -> proposer emits ENTER or IGNORE
  -> ENTER enters mandatory Action Adversary review
      -> CONFIRM, or
      -> CHALLENGE -> one revised proposal -> re-review, or
      -> REJECT/timeout -> no trade
  -> deterministic risk evaluation + strategy sleeve allocation
  -> signed risk authorization envelope
  -> live mode check
  -> exact authorization-hash approval (LIVE_APPROVAL only)
  -> immutable TradeIntent
  -> executor obtains fresh Jupiter order/quote
  -> final chase/impact/slippage/held-custody checks
  -> structural transaction validation
  -> independent RPC simulation + semantic balance-delta validation
  -> sign
  -> persist SIGNED_NOT_SUBMITTED attempt/signature data
  -> submit
  -> reconcile on-chain
  -> create/update strategy-attributed position lot from actual fill
  -> install protective exit policy
  -> schedule position-management automations
```

`LIVE_AUTO` removes only the human approval step. It does **not** remove the Trading Skill, adversarial action review, deterministic risk engine, authorization envelope, executor validation or reconciliation.

## 14.2 Price moved while thinking

A valid thesis can still become a bad entry.

Immediately before execution:

- compare current quote to candidate/proposal price;
- reject if strategy chase threshold exceeded;
- reject if strategy maximum decision/candidate age expired;
- reject if quote freshness expired;
- optionally return candidate to scanner rather than asking AI again.

The system records `EXPIRED_BY_LATENCY`/`CHASE_REJECT` separately from a bad thesis so research can quantify reasoning latency cost.

## 14.3 Open-position autonomous management loop

While a position exists, its strategy automation set continues invoking the Trading Skill.

```text
Position event / heartbeat
      ↓
Fresh market + safety + thesis context
      ↓
Trading Skill proposes HOLD / REDUCE / EXIT / ADJUST_PROTECTION
      ↓
Action Adversary challenges the proposed action
      ↓
cleared proposal
      ↓
deterministic position/risk policy
      ↓
authorized intent if execution is required
      ↓
executor + reconciliation
```

A cleared `HOLD` creates no transaction but is persisted as a complete action cycle. The UI displays why the agent continues to hold and when it must reassess again.

If the cycle cannot be cleared, the position transitions to `PROTECTION_ONLY`; the previous deterministic protection remains authoritative and review is retried. The runtime never equates "adversary unavailable" with either a discretionary `HOLD` or discretionary `EXIT`.

## 14.4 Mandatory risk exits

The following bypass blocking LLM review:

- hard stop reached;
- provider protective stop fill;
- global/strategy circuit breaker requiring reduction;
- `CRITICAL_EXIT` asset safety state;
- operator emergency close;
- DB-independent emergency close.

These are deterministic actions. Any AI/adversarial analysis is non-blocking telemetry/research only.

## 14.5 Partial/failed fills

State is based on actual token balance/fill reconciliation, not requested amount.

After uncertain submission:

- do not blindly resubmit;
- reconcile the pre-persisted signature/attempt against chain status;
- reconcile wallet/provider-custody balances;
- only retry if the previous attempt is conclusively non-executed, authorization remains valid, asset safety is acceptable and the strategy action has not expired.

## 14.6 Exit route selection and provider-independent emergency adapter

Normal exits use the primary execution adapter. `LIVE_AUTO` assets must also have a previously discovered provider-independent emergency path.

Initial direct-pool fallback implementations support the major liquidity program families used by the eligible universe:

- Raydium AMM v4 / CPMM / CLMM;
- Orca Whirlpools;
- Meteora DLMM.

The exact enabled program ids/SDK versions are versioned executor configuration. Supporting an adapter does not make every token eligible; the token must have a healthy persisted route snapshot.

At eligibility and held-asset revalidation time, persist concrete candidate pool addresses/program ids for risk-asset -> SOL/USDC routes, current pool-state reference, hop plan (maximum two direct-pool legs), capacity/impact at emergency sizes and Token-2022 compatibility. The emergency path refreshes those known pool states but does not depend on first-time liquidity discovery during a panic.

Before each exit:

1. refresh held-asset safety/Token-2022 compatibility;
2. verify actual available custody balance;
3. obtain fresh primary executable route and price-impact estimate;
4. if primary provider is unavailable/unrouteable, load and refresh the persisted direct-pool emergency snapshot;
5. build the direct-pool transaction locally using the adapter's compute-budget/priority-fee policy;
6. apply the same structural + independent-RPC simulation + semantic balance-delta validation used for normal transactions;
7. submit over an approved Solana path independent of Jupiter managed landing; prefer the configured private/Jito-style MEV-aware landing path when healthy, otherwise use the approved direct RPC path rather than delaying a mandatory risk exit;
8. record execution-path/landing-mode and expected-vs-actual output for MEV/adverse-execution measurement;
9. fail/alert loudly if neither path can reduce risk.

The emergency adapter may only convert a chain-confirmed held risk asset to deployment-approved SOL/USDC settlement mints and may not increase exposure. A periodic unsigned build+simulation dry-run validates every held asset and every asset eligible for `LIVE_AUTO`; stale/failed emergency readiness blocks new autonomous entry for that asset.

## 14.7 Chain confirmation, forks and halt handling

Execution state is explicitly staged:

1. **SUBMITTED** — signature known/persisted but no qualifying chain observation yet;
2. **CONFIRMED_PROVISIONAL** — transaction observed at `confirmed`; provisional physical position/custody is reconciled and required protection may be installed immediately;
3. **FINALIZED** — transaction observed at `finalized`; durable fill/accounting/P&L state is promoted;
4. **REORG_PENDING** — a previously confirmed transaction is missing/conflicting before finality or independent RPCs materially disagree.

Operational safety must not wait for `finalized`: if a buy is `confirmed`, the system treats the resulting exposure as real for protection and exposure limits. Financial reporting/audit finality does wait for `finalized`.

For `REORG_PENDING`:

- block new entries affected by the uncertain portfolio/chain state;
- query at least two independent approved RPC views where available plus direct wallet/custody balances;
- do not create a replacement transaction while the original can still land;
- use blockhash/last-valid-block-height and signature history to establish conclusive expiry/non-execution;
- reconcile final chain balances before releasing the pause.

Chain health tracks slot advancement, confirmed/finalized lag and cross-RPC divergence. A detected halt/stalled-finality condition blocks new entries and raises operational alerts; it does not invent local chain truth. Provider-side protective orders remain independently relevant, while direct submissions are permitted only under the configured degraded-chain risk-reduction policy.

## 14.8 Manual actions

The UI supports:

- approve/reject exact live intent in `LIVE_APPROVAL`;
- close position;
- reduce position;
- pause strategy;
- pause all new entries;
- emergency close-all;
- resume after explicit operator action where required.

Manual emergency actions do not wait for AI review. All actions are audited and shown in the same action/timeline UI as autonomous actions.

---

# 15. Execution Service and Wallet Security

## 15.1 Dedicated trading wallet

Use a wallet created specifically for this application and fund only the amount intended for the experiment.

Never use a primary holdings wallet.

## 15.2 Signer isolation

`execution-service` is the only application process authorized to invoke the production trading-wallet signer. The private key itself remains inside the non-exportable signer backend defined by D47.

It exposes a narrow internal API such as:

```ts
executeAuthorizedIntent(intentId: UUID): Promise<ExecutionResult>
installProtectiveOrder(positionId: UUID): Promise<...>
cancelProtectiveOrder(orderId: UUID): Promise<...>
executeEmergencyCommand(command: SignedEmergencyCommand): Promise<...>
```

It does **not** expose:

- `signArbitraryTransaction`
- `sendSOL(address, amount)`
- `callProgram(program, data)`

This restriction applies to the **application/executor API**. D53 deliberately defines a separate incident-only break-glass signer identity outside the application because complete executor loss/compromise cannot be recovered through an API hosted by the failed/compromised executor.

## 15.3 Authority reconstruction and verification

For normal live execution the executor:

1. loads the immutable intent/risk records from Postgres;
2. reconstructs the canonical `RiskAuthorizedIntentEnvelope`;
3. verifies the risk-authorizer’s asymmetric signature;
4. verifies envelope expiry/nonce/idempotency;
5. verifies any required `LIVE_APPROVAL` grant is signed, unexpired and bound to the exact envelope hash;
6. verifies the referenced fresh signed `RiskStateProjection` and its sequence/source digest;
7. independently checks current wallet/custody balances and D45 hard token state where the execution is exposure-increasing;
8. applies deployment-level absolute caps plus the local `ExecutorExposureLedger` caps.

It does **not** trust a database row merely because it came from Postgres.

Only the `EMERGENCY_CLOSE` path may operate without normal DB intent/risk records, and then only under D22’s chain-state-only risk-reducing constraints.

## 15.4 Swap V2 transaction validation and submission

The executor itself:

1. requests the Jupiter order for the exact approved pair/amount;
2. validates returned `requestId`, router, input/output mints, amount, expiry and quote fields against the authorization envelope;
3. rejects unexpected asset, taker/receiver, amount, fee/slippage or expiry changes;
4. performs structural transaction checks: expected wallet/taker/fee-payer relationship, required signer set, transaction version/validity, and no unexpected additional signer authority;
5. simulates the exact unsigned/partially signed transaction through an approved **independent Solana RPC** with current state;
6. asserts semantic deltas for wallet/custody-owned accounts:
   - approved input mint decreases by no more than authorized maximum plus explicitly modeled fee behavior;
   - approved output mint increases as expected within quote/slippage bounds;
   - no unrelated wallet-owned SPL/token balance decreases;
   - SOL movement outside the approved input amount is limited to modeled network/rent/ATA costs;
   - no unexpected authority/delegate/account-owner change is introduced;
7. rechecks quote/chase/expiry immediately after simulation;
8. signs only after validation;
9. derives and stores the signed-transaction hash and every locally known signature;
10. durably writes the `SIGNED_NOT_SUBMITTED` attempt **before** calling `/execute` or another submission route;
11. submits through Jupiter managed execution or an explicitly approved Solana route;
12. records provider response/final signature when returned;
13. reconciles confirmed post-chain balances and transaction metadata.

Router-specific instruction decoding may be used for diagnostics/defense-in-depth, but is not the primary authorization mechanism because Swap V2 can route through different execution engines and versioned transactions/address lookup tables.

Simulation is also not treated as a guarantee: state can change between simulation and landing, which is why actual chain reconciliation remains authoritative.

A timed-out remote **sign** request for the exact same canonical Ed25519 message bytes may be retried: Ed25519 signing is deterministic, so identical bytes under the same key produce the same signature. The retry remains correlated/idempotent in our audit/provider-request layer so a timeout cannot cause different transaction bytes, duplicate submission, or ambiguous operational state. Submission is still governed by the persist-before-submit/reconciliation rules above.

## 15.5 Risk authorization process/key separation

`risk-authorizer` is a dedicated OS process/container with a secret mount unavailable to `worker`, `web`, Postgres and `execution-service`. It has no LLM runtime, no untrusted provider/news/social ingestion and no wallet signing capability. Its public verification key is pinned in executor deployment configuration.

Before signing, it verifies the immutable active Release digest and its required operator attestation, validates the current action cycle/cutoff/adversarial clearance, verifies the current signed `RiskStateProjection`, independently re-reads D45 hard protocol/security state and current wallet/custody balances through its allowlisted RPC path, then computes the maximum allowed action from versioned policy. It emits only the signed `RiskAuthorizedIntentEnvelope`.

Isolation prevents compromise of the general worker/LLM surface from yielding the risk-authorizer private key. Signed projections prevent database-only mutation from silently widening projected state; independent chain reads catch critical projection/chain mismatches. The executor's local exposure ledger and hard caps remain separate final limits.

## 15.6 Approval binding and step-up authentication

`LIVE_APPROVAL` grants are cryptographically bound to the exact risk-authorization envelope hash, nonce and expiry. A stale approval cannot be replayed for a changed amount, mint, strategy, stop, slippage or later re-authorization.

Human controls that can widen live financial authority require step-up authentication under D41. Passkey/WebAuthn is primary; TOTP may be configured as fallback. Step-up is required for exposure-increasing approvals, arming/resuming live, Release promotion, live risk-policy/executor-visible configuration changes and operator credential changes.

Risk-reducing controls remain fast: pause and emergency close are not made dependent on a fresh step-up ceremony.

## 15.7 Secret storage

Wallet signing material is never stored in the browser, source repository, database row, log, prompt, general worker environment **or production executor filesystem/container secret mount**.

Production/mainnet uses a `TradingWalletSigner` adapter backed by a non-exportable Ed25519 signing service. The executor sends only the exact transaction/message bytes that already passed authorization, structural validation, independent simulation and final chase/expiry checks. The signing service returns a signature and signer/public-key metadata; it does not receive strategy instructions or construct/modify the transaction.

Required signer properties:

- Solana-compatible Ed25519 signing proven by contract test;
- private key non-exportable at rest and during signing; for Turnkey this means explicit deny-export policy for autonomous and break-glass principals, verified by policy/readiness tests rather than assumed from provider marketing;
- only the approved autonomous signing principal may request normal signatures: either the executor workload identity for a native-policy signer, or the isolated D55 signer-policy gateway identity for a byte-only backend; the executor itself must not hold a bypass credential;
- provider/HSM audit logs enabled where available;
- rate/amount-independent signer calls cannot bypass executor caps because signer output is useful only for the validated message;
- health/latency/failure behavior observable;
- provider-specific disaster recovery preserves access to the same wallet public key and is exercised before live arming.

Supported backend candidates include Turnkey, Privy server wallets, or an equivalent non-exportable Solana signer, but they are **not security-equivalent**. Provider choice is configuration plus a documented capability profile. `LIVE_AUTO` additionally requires D55's signer-side transaction policy outside the executor.


A local software key may exist only in dev/test and is a hard Live Readiness failure if selected for mainnet live modes.

Risk-authorization signing material lives only with the risk-authorizer role; the executor needs only its public key. Operator emergency command signing material is similarly separate from the live wallet key.

## 15.7A Signer-side autonomous policy

The autonomous signer principal is governed by D55 outside the executor.

Required policy behavior for `LIVE_AUTO`:

- deny by default;
- allow only the deployment's explicitly approved Solana program/instruction classes needed for Jupiter routes, approved direct-pool adapters, Token/Token-2022, ATA, ComputeBudget and narrowly required System-program operations;
- deny System/SPL transfers to arbitrary non-owned/non-custody recipient accounts;
- constrain transaction/message signing to the production trading-wallet public key and approved mainnet cluster;
- deny arbitrary message/raw signing to the autonomous principal;
- version/pin the policy identity/digest in Live Readiness and audit changes;
- reject/requote a route that introduces an execution program outside the current approved signer policy rather than broadening policy automatically;
- for Turnkey, explicitly detect/deny unsafe `ADDRESS_TABLE_LOOKUP` cases according to the tested policy. Account addresses from lookup tables are not resolved by Turnkey policy, while program addresses via lookup tables are rejected. Real Jupiter v0 `/order` transactions must therefore pass the D55 lookup-table compatibility contract gate before autonomous signing is permitted.

Where the signer provider natively evaluates Solana transaction instructions/programs, use that facility. If a future approved provider only signs bytes, a separate minimal signer-policy gateway owns the backend signing permission, validates the already-executor-validated transaction against this second policy, and then requests the non-exportable signature. That gateway has no LLM/news/social/strategy runtime and is independently deployable/isolated.

## 15.7B Break-glass signer and cold recovery

The D53 break-glass identity is provisioned/controlled outside the application deployment and is distinct from the executor autonomous signer identity.

Activation requires the provider-specific MFA/quorum/incident procedure and yields only time-boxed authority. The recovery tool/runbook reconstructs actual chain/custody state and permits only:

- held risk asset -> approved SOL/USDC reduction;
- provider Trigger/vault cancel/withdraw/recovery needed to regain custody;
- `SWEEP_TO_COLD_RECOVERY` to the single pre-registered cold wallet/canonical token accounts after compromise.

The cold-recovery address/trust record is pinned in the signer/recovery control plane and independently documented offline; it is not supplied by a browser, database row, environment variable on the executor host or incident CLI argument.

Every break-glass activation/signature/revocation is high-severity audited and reconciled into the application after recovery.

## 15.8 Network boundary

Execution service runs on a private/internal network. Normal requests from trading worker to executor use authenticated service-to-service requests and replay protection.

The separate out-of-band operator endpoint accepts only narrowly typed emergency commands signed by the pinned operator key and never exposes a general transaction/signing primitive.

## 15.9 Live arming

Live execution requires all of:

- deployment-level live capability enabled;
- database/operator mode set to `LIVE_APPROVAL` or `LIVE_AUTO`;
- each live strategy bound to an immutable Release whose digest has a valid required step-up attestation;
- the relevant Live Readiness verdict permits the requested mode.

A database compromise alone cannot silently turn a non-live deployment live or substitute an unattested Release. Even when armed, deployment-level executor caps remain hard ceilings.

## 15.10 Emergency close authority

The executor contains a separate code path for `EMERGENCY_CLOSE` that can operate while Postgres is unavailable.

It may only sell/reduce a chain-confirmed held risk asset into an allowed settlement mint. It cannot buy a new risk asset, transfer to an arbitrary address, increase exposure, or exceed confirmed available balance.

The command and pre-submit attempt are recorded in an executor-local append-only durable journal. Once Postgres returns, reconciliation imports the event and requires operator review before new entries resume after a DB-outage emergency action.

## 15.10A Durable position risk shadow

`worker` and `execution-service` maintain durable local copies of a sequenced `PositionRiskShadow` journal, synchronized on every position/protection state change. It contains only the minimum information necessary to continue deterministic protection when Postgres is unavailable: asset/lot references, last confirmed quantity, stop/trail/time-stop and optional `unreviewed_stop`, protection/custody mode, provider order ids and last validated emergency-route snapshot.

During a DB outage:

- fresh chain/provider custody truth determines actual sellable quantity;
- fresh market/secondary price data plus the shadow determines whether a deterministic stop is hit;
- the shadow can authorize only D22 risk reduction, never a new entry or increased exposure;
- every emergency action and shadow sequence used is written to the executor-local journal and reconciled before entries resume.

## 15.11 Withdrawal limitation by design

Regardless of which non-exportable HSM/server-wallet custody backend is used, the Solana key itself can authorize transfers if an authorized signer principal asks it to sign a valid transaction; the blockchain does not enforce our product-level intent restrictions.

Normal autonomous protection is layered: typed authorization + executor structural/simulation/delta validation + D55 signer-side transaction policy + non-exportable key + deployment/exposure caps. The application exposes no general transfer/signing API. The only deliberately broader capability is the separately authenticated/time-boxed D53 break-glass incident path, whose external recipient is fixed to D54's pre-registered cold recovery wallet.

Funding/capital-attestation ceilings and executor absolute caps remain blast-radius controls.

## 15.12 Browser/operator wallet connector boundary

The connected Wallet Standard wallet belongs to the human operator and exists only in the browser/web layer. It is **not** mounted into backend services and its private key/seed is never available to this application. Wallet signing is mediated by the external wallet UI.

Allowed v1 connector capabilities:

1. discover/connect/disconnect Wallet Standard wallets;
2. read selected public address and settlement-asset balances for display;
3. prepare a typed `FUND_TRADING_WALLET` request from the UI;
4. construct/display the exact SOL or allowed SPL-token funding transfer to the deployment-configured trading wallet/canonical ATA;
5. request the connected wallet to sign/send that user-initiated transaction;
6. record the returned signature and reconcile final chain deltas through the backend.

The funding transaction builder is intentionally narrow:

- destination is resolved from deployment/configured trading-wallet identity, never arbitrary user text;
- asset must be on the funding allowlist (initially SOL/USDC);
- cluster must equal the deployment cluster;
- the UI displays source, destination, asset, amount, estimated fees and projected trading-wallet balance before wallet prompt;
- SPL funding may create the canonical destination ATA if absent, but cannot introduce unrelated instructions/recipients;
- the user must explicitly approve the transaction in the connected wallet;
- no remembered permission permits future debits and no automation may call the connector.

The connector **must not** implement general `signTransaction`, `signAllTransactions`, arbitrary message signing or arbitrary recipient-transfer functions as reusable application APIs. The underlying wallet may expose such protocol capabilities, but this product's interface wraps only the typed funding operation above.

Wallet connection is also not operator authentication. Supabase Auth + role + WebAuthn/TOTP step-up remain the authority for control actions. A Solana wallet signature cannot substitute for D41/Release attestation in v1.

Disconnecting the operator wallet, closing the browser or losing the wallet-provider extension has zero effect on running strategies, protection, execution, emergency controls or recovery.

---

# 16. Protective Orders

## 16.1 Monitored exits

The position monitor evaluates exit conditions frequently using fresh market data.

Advantages:

- full strategy flexibility;
- no provider vault custody;
- easy dynamic trailing logic.

Risk:

- depends on our worker/network/quote-provider uptime, mitigated by secondary price/quote sources and the executor emergency-close path.

## 16.2 Jupiter Trigger V2 adapter

Where appropriate, support provider-side stop-loss/OCO/trailing protection.

Trigger V2 is not “just another swap endpoint.” The adapter must model its actual lifecycle:

1. executor signs the wallet authentication challenge and obtains/renews the 24-hour JWT;
2. executor resolves/registers the wallet’s provider vault;
3. deposit transaction is crafted, semantically validated, signed and durably journaled before order creation;
4. deposit moves the protected asset into the registered vault;
5. order state/fills are monitored;
6. cancellation/expiry recovery uses the documented two-step cancel + signed withdrawal confirmation flow.

The registered Jupiter vault is a known custody location under D9. Authorized wallet→vault and vault→wallet movements tied to the order lifecycle do not trigger “unknown movement”; any unmatched movement does.

## 16.3 Trigger transaction classes

The executor’s transaction validator must explicitly support and semantically validate:

- `TRIGGER_DEPOSIT` — only approved asset amount may move from wallet to the registered vault;
- `TRIGGER_CANCEL_WITHDRAW` — only the expected remaining asset may return from the registered vault to the trading wallet;
- provider order-fill reconciliation — position/custody state updates from actual provider/chain results.

Trigger auth/JWT state is held only inside the executor; general workers never sign the wallet challenge.

## 16.4 Stop-loss slippage trade-off

Provider-side protection cannot promise both guaranteed exit and a tight fill in a discontinuous/thin market. A stop order with a tight slippage limit may fail to execute during a gap; a very loose limit may execute at an unacceptable price.

Therefore:

- always pass explicit `slippageBps` / `slSlippageBps`; never inherit provider defaults;
- cap it with versioned risk policy **and** deployment-level executor maximum;
- surface the configured protection mode/slippage on the position UI;
- model failed/partial stop execution as an explicit emergency state that escalates to monitored/emergency close if possible.

## 16.5 Reconciliation requirement

If provider-side protection is active, continuously reconcile:

- order state;
- registered vault balance;
- deposit/withdraw signatures;
- fill history;
- local aggregate position;
- strategy-attributed lots.

A provider-side fill must close/reduce the local position without requiring our worker to have initiated the trade.

Each provider protective order is bound to one strategy lot/sub-lot and reserved quantity. Reconciliation attributes fills by provider order id/custody account before updating the aggregate mint position. If the provider/order mode cannot prove lot isolation, provider-side protection is not used for same-mint multi-strategy lots.

## 16.6 Token-2022 compatibility

Trigger V2 currently has compatibility restrictions around transfer-fee/transfer-hook tokens. A token is eligible for `JUPITER_TRIGGER` only when the provider route explicitly supports its extensions.

Where Swap V2 supports a token but Trigger protection does not, policy must either use `MONITORED_EXIT` or reject autonomous live entry if strategy requires provider-side protection. Fill/P&L accounting always uses actual net token deltas rather than nominal requested amounts.

---

# 17. Paper Trading

Paper trading is not a toy fake-price mode.

## 17.1 Live-paper entry

At the moment a live trade would be executed:

- request a real Jupiter quote/order without signing;
- record expected output, route, price impact and fee estimates;
- apply configurable execution latency;
- record simulated fill using conservative assumptions.

## 17.2 Live-paper exits

Use live executable quotes at the actual exit decision time.

## 17.3 Why this matters

A naive paper engine using candle closes will systematically overstate performance in volatile/illiquid tokens.

Live-paper mode should become the highest-confidence pre-live evidence because it observes contemporaneous routes/liquidity.

## 17.4 MEV/adverse-execution modeling

For every hypothetical executable action, record the execution path/landing mode that live trading would have used. Paper results apply a configurable adverse-execution/MEV allowance by path rather than assuming quote-to-fill perfection.

At minimum distinguish:

- Jupiter managed `/order` execution;
- provider protective execution;
- direct-pool emergency execution with private/Jito-style landing;
- direct-pool emergency execution over ordinary RPC.

The model may use conservative bps distributions calibrated from later live fills. Do not label all quote-to-fill degradation as "MEV"; store `execution_shortfall_bps` separately from the modeled attribution.

---

# 18. Replay and Backtesting

## 18.1 Three research fidelity levels

### Level A — Historical backtest

Uses stored/provider historical OHLCV and available historical features.

Good for broad screening, but historical DEX route/slippage reconstruction may be approximate.

### Level B — Captured-market replay

Uses data we captured live, including candidate snapshots, evidence first-seen times and contemporaneous quote probes.

Much higher fidelity.

### Level C — Live paper/shadow

Strategy runs on real time with real quotes but no signature. Best pre-live test.

Do not conflate these result classes.

## 18.2 Replay clock

All strategy code reads a supplied `Clock` interface. Production uses wall clock; replay uses simulated time.

No strategy code should call `Date.now()` directly.

## 18.3 Look-ahead protections

Replay query layer enforces:

- event `first_seen_at <= clock.now()`;
- candle bucket availability only after configured close/availability time;
- labels/security data only after first observed;
- no use of later revised metadata;
- no future wallet PnL classification unless that classification existed then.

This last point is critical: calling a wallet “smart money” because we now know it made money later would leak the future.

## 18.4 Cost model

Backtests include:

- DEX/provider fee assumptions;
- slippage;
- price impact;
- MEV/adverse-execution allowance by execution/landing path;
- priority/network fees;
- configurable decision latency;
- execution failure rate assumptions where historical data cannot reconstruct it.

## 18.5 Reproducibility

A replay run stores:

- strategy version;
- code SHA;
- dataset cutoff;
- provider dataset versions where known;
- random seeds if applicable;
- model/provider version;
- prompts;
- all generated decisions.

Model-based historical tests may not be bit-for-bit reproducible if the provider changes model internals, so outputs themselves must be stored.

---

# 19. Performance Measurement

## 19.1 Core trading metrics

Per strategy and aggregate:

- net PnL;
- gross PnL;
- fees;
- slippage/price impact;
- execution shortfall versus contemporaneous executable expectation;
- execution shortfall grouped by landing/MEV-mitigation path;
- win rate;
- average winner/loser;
- expectancy per trade;
- profit factor;
- max drawdown;
- time in market;
- turnover;
- Sharpe/Sortino where sample supports it;
- tail losses;
- failed execution rate;
- average decision-to-fill latency.

## 19.2 Signal attribution

Measure performance grouped by:

- candidate family;
- market regime;
- token age;
- liquidity band;
- market-cap/FDV band;
- relative-volume band;
- smart-money signal presence;
- news catalyst presence;
- social acceleration presence;
- model confidence;
- adversary verdict/outcome;
- time of day/day of week if sample supports it;
- position duration.

## 19.3 AI incremental value

Required comparison:

```text
Deterministic candidate -> baseline rule result
Same candidate -> AI filtered/enriched result
```

Report:

- opportunities AI correctly filtered out;
- profitable baseline trades AI incorrectly rejected;
- losing baseline trades AI avoided;
- trades AI admitted that baseline would not;
- incremental net expectancy after model cost.

## 19.4 Model cost

LLM/API data costs are included as system operating costs even though they are not market execution costs.

---

# 20. Product UI / UX / Human and Machine Interfaces

The platform must be operable, explainable and researchable without opening logs, querying Postgres, or reading source code. UI/UX is therefore an implementation requirement, not decoration after backend completion.

## 20.0 UX principles

1. **Activity and authority are impossible to misunderstand.** The UI separately shows runtime activity (`OFF`/`STARTING`/`WATCH`/`ACTIVE`/`EVENT_WINDOW`/`WIND_DOWN`), capital authority (`OBSERVE`/`PAPER`/`LIVE_APPROVAL`/`LIVE_AUTO`) and sticky `PAUSED` override/degraded states.
2. **Risk before excitement.** Exposure, drawdown, open positions, protection state and data freshness visually outrank candidate hype.
3. **Every action is explainable.** The operator can drill from fill -> intent -> risk evaluation -> adversarial review -> proposer -> evidence -> automation trigger.
4. **Every non-action is explainable.** Rejections, expired opportunities and open-position `HOLD` decisions are inspectable.
5. **Autonomy is visible.** The UI shows what the agent is currently monitoring, what automation invoked it, whether the proposer/adversary disagree, and what will happen next.
6. **Staleness is explicit.** Never display stale data as though it is live. Every critical panel knows its freshness/health state.
7. **Emergency controls are fast; enabling risk is deliberate.** Pause/close is easy. Arming/resuming autonomous live trading requires a deliberate review ceremony.
8. **No hidden magic.** Live-impacting values are visible with provenance/version: strategy, skill, guideline, automation set, risk policy, model policy and executor policy.
9. **Desktop research, mobile safety.** Research/labs are desktop-first; operational visibility and risk reduction work well on a phone.
10. **The UI never becomes chain authority.** Values are projections of canonical backend/chain state and show reconciliation status.

## 20.1 Information architecture and application shell

Primary navigation:

```text
CONTROL
  Control Room
  Agent Activity
  Positions
  Approval Queue        [shown when LIVE_APPROVAL]

MARKETS
  Scanner
  Watchlist
  Asset Workspace

RESEARCH
  Trade History
  Strategy Lab
  Replay Lab
  Attribution / Economics

AUTONOMY
  Autonomy              [tabs: Skill · Guidelines · Automations · Adversary]

SYSTEM
  Risk & Policy
  Wallet / Custody
  System Health
  Live Readiness
  Releases
  Audit Log
  Settings
```

**Global scope selector.** Paper books, the live wallet and replay runs coexist. Every screen showing money, positions, actions or history carries a persistent selector:

`LIVE` · `PAPER: <strategy/book>` · `REPLAY: <run>`

The selected scope is visually distinct from the actual live operating mode. Switching scope never changes live mode or arms execution.

Persistent top status bar example:

```text
ACTIVITY: ACTIVE   AUTHORITY: LIVE_AUTO   ENTRIES: ARMED   ATTENDED: YES   Feeds: FRESH 1.2s
Protection: 3/3   Exec: OK   DB: OK   Equity $5,214   Exposure 31%   Day P&L +1.8%   Alerts 1   [PAUSE] [END SESSION]
```

`Feeds` shows worst-case freshness across critical data classes for the selected live scope and turns `STALE <age>` when any required class breaches policy. `Protection` shows positions with healthy active deterministic/provider protection over total open positions and links directly to the affected positions when deficient.

When `LIVE_AUTO` is armed, the application shell carries an unmistakable live treatment on every page. Activity state, capital authority, attended/unattended state, stale/degraded state and any `PAUSED` override are shown in the same persistent chrome.

## 20.2 Control Room — primary operator screen

Purpose: answer within seconds:

- Is the system healthy?
- Is it live?
- How much money is at risk?
- What is the agent doing?
- Are positions protected?
- What changed recently?
- Do I need to intervene?
- Is this an attended session, what trading window/regime is active, and what happens when the session ends?

Required **Trading Session** widget shows:

- activity state and capital authority as separate values;
- deployment profile and attended/unattended state;
- session start/duration and intended end;
- active global-market/session labels and regime metrics;
- current `EVENT_WINDOW` catalyst, source-time age and deterministic expiry if present;
- operator presence heartbeat age for attended live;
- cold-start/warm-up status when `STARTING`;
- next scheduled activity transition;
- `END SESSION` blockers: unmanaged positions, `SUBMITTED`/`CONFIRMED_PROVISIONAL`/`REORG_PENDING` executions, or in-flight Trigger custody operations.

`END SESSION` transitions to `WIND_DOWN`, never directly to `OFF`. The runtime reaches `OFF` only when D61 permits it. If remaining lots are policy-approved `OFFLINE_PROTECTED`, the UI shows their maximum offline deadline and planned resume/reconciliation time.

Desktop layout:

```text
┌─────────────────────────────────────────────────────────────────────┐
│ MODE / ARM STATE   EQUITY   EXPOSURE   DAY P&L   DRAWDOWN   PAUSE │
├──────────────────────────────┬──────────────────────────────────────┤
│ Portfolio / P&L              │ Agent Now                            │
│ equity curve + exposure      │ reviewing JUP — catalyst S2         │
│                              │ proposer: ENTER                      │
│                              │ adversary: CHALLENGE round 1         │
├──────────────────────────────┼──────────────────────────────────────┤
│ Open Positions               │ Opportunity Queue                    │
│ token, P&L, stop, protection │ score, age, strategy, current state  │
├──────────────────────────────┼──────────────────────────────────────┤
│ Risk / Sleeve Utilization    │ Alerts / Recent Actions              │
│ global + S0..S4              │ fills, exits, holds, provider issues │
└──────────────────────────────┴──────────────────────────────────────┘
```

Required widgets:

- equity and available trading capital;
- realized/unrealized P&L;
- trading/economic P&L switch;
- current total exposure;
- per-strategy sleeve utilization;
- correlated cohort exposure;
- open positions with stop/protection state;
- active action cycles (`proposer`, `adversary`, `risk`, `execution` stage);
- candidate/opportunity queue;
- current drawdown/circuit breaker state;
- wallet reserve status;
- provider/worker/executor/database health summary;
- high-priority alerts;
- one-action global pause;
- **Upcoming** — next scheduled reassessments, automation cooldown expiry, candidate/protection expiry and readiness checks;
- **Model/data spend today** — strategy and platform usage against configured spend/rate budgets.

`Upcoming` sits beneath/adjacent to `Agent Now` so the operator can see what the autonomous system will do next, not only what it just did.

Desktop global pause shortcut: `Shift+P` held for one second invokes `PAUSE_NEW_ENTRIES` from any route. The hold is visualized on the pause control to prevent accidental activation.

## 20.3 Live arming / resume UX

Changing from non-live to `LIVE_APPROVAL`/`LIVE_AUTO`, or resuming after a hard pause, opens an arming review rather than a casual toggle.

The review shows:

- trading-wallet balance and max blast radius;
- executor absolute cap;
- global risk policy/version;
- enabled live strategies and sleeve caps;
- exact Trading Skill/guideline/automation/adversary versions;
- currently open positions;
- protection mode;
- wallet gas/settlement reserves;
- primary + emergency-exit adapter status;
- unresolved critical/high alerts;
- provider freshness;
- last reconciliation time;
- whether the deployment-level live capability is enabled.

`LIVE_AUTO` cannot arm if a required live-readiness invariant is failing. The confirmation binds to the reviewed configuration version; a materially changed live policy requires re-arming where policy specifies.

The review is bound to an immutable **Release** and shows its identifier plus a diff against the previously armed Release. Arming/resuming, promoting a Release to live eligibility and widening live policy require step-up authentication. Pause does not.

The checklist additionally requires notification-channel health, emergency-exit dry-run freshness and spend-budget health.

Pause is deliberately easier than arm.

## 20.4 Scanner — live working surface

The scanner is not merely a table. It is the operator's live market triage surface.

Columns/filterable fields:

- token + mint identity;
- eligibility/safety state;
- emergency exit route snapshot age/result and `emergency-exitable` filter;
- strategy candidate badges;
- scanner score;
- price and 1m/5m/15m/1h returns;
- relative volume;
- liquidity;
- SOL-relative strength;
- volatility;
- buy/sell flow;
- smart-money state;
- holder change;
- news/social/catalyst state;
- cohort/correlation tags;
- current action-cycle state;
- candidate age/expiry;
- self-influence suppression indicator;
- execution route/impact health.

Interactions:

- sort/filter/pin/watch;
- click opens Asset Workspace without losing scanner state;
- filter by strategy eligibility and speed tier;
- show "why not tradeable" reasons inline;
- optional compact sparkline/chart;
- operator can request a manual research refresh, but cannot bypass hard eligibility by clicking trade.

## 20.5 Asset Workspace

One token gets a multi-panel investigation workspace.

Header:

```text
WIF   ELIGIBLE   Candidate S1:87 S4:79   $X.XX  +6.1% 15m
Liquidity $... | Impact @ $250 ... | Safety NORMAL | Fresh 1.2s
[Watch] [Open decision] [Manual close position if held]
```

Panels/tabs:

### Market

- multi-timeframe chart;
- entries/exits/protective levels/candidate markers;
- VWAP/EMA/RSI/ATR/volume overlays chosen by user;
- liquidity and price-impact curve;
- relative strength versus SOL/universe;
- trade/flow metrics.

### On-chain / ownership

- holder concentration;
- holder change;
- dev/insider/sniper/bundler state;
- smart-wallet flows;
- known owned/self addresses excluded marker;
- Token-2022/authority/security details.

### Intelligence

- deduplicated news/social/catalyst timeline;
- source quality + first-seen time;
- novelty state;
- supporting vs contradicting evidence;
- explicit warning for stale/repeated narrative.

### Agent

- current/previous action cycles;
- proposer thesis;
- adversary objections/verdict;
- revisions;
- strategy/skill/model versions;
- next automation/reassessment.

### History

- prior candidates;
- rejected/expired opportunities;
- past paper/live trades;
- realized outcomes after 15m/1h/4h/24h as useful research labels.

## 20.6 Agent Activity / Action Queue

A dedicated screen shows autonomy as a state machine rather than a mysterious stream of prose.

Each row/card shows:

```text
10:31:04  BONK  S1 Contextual Momentum
Trigger: 15m breakout + relative volume
Stage: ADVERSARY ROUND 1
Proposer: ENTER  confidence .78
Adversary: CHALLENGE — move overextended / weak SOL-relative strength
Expires in: 34s
```

Filters:

- active/completed;
- strategy;
- action type;
- proposer/adversary agreement;
- live/paper/replay;
- token;
- result.

This screen must include open-position `HOLD` cycles, not only trades. Stage vocabulary also includes `PROTECTION_ONLY (unreviewed)` and `BUDGET_PAUSED`, with filters for cycles that failed to clear and their reason.

## 20.7 Decision / Action Inspector

This is the canonical "why?" screen.

Timeline:

```text
Automation fired
  ↓
Evidence snapshot
  ↓
Proposer vX/model Y: ENTER
  ↓
Adversary vA/model B: CHALLENGE
  ↓
Proposer revision: ENTER with shorter expiry
  ↓
Adversary: CONFIRM
  ↓
Risk policy v12: ALLOW $237.50 max
  ↓
Authorization hash ...
  ↓
Jupiter quote/simulation
  ↓
Signed attempt persisted
  ↓
Chain fill
  ↓
Protection installed
```

Show side by side where useful:

- proposer claim;
- adversary objection;
- exact evidence supporting/refuting each;
- deterministic risk result;
- quote vs actual fill;
- later outcome.

The inspector must make it obvious which statements were AI interpretation and which were deterministic facts. Every proposer/adversary node shows its evidence cutoff version; refreshed cycles visibly show the old cutoff, new cutoff and revision relationship.

A fixed **Baseline counterfactual** panel shows what S0 decided for the same candidate/cutoff and its realized outcome. For open-position reassessment it also shows the counterfactual outcome of exiting at the reassessment price versus the realized reviewed `HOLD`.

## 20.8 Approval Queue (`LIVE_APPROVAL`)

Each pending approval shows only already adversarially-cleared and risk-authorized intents.

Required information before approval:

- token/strategy/action;
- thesis + adversary verdict;
- exact maximum authorized amount;
- account exposure after trade;
- stop/protection plan;
- current executable quote/impact freshness;
- authorization expiry countdown;
- signed authorization hash/reference;
- reasons for risk allow.

Actions:

- `Approve exact intent`;
- `Reject` with optional reason;
- `Open full decision`.

Approval never permits editing the amount/asset in place. Any change creates a new proposal/risk authorization.

By default `LIVE_APPROVAL` requires human approval only for exposure-increasing intents. Adversarially cleared, policy-authorized `REDUCE`/`EXIT` intents auto-execute and appear as informational rows with a cancel control only until submission; this is configurable per strategy but defaults on.

A strategy whose intent expiry is below the configured human-reaction floor is `NOT ELIGIBLE FOR LIVE_APPROVAL` and cannot be bound to a LIVE_APPROVAL Release. Mobile approval cards show a large expiry countdown and disable approval shortly before envelope expiry.

## 20.9 Positions Workspace

Primary table:

- token;
- strategy lot(s);
- aggregate quantity;
- entry/current price;
- realized/unrealized P&L;
- age vs expected horizon;
- stop/target/trailing state;
- custody split;
- current asset-safety state;
- protection health;
- last autonomous reassessment;
- last action (`HOLD`, `REDUCE`, etc.);
- next reassessment due;
- current exit route/impact;
- review state — `REVIEWED <age>` / `PROTECTION_ONLY (reason/age)` / `BUDGET_PAUSED`;
- emergency-exit dry-run last result/age.

Position detail includes:

- lot allocation/protection rule when the same mint is held by multiple strategies;
- last emergency-exit dry-run route, result and expected impact;

- thesis evolution from entry to now;
- every `HOLD` decision and adversarial review;
- price/P&L chart with action markers;
- strategy-lot attribution;
- protective order/vault lifecycle;
- exit-compatibility diagnostics;
- manual `Reduce` and `Close`.

If safety becomes `EXIT_RECOMMENDED`/`CRITICAL_EXIT`, the UI elevates this above ordinary P&L styling.

## 20.10 Trade History

Filterable by:

- strategy/strategy version;
- skill/guideline/adversary version;
- paper/live;
- token/cohort;
- result;
- regime;
- signal/catalyst;
- proposer confidence;
- adversary agreement/disagreement;
- speed tier;
- date;
- exit type;
- provider route.

Every row drills into the Action Inspector and full lifecycle.

Export selected/all filtered trades/positions as CSV or JSON including strategy lot, cost basis, fees/slippage/priority/transfer costs, action-cycle ids, Release/version ids and realized outcomes for external analysis/record-keeping.

## 20.11 Strategy Lab

`S0_RAW` and `S0_SAFE` are displayed as separate baseline variants throughout this workspace; their parameters, gate decisions, outcomes and counterfactual attribution must never be merged into one generic `S0` row.

Required views:

- S0–S4 versions/status;
- active speed tier;
- bound Trading Skill/guideline/automation/risk versions;
- paper/replay/live-shadow leaderboard;
- baseline comparison;
- parameter/version diffs;
- proposer confidence calibration;
- adversary disagreement rate/value;
- performance by regime/cohort/token;
- latency-cost analysis;
- promotion/retirement history.

Draft configuration is editable only as a new version. A live immutable version is never edited in place.

## 20.12 Trading Skill Console

A dedicated interface makes the autonomous capability inspectable and testable.

Tabs:

### Overview

- skill version/status;
- bound strategies;
- supported action types;
- proposer/adversary model policies;
- last deployment/promotion;
- live usage count and error state.

### Tools

For every tool show:

- name/version;
- read/proposal classification;
- request/response schema;
- data source;
- point-in-time behavior;
- live permission;
- recent invocation/error/latency stats.

Forbidden capabilities should be explicitly shown as absent rather than implicit.

### Guidelines

- rendered versioned behavioral guidelines;
- diff against prior version;
- draft/new-version editor if enabled;
- test fixtures before promotion.

### Workflows

Visual state machine for candidate assessment and position management.

### Versions / Test Harness

- immutable versions;
- paper/replay validation results;
- adversarial fixture suite;
- promote/retire with audit trail.

## 20.13 Automations Console

List/card fields:

- automation name/version;
- trigger family;
- event/filter expression;
- strategy + skill binding;
- mode availability;
- cadence/cooldown;
- priority;
- last fired / next eligible;
- recent result;
- enabled state for draft/paper/live configuration.

The operator can answer:

> "What causes the agent to wake up?"

and

> "When will it reassess this position if nothing else happens?"

The live agent cannot edit these automations itself.

## 20.14 Action Adversary Console

Show:

- current adversary policy/version/model;
- mandatory action coverage;
- agreement/challenge/reject rates;
- outcomes after `CONFIRM` vs challenged/rejected proposals;
- common objection reason codes;
- revision success rate;
- latency added by adversarial review;
- adversary failures/timeouts;
- tests proving no discretionary live action bypassed it.

A live setting may change *which approved adversary version* is used through a new configuration version, but cannot disable D30 for autonomous actions.

## 20.15 Replay Lab

Controls:

- date/time range;
- universe;
- strategy/skill/guideline/adversary versions;
- initial capital;
- cost model including execution-path-specific MEV/adverse-execution allowance;
- replay fidelity/speed;
- provider-data subset;
- optional model substitution experiment.

Outputs compare strategies side by side and show exact action-cycle timelines.

Replay must visually indicate simulated time and must never look like live trading.

## 20.16 Attribution / Economic P&L

Views:

### Trading P&L

- gross return;
- DEX/router fees;
- priority/network fees;
- transfer fees;
- slippage/price impact;
- net trading result.

### Strategy economic P&L

- net trading result;
- attributable LLM calls;
- attributable data/RPC cost;
- contribution after direct operating cost.

### Platform economic P&L

- aggregate strategies;
- shared provider subscriptions;
- hosting/database/worker cost;
- final operating result.

Show cost per candidate, cost per action cycle, cost per executed trade and cost per profitable trade.

## 20.17 Risk & Policy

Sections:

- global portfolio limits;
- strategy sleeve caps;
- risk cohort/correlation limits;
- trade limits;
- slippage/impact/chase limits;
- daily/rolling drawdown;
- executor absolute caps;
- protection policy;
- emergency-exit policy;
- live arm state;
- change history/version diffs.

Hard vs research/soft settings must be visibly differentiated. Changing live risk policy creates a new version and follows the configured re-arming requirement.

## 20.18 Wallet / Custody

This screen visually separates **Connected Funding Wallet** from **Trading Wallet / Custody**. They must never be presented as one wallet concept.

### Connected Funding Wallet

Browser-side Wallet Standard connector using Solana Kit. Show:

- `Connect wallet` / connected-wallet selector / `Disconnect`;
- wallet name/icon when supplied by Wallet Standard;
- connected public address with copy/explorer action;
- cluster/network;
- SOL and allowed funding-token balances;
- explicit badge: `EXTERNAL OPERATOR WALLET — NOT USED FOR AUTONOMOUS TRADING`;
- recent manual funding transactions initiated from this app.

Disconnected is a normal state and must not produce a trading-runtime warning. Never show this wallet as an armed signer, strategy account or custody account.

### Trading Wallet / Custody

Show:

- dedicated trading-wallet public address;
- explicit badge: `AUTONOMOUS TRADING WALLET — KEY NON-EXPORTABLE / SIGNING POLICY ISOLATED`;
- SOL and USDC reserves;
- risk-asset balances;
- registered token accounts;
- Jupiter vault/custody balances;
- physical vs strategy-lot reconciliation;
- minimum reserve thresholds;
- recent expected/unknown balance movements;
- wallet/chain reconciliation state;
- last successful disaster-recovery snapshot/test date.

### Manual funding flow

`[Fund Trading Wallet]` is enabled only when a Wallet Standard wallet is connected. Flow:

1. choose an allowed funding asset (initially SOL/USDC);
2. enter amount;
3. show source wallet, exact configured trading-wallet destination/canonical ATA, current and projected trading-wallet balance, network and estimated fee;
4. show the current D56 capital-attestation ceiling and whether the proposed funding would exceed it; crossing the ceiling is allowed as a manual funding action but is clearly labeled `RE-ATTESTATION REQUIRED — NEW ENTRIES WILL PAUSE`;
5. operator selects `Review in wallet`;
6. external wallet presents its own signature approval;
7. UI enters `SUBMITTED — awaiting chain confirmation`;
8. backend reconciliation marks `CONFIRMED` from chain deltas, updates reserves/custody value, and immediately enters `CAPITAL_REATTEST_REQUIRED` if D56's ceiling is exceeded.

Cancel/reject in the wallet leaves no funding authority behind. Browser-reported success is never sufficient to update authoritative balances.

Also provide the trading-wallet public address/QR for manual funding outside the connector. There is **no automatic treasury pull**, scheduled funding, blanket allowance or background debit from the connected wallet.

## 20.19 System Health

Show every critical dependency independently:

- Birdeye;
- Helius / primary Solana RPC;
- independent simulation RPC;
- Jupiter swap;
- Jupiter Trigger;
- emergency-exit adapter;
- news/social providers;
- model proposer provider;
- model adversary provider;
- Postgres;
- queue;
- worker role heartbeats;
- executor;
- production signer backend + signer-policy layer/gateway;
- autonomous signer workload-identity authorization/policy digest;
- break-glass control readiness (status only; no routine activation);
- wallet reconciliation;
- out-of-band control path;
- risk-authorizer + Release-attestation verification;
- notification delivery channels/escalation path;
- spend/rate budget state;
- direct-pool emergency-route dry-run health.

The browser Wallet Standard connector may expose its own UI connection/error state on Wallet / Custody, but it is **not** a critical System Health dependency: autonomous trading must remain healthy with no connected operator wallet.

For each show:

- state (`HEALTHY`, `DEGRADED`, `FAILED`);
- last successful event/request;
- latency;
- freshness age;
- rate-limit state;
- effect on new entries/exits;
- last probe/error.

## 20.20 Notifications and alert UX

Severity levels:

- `INFO` — ordinary actions/research events;
- `NOTICE` — reserve nearing threshold, strategy paused by data dependency;
- `HIGH` — missing protection, repeated execution failure, wallet mismatch, repeated unreviewed cycles or spend-budget halt;
- `CRITICAL` — unable to exit, unknown transaction, executor or signer compromise/unavailability with exposed positions, emergency circuit breaker.

Alerts include concise summary, affected asset/strategy/system, time/freshness, automated response, operator action and direct drill-down. Critical alerts remain visible until acknowledged/resolved.

**Delivery.** Each severity maps to configured channels: in-app, mobile push and at least one out-of-app channel (Telegram, SMS or email). `CRITICAL` requires two configured channels. Delivery attempts/confirmation are persisted; unhealthy channels are shown as dependencies in System Health.

**Escalation.** Unacknowledged `CRITICAL` alerts re-send on a configured schedule and may escalate to a secondary contact.

**Dead-man rule.** If a `CRITICAL` class of `UNABLE_TO_EXIT`, `WALLET_CUSTODY_MISMATCH` or `EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS` is unacknowledged past the configured interval, the runtime automatically applies `PAUSE_NEW_ENTRIES` and audits it. It never automatically applies `EMERGENCY_CLOSE_ALL`.

**Heartbeat.** A configurable periodic `SYSTEM_ALIVE` notification is delivered while a session/runtime responsibility interval is active so unexpected silence is observable. Intentional `OFF` with no unmanaged exposure suppresses the heartbeat by design. Quiet hours never suppress `CRITICAL`.

## 20.21 Interaction and state rules

### Loading / stale / error

Every real-time widget distinguishes:

- loading/no observation yet;
- live/fresh;
- stale but last-known value shown;
- provider unavailable;
- value not applicable.

Never render `0` as a fallback for missing market/risk data.

### Optimistic UI

Do not optimistically show financial state changes as final. Controls may show `REQUESTED`, but fills, balances, positions and mode changes become authoritative only after backend/chain confirmation as applicable.

### Destructive controls

- `PAUSE_NEW_ENTRIES`: immediate, no confirmation where accidental activation is low-risk;
- ordinary manual close/reduce: concise confirmation with fresh preview;
- `EMERGENCY_CLOSE_ALL`: strong but fast confirmation; never blocked by agent review;
- enable/resume live autonomy: deliberate arming flow.

### Version visibility

Action/detail screens show versions compactly with hover/drill-down rather than overwhelming the main flow.

## 20.22 Mobile operational surface

Mobile must support:

- unmistakable mode/live state;
- equity, exposure, drawdown and reserves;
- open positions + protection status;
- active critical/high alerts;
- recent autonomous actions;
- pause new entries;
- emergency close one position;
- emergency close all;
- approval queue for `LIVE_APPROVAL` if enabled;
- system health summary.

Research labs/complex chart configuration may be desktop-only initially, but no safety-critical function may require desktop.

## 20.23 Human/API/realtime interface contracts

### Browser -> Wallet Standard operator wallet

The web client owns a narrow `SolanaFundingWalletConnector` abstraction backed by `@solana/kit-plugin-wallet` / Wallet Standard. Its application-level verbs are limited to:

```ts
connectFundingWallet(...)
disconnectFundingWallet(...)
getFundingWalletSnapshot(...)
fundTradingWallet(fundingIntentId)
```

`fundTradingWallet` may only sign/send the exact typed funding transaction prepared for the configured trading-wallet destination and allowlisted asset. There is no generic `signTransaction`, arbitrary `send`, autonomous debit, or trading/execution verb exposed to the rest of the application. The backend independently reconciles the submitted signature before recording confirmed funding.

### Browser -> Next.js control API

Only authenticated, authorized operator actions such as:

```ts
setRequestedMode(...)
pauseNewEntries(...)
approveAuthorizationHash(...)
rejectAuthorizationHash(...)
requestManualReduce(...)
requestManualClose(...)
createDraftStrategyVersion(...)
createDraftSkillVersion(...)
promoteReleaseWithStepUp(...)
armReleaseWithStepUp(...)
acknowledgeAlert(...)
runReadinessDrill(...)
```

The browser never calls the executor/risk-authorizer and never receives signing material.

### Worker -> risk-authorizer

Only a canonical action-cycle/intent reference is submitted. The worker state projector separately publishes a signed/sequenced `RiskStateProjection`; callers cannot supply an ad-hoc amount/policy/portfolio blob to be signed. The authorizer reloads the immutable attested Release, clearance and policy, verifies the projection, independently checks D45 hard state + wallet/custody balances through allowlisted RPC, and returns a signed `RiskAuthorizedIntentEnvelope` or typed denial.

### Worker -> execution service

Narrow authenticated internal commands only:

```ts
executeAuthorizedIntent(intentId, authorizationEnvelope)
installAuthorizedProtection(positionId, authorizationEnvelope)
cancelWithdrawAuthorizedProtection(orderId, authorizationEnvelope)
emergencyClose(emergencyCommand)
```

### Realtime UI

Prefer server-published/subscribed typed events rather than polling every table:

```text
market.snapshot.updated
action_cycle.stage_changed
proposal.created
adversary.reviewed
risk.evaluated
intent.authorized
execution.attempt_changed
position.changed
protection.changed
health.changed
readiness.changed
release.promoted
spend.threshold_crossed
notification.delivery_failed
position.review_state_changed
custody.reconciled
alert.raised
mode.changed
```

All event payloads carry canonical IDs and timestamps; UI can refetch authoritative detail after receiving an event.

### Out-of-band emergency interface

A separate signed command interface supports only the D25 emergency verbs and is never exposed as a general trading API.

## 20.24 Accessibility and usability acceptance

At minimum:

- keyboard-accessible primary controls;
- status not communicated by color alone;
- readable live/paper labels and confirmation copy;
- sensible table density controls;
- UTC/source timestamps available on hover while displaying operator-local time by default;
- responsive layouts at common desktop/tablet/mobile widths;
- critical action controls remain reachable under degraded/error states;
- Connected Funding Wallet and Trading Wallet remain visually/semantically distinct at all viewport sizes;
- funding review always displays source, destination, asset, amount and cluster before invoking the external wallet prompt.

Additional acceptance:

- scope selector is visible/persistent on every money/position/action/history screen;
- `Feeds` and `Protection` chrome degrades within one configured freshness interval;
- no human control that increases live authority is reachable without required step-up; risk-reducing emergency controls remain fast;
- a `CRITICAL` test reaches required out-of-app channels within configured delivery SLA;
- Live Readiness `FAIL` blocks arming in E2E;
- `PROTECTION_ONLY` is visible within one state update when adversarial clearance fails;
- Releases UI proves a live artifact cannot be edited in place;
- watchlist membership cannot bypass eligibility;
- Audit Log verifies the latest external integrity checkpoint.

## 20.25 Audit Log

Purpose: reconstruct who/what changed system behavior, when and under which authority. Rows include timestamp, actor (operator/worker/risk-authorizer/executor/out-of-band key/automation), action class, entity, before/after summary, authority evidence, origin and live-impact flag.

Filters include actor, action class, entity, origin, date range and `live-impacting only`. Emergency-journal records imported after DB recovery retain original local timestamp plus import time.

Audit events are append-only and hash-chained. Periodic checkpoint hashes are replicated outside Postgres (for example executor-local journal/immutable object storage) so DB-only rewriting cannot silently recreate the entire integrity history. UI shows last verified checkpoint and raises `CRITICAL` on a break. Signed JSON/CSV export is supported.

## 20.26 Settings and Operator Security

Sections:

- **Operators** — roles `viewer` / `operator` / `admin`, passkeys/TOTP, sessions/revoke; initial deployment may have one admin but role semantics exist from v1;
- **Step-up policy** — actions requiring step-up and read/control session lifetimes;
- **Notifications** — channels, severity routing, escalation contacts, dead-man interval, heartbeat cadence, quiet hours;
- **Display** — timezone, display currency, density/chart defaults;
- **Deployment guardrails (read-only)** — executor caps/trust-root ids, signer-outage unprotected-exposure cap and current capital-attestation ceiling;
- **Signer / custody security (read-only operational state)** — signer provider, signer-policy mode/digest, workload identity status, break-glass readiness/test age, cold-recovery fingerprint, and correlated-provider warning when the same provider also controls Trigger custody;
- **Provider plans (read-only)** — adapter plan/tier and rate-budget assumptions;
- **Wallet connector** — deployment cluster, allowed funding assets, configured trading-wallet destination fingerprint and connector implementation/version; destination/cluster are read-only here if sourced from deployment guardrails.

`viewer` is read-only. `operator` may pause/reduce/close and perform permitted approval work. `admin` additionally promotes Releases, arms live modes, changes live policy/operator/security configuration. Multi-tenant SaaS remains a non-goal.

## 20.27 Watchlist

Manually watched mints show reason/note, added-by, alert rules, eligibility state, last emergency-route snapshot, whether any strategy has produced a candidate and `Request research refresh`. Watchlist membership improves discovery/attention only; it never grants eligibility or execution permission.

## 20.28 Live Readiness

The Section 29 gate is a persistent product screen. Each gate item shows `PASS` / `FAIL` / `STALE` / `NOT RUN`, evidence link, last verified time and expiry. The screen computes distinct `READY FOR LIVE_APPROVAL` and `READY FOR LIVE_AUTO` verdicts consumed by the arming workflow.

Supported safe drills (provider outage, DB-outage emergency close in PAPER, restart reconciliation, notification delivery) have audited `Run drill` controls. A `FAIL` blocks the relevant arming mode.

## 20.29 Releases

A Release is the immutable live binding tuple from D38. The screen shows armed Releases per live strategy, drafts, diffs between Releases, validation evidence (paper/replay/shadow/adversarial/tool-manifest/security tests), promotion/retirement history and `Promote` / `Retire` actions with step-up/audit. Editing a bound artifact creates a draft Release; live artifacts are never edited in place.

---

# 21. System Health and Failure Behavior

## 21.1 Provider freshness contracts

Each provider adapter declares freshness requirements by data class.

Examples:

- active-position price feed: very strict;
- holder distribution: slower tolerance;
- social trends: minutes may be acceptable;
- project metadata: hours/days may be acceptable.

The risk engine consumes health state rather than guessing.

## 21.1A Activity-state health semantics

- `OFF` with no unmanaged exposure is healthy intentional inactivity; provider/worker heartbeat silence is expected.
- if `OFF` carries D61 `OFFLINE_PROTECTED` lots with a future resume deadline, the external `session-resume-watchdog` becomes a required health dependency and its last-success/next-check/deadline state is visible;
- `STARTING` exposes individual warm-up gates and blocks entries until D63 is satisfied.
- `WATCH`, `ACTIVE` and `EVENT_WINDOW` require the configured session/profile health set.
- `WIND_DOWN` prioritizes reconciliation/protection/exits and blocks new entries.
- an attended live session whose browser/operator presence heartbeat exceeds its grace interval automatically applies `PAUSE_NEW_ENTRIES` and alerts; exits/protection continue.
- `OFF` while unmanaged exposure exists is a `CRITICAL` invariant violation.

## 21.2 Degraded modes

### Market feed degraded

- block new entries;
- use Jupiter Price API V3 and executable Jupiter quotes as secondary/reference sources where appropriate;
- maintain/retry exits only when the remaining source set satisfies the exit freshness policy.

### Social/news unavailable

- strategies that require it suspend;
- deterministic momentum strategy may continue if configured and all required data is healthy.

### LLM/adversary unavailable

- AI strategies suspend new entries;
- affected open positions enter `PROTECTION_ONLY`; existing deterministic/provider protection remains active;
- mandatory risk-reducing exits remain independent of model availability;
- non-AI baseline can continue only if explicitly allowed and its deterministic adversarial gate is healthy.

### Jupiter quote/execution unavailable

- no new entries;
- normal exits retry only within bounded policy;
- the independently implemented emergency-exit adapter becomes eligible for risk-reducing held-asset -> SOL/USDC exits;
- if neither route can reduce an open risk position, raise `CRITICAL_UNABLE_TO_EXIT` and keep retry/escalation policy active.

### Chain/RPC finality degraded or halted

- if confirmed/finalized slots stop advancing beyond configured thresholds or independent RPCs materially diverge, block new entries;
- transactions already `confirmed` remain provisional until independently reconciled/finalized;
- a confirmed-then-missing/conflicting transaction enters `REORG_PENDING` and cannot be blindly retried;
- provider-side protective orders remain relevant independently of our worker, but their observed state is also treated cautiously while chain/RPC truth is divergent;
- direct emergency submissions occur only when the configured chain-health policy judges the network able to accept and later reconcile the transaction; otherwise raise/escalate `CRITICAL_UNABLE_TO_EXIT` rather than fabricating success.

### Database unavailable

- no new entries because normal durable intent/audit cannot be guaranteed;
- worker/executor immediately applies a local new-entry pause;
- open-position monitoring may invoke the D22 `EMERGENCY_CLOSE` path using chain/provider custody truth plus deployment-local emergency policy;
- no normal DB-backed intent may be reconstructed or loosened from caller input;
- emergency commands/attempts are written to the executor-local durable journal and reconciled after Postgres returns;
- if chain/quote sources are also unavailable, provider-side protective orders are the remaining independent protection.

### Model/data spend budget exhausted

- no new discretionary cycles for the affected strategy/platform budget;
- open positions become `PROTECTION_ONLY`;
- deterministic stops/provider protection/mandatory exits continue;
- `HIGH` alert until budget reset/authorized policy change.

### Production signer unavailable/degraded

- no new live entries, adds, discretionary protection changes or new on-chain exits can be signed through the normal path;
- already-installed provider-side Trigger protection remains independent of signer availability until it needs a signed cancel/withdraw/change;
- all `MONITORED_EXIT` lots are marked signer-dependent exposure; if any are open, raise `CRITICAL_SIGNER_UNAVAILABLE_WITH_EXPOSURE` and activate escalation/dead-man pause behavior;
- Jupiter-independent direct-pool routing does **not** cure signer outage; it also needs a signature;
- D53 break-glass recovery may be invoked only through its separate control principal/runbook if the incident warrants it;
- new entries remain blocked until signer health, policy digest and workload identity are reverified.

### Executor unavailable

- no new live entries;
- alert prominently;
- provider-side protective orders, if used, remain independent;
- out-of-band signer revocation/break-glass remains available because it does not route through the executor.

## 21.2A Alert-delivery degradation

If a required CRITICAL notification channel is unhealthy, System Health marks notification delivery `DEGRADED`; `LIVE_AUTO` arming is blocked if the configured redundant channel requirement is not met. Existing positions remain protected; notification failure never disables deterministic exits.

If the dead-man deadline for configured critical classes passes without acknowledgement, `PAUSE_NEW_ENTRIES` is imposed independently of dashboard availability.

## 21.2B Session end / bounded offline exposure

A planned session end is not a crash. `WIND_DOWN` performs, in order:

1. stop new candidate entry progression;
2. resolve/reconcile all in-flight execution and custody transitions;
3. refresh every held asset's protection, safety and emergency route state;
4. close any lot that cannot meet D61 `OFFLINE_PROTECTED` policy or keep the runtime alive;
5. persist the planned offline deadline/resume obligation for any allowed protected lot;
6. transition to `OFF` only after the invariant check passes.

Resume always enters `STARTING`; it first reconciles chain/provider fills that may have occurred offline, then refreshes safety/emergency routes and warm-up data before any new entry.

## 21.2C External offline-resume watchdog

D61 permits a runtime to be intentionally `OFF` while time-bounded `OFFLINE_PROTECTED` lots exist. The sleeping worker cannot police its own resume deadline, so a **separate request-shaped watchdog outside the trading runtime** is mandatory whenever any such lot exists.

Reference v1 implementation: Vercel Cron invokes a narrowly authenticated server function/route (for example `session-resume-watchdog`) that reads `ops.runtime_sessions` and the registered offline-protection deadlines from Supabase. It does not trade, sign, install protection, or impersonate the worker. Its only authorities are to:

- detect an overdue required resume / missing expected runtime heartbeat;
- create/escalate the corresponding `CRITICAL` notification through out-of-app channels;
- persist/maintain `PAUSE_NEW_ENTRIES` so the next runtime start cannot silently resume entries;
- record an audited watchdog event.

The watchdog itself has independent health/last-success telemetry. If it is not healthy, the system may not enter or remain in an offline-protected plan that depends on a future resume deadline. Profile 2 attended live may simply refuse intentional offline-protected carry if this watchdog has not been configured/tested.

## 21.3 Restart recovery

On startup every trading worker:

1. acquires its lease;
2. loads open intents/orders/positions;
3. queries chain/provider state;
4. reconciles before accepting new work;
5. resumes monitoring.

Never assume database `OPEN` means the chain position is still open.

---

# 22. Observability

## 22.1 Structured logs

Every log carries relevant IDs:

- candidate;
- strategy version;
- proposal;
- intent;
- order;
- position;
- provider request correlation.

Secrets and private keys are redacted by construction.

## 22.2 Metrics

Track:

- provider latency/error/rate limits;
- WebSocket reconnects;
- queue age/depth;
- candidate counts;
- agent latency/error/schema failures;
- quote latency;
- decision-to-submit latency;
- transaction success/failure;
- reconciliation mismatches;
- stale-data blocks;
- circuit-breaker trips;
- Trading Skill tool latency/errors;
- proposer/adversary agreement, challenge and rejection rates;
- adversarial-loop latency and expiry cost;
- open-position reassessment lateness;
- emergency-exit adapter health/use;
- wallet reserve thresholds;
- per-strategy model/data/RPC cost and platform operating cost.

## 22.3 Alerts

High-priority alerts:

- wallet mismatch;
- live executor unhealthy while positions open;
- production signer/signing-policy unhealthy while positions open;
- signed risk-state projection invalid/stale or materially disagrees with independent chain reads;
- capital attestation ceiling exceeded / `CAPITAL_REATTEST_REQUIRED`;
- protective order missing where required;
- repeated failed exits;
- drawdown circuit breaker;
- provider outage affecting open positions;
- unexpected mode change;
- unknown transaction from trading wallet.

---

# 23. Security Model

## 23.1 Threats to explicitly design against

- prompt injection from news/social;
- compromised LLM provider response;
- compromised public API/provider data;
- stolen provider API key;
- stolen web session;
- forged internal request to executor;
- duplicate queue delivery;
- database tampering, including authorization-input/projection tampering;
- compromised/stolen executor workload identity at the signer backend;
- signer-backend/policy outage or misconfiguration;
- leaked private key;
- malicious token with transfer restrictions;
- transaction substitution;
- stale/replayed approval;
- chain reorg/confirmation ambiguity;
- worker crash between submission and persistence.

## 23.2 Required controls

- Supabase Auth + RLS for dashboard-accessible data;
- service roles scoped to backend only;
- production trading-wallet key non-exportable in a dedicated Ed25519 signer backend; only executor workload identity may invoke it;
- separate asymmetric risk-authorization signing key in its own isolated risk-authorizer process/container;
- executor-pinned risk-authorizer public key and hard absolute caps;
- approval grants bound to exact authorization hash/nonce/expiry;
- authenticated internal executor endpoint;
- separate signed out-of-band emergency-control path;
- idempotency and nonce/replay protection;
- pre-submit durable execution attempt persistence;
- structural + independent-RPC simulation semantic transaction validation;
- strict Zod validation at every external boundary;
- prompt content treated as data;
- asset IDs resolved server-side;
- owned-wallet/vault self-influence exclusion;
- immutable audit events plus executor-local emergency journal;
- live-mode dual arming plus immutable operator-attested Release binding;
- WebAuthn/passkey step-up (TOTP fallback) for human risk-increasing control changes;
- secret redaction tests;
- dependency scanning;
- least-privilege provider keys where supported;
- explicit Trading Skill tool allowlist with no generic HTTP/SQL/shell/wallet tool;
- mandatory adversarial-clearance evidence on every discretionary autonomous live intent;
- automated invariant proving mandatory risk exits cannot be vetoed by model output;
- independent emergency-control signing key and replay protection;
- out-of-app critical alert delivery/escalation/dead-man pause;
- model/provider spend and invocation-rate circuit breakers;
- direct-chain verification/cross-check for hard token-security fields;
- canonical contract-set digest embedded in every live-capable deployable and checked at build/startup/readiness;
- deployable-specific forbidden-import static analysis plus runtime egress/network-policy verification;
- generated property-based tests mapped one-to-one to every critical invariant;
- separate adversarial code-review pass by a reviewer/model session that did not author the implementation being reviewed.

## 23.3 Browser boundary

The browser may request a mode/control change through authenticated server routes. It never gets:

- wallet private key;
- service role key;
- provider secret;
- unsigned transaction to modify and return for autonomous live execution.

---

# 24. Testing Strategy

## 24.1 Unit tests

High coverage required for:

- feature calculations;
- eligibility hard rejects;
- risk sizing;
- drawdown/circuit breakers;
- candidate expiry;
- state machines;
- idempotency;
- prompt output validation;
- point-in-time query rules.

## 24.2 Contract tests

Recorded/fixture responses for:

- Birdeye;
- Helius;
- Jupiter;
- LunarCrush;
- CryptoPanic;
- each LLM provider.

Provider schema drift must fail visibly rather than silently produce zeroes.

The **first Jupiter Trigger integration contract** must verify the exact deployed Trigger/LO V2 mode's seeded per-order custody/balance isolation before any strategy may bind provider protection to same-mint multi-strategy lots. Documentation is evidence, not proof of the exact production API behavior. Use a provider-supported test environment where available; otherwise use the smallest deliberately authorized isolated mainnet probe and record the result.

Cross-module contract tests must also serialize/deserialize canonical fixtures through every app boundary (`web` ↔ DB/control contracts, `worker` ↔ `risk-authorizer`, `worker` ↔ `execution-service`, executor journal/recovery). No deployable may redefine a canonical wire schema locally.

## 24.3 Execution harness

A fake Jupiter/Solana environment must simulate:

- successful fill;
- failed before submission;
- unknown submission result;
- landed transaction but response timeout;
- partial/changed amount;
- stale blockhash;
- slippage failure;
- duplicate worker delivery;
- quote becomes invalid between risk check and execution;
- remote signer timeout followed by retry of identical canonical bytes;
- signer unavailable while provider-protected and monitored-exit lots are both open;
- signer policy denies an unexpected program/recipient even after executor compromise fixture;
- crash after durable `SIGNED_NOT_SUBMITTED` write but before submit;
- crash after submit but before response persistence;
- malicious/tampered transaction whose simulation moves an unrelated token;
- unexpected signer/authority in assembled transaction;
- Jupiter Trigger deposit and two-step cancel/withdraw lifecycle;
- explicit stop slippage enforcement;
- Jupiter unavailable -> direct-pool emergency adapter builds/simulates/submits a risk-reducing close;
- stale/unusable emergency route snapshot blocks autonomous entry or produces a critical unable-to-exit state as appropriate;
- direct-pool adapter cannot create a buy, exposure increase or arbitrary-recipient transfer.

## 24.4 Reconciliation tests

Test database/chain disagreement:

- DB says open, wallet empty;
- wallet holds token, DB has no position;
- protective order filled while worker offline;
- manual external wallet transfer;
- authorized wallet→registered-vault movement does not false-positive;
- unmatched vault/wallet movement pauses trading;
- strategy lots sum to aggregate physical/custody holdings;
- transaction finalized after service restart;
- DB outage emergency close reconciles correctly after recovery;
- same mint held by two strategies, lot-scoped provider orders, one provider fill -> only the originating lot is reduced;
- provider protection mode without lot isolation falls back to `MONITORED_EXIT`;
- DB outage evaluates stops from the latest durable position shadow while chain truth caps actual sell quantity;
- stale/corrupt shadow cannot create/increase exposure;
- transaction observed `confirmed` then missing/conflicting before `finalized` -> `REORG_PENDING`, no duplicate submission;
- independent RPCs disagree on signature/account state -> entries pause until reconciliation;
- chain/finality stall preserves provisional exposure/protection without promoting realized P&L to final.

## 24.5 Adversarial AI and autonomous-action tests

Required cases include:

- open-position review `CHALLENGE` exhaustion -> `PROTECTION_ONLY`, not implicit HOLD/EXIT;
- adversary/model outage -> `PROTECTION_ONLY` while deterministic stop remains active;
- evidence refresh invalidates old proposal clearance and proposer/adversary share the new cutoff;
- spend-budget exhaustion halts discretionary cycles without disabling hard exits;
- T0/T1 cannot skip their declared adversarial control to meet latency;
- malicious provider/news/model input cannot reach risk-authorizer key/process;


Fixtures containing malicious source text such as instructions to ignore policy or transfer assets must never escape the Trading Skill schema or reach an execution tool.

Additionally test:

- every autonomous `ENTER`, `HOLD` on open exposure, `REDUCE`, discretionary `EXIT`, and `ADJUST_PROTECTION` action creates an adversarial review before risk authorization;
- a `CHALLENGE` can cause one bounded revision but cannot loop forever;
- an adversary cannot create/upgrade a trade by itself;
- adversary outage fails closed for discretionary actions;
- hard stops/emergency exits execute even if proposer/adversary providers are down;
- proposer and adversary cannot access forbidden tools;
- future/replay evidence cannot leak into either side of the adversarial loop.

## 24.6 Property/invariant tests

These tests are mandatory **generated build artifacts**, not aspirational manual checks. Maintain an `invariant-test-map` that assigns every critical invariant below a stable invariant id, owning module(s), property-based test(s) and adversarial/compositional test(s). CI fails if any invariant has no mapped executable test.

Use property-based/fuzz generation (for TypeScript, `fast-check` or equivalent) for amounts, timing/interleavings, partial fills, retries, lot allocations, cutoffs, expiry boundaries and state-machine transitions rather than testing only hand-picked examples.

Critical invariants:

- no live signature without an allowed, unexpired intent;
- no intent amount greater than risk-evaluated maximum;
- no entry for ineligible asset;
- no duplicate active entry from same idempotency key;
- no live trade while `PAUSED` or `OBSERVE/PAPER`;
- DB tampering after authorization cannot change executable amount/mint/side/slippage/expiry;
- DB-only tampering cannot create a valid newer/wider `RiskStateProjection` or cause entry authorization when independent D45/wallet chain reads disagree;
- executor absolute cap cannot be exceeded by database policy, and aggregate exposure enforcement continues from the local `ExecutorExposureLedger` when DB market projections are unavailable;
- no new `LIVE_AUTO` entry may exceed the signer-outage unprotected-exposure cap for `MONITORED_EXIT` lots;
- stale/replayed approval cannot authorize a changed or expired envelope;
- our own wallet/vault flow cannot satisfy a smart-money/candidate trigger;
- no DB-independent emergency command can increase exposure or send to an arbitrary address;
- no strategy sees evidence from the future in replay;
- no discretionary autonomous live intent exists without a cleared adversarial action cycle;
- no mandatory risk-reduction action can be blocked by an adversary;
- no Trading Skill tool invocation can reach an unregistered tool;
- no LIVE_AUTO strategy can run with a mutable/unversioned skill, guideline or automation set;
- risk-authorizer cannot sign against an unattested/mismatched Release digest;
- a proposal under cutoff v1 cannot be adversarially cleared under cutoff v2 without proposer revision;
- an unresolved open-position discretionary cycle cannot persist a cleared `HOLD`; it enters `PROTECTION_ONLY`;
- budget exhaustion cannot suppress deterministic mandatory exits;
- no transition can promote `CONFIRMED_PROVISIONAL` execution/accounting state to final P&L without `finalized` evidence;
- a `REORG_PENDING` attempt cannot be replaced/retried while the original transaction remains potentially landable;
- cross-module encode/decode of every canonical live contract preserves semantic equality and contract-set digest;
- normal autonomous signing cannot bypass the external signer-side policy layer;
- revoking the executor signer identity prevents further normal signatures without needing the executor or Postgres;
- `SWEEP_TO_COLD_RECOVERY` cannot target anything except the pinned cold-recovery wallet/canonical token accounts;
- crossing the live capital attestation ceiling blocks new exposure until re-attestation or risk reduction.

---


## 24.7 UI/UX end-to-end tests

Automated/browser tests must prove at minimum:

- PAPER and LIVE_AUTO are visually distinguishable on every primary route;
- live arming cannot complete while a required readiness gate fails;
- pause is available from all operational surfaces and mobile;
- an action inspector can reconstruct proposer -> adversary -> risk -> execution from a completed trade;
- an open-position HOLD cycle is visible and auditable;
- stale market data is visibly stale and cannot be mistaken for zero/fresh data;
- approval binds to the exact authorization hash and expires visibly;
- critical alerts persist until resolved/acknowledged;
- wallet/custody reconciliation mismatch is surfaced prominently;
- mobile can pause and emergency-close without desktop navigation;
- Control Room exposure equals the authoritative sum of reconciled `trading.position_lots` for the selected scope;
- `PROTECTION_ONLY`, `REORG_PENDING`, signer-health and chain-finality degradation propagate to the relevant UI surfaces within one declared realtime/refresh interval;
- a contract-set digest mismatch or failed isolation/readiness gate is visible and prevents live arming rather than appearing as a generic backend error.

## 24.8 Deployable isolation and generated-artifact verification

CI and pre-live verification inspect the **built artifacts/runtime manifests**, not only source intent.

Required checks:

- `risk-authorizer`: no LLM SDKs, Solana **wallet/signing** libraries, DEX SDKs, browser code or generic provider/news clients. A narrowly scoped **read-only Solana RPC client/decoder** is explicitly permitted because D52 requires independent hard-state/balance reads; it must expose no signer/keypair/send-transaction capability. Network egress is deny-by-default with only configured database/control-plane/telemetry and allowlisted read-only Solana RPC endpoints allowed;
- `execution-service`: no LLM/news/social SDKs; only approved Solana/Jupiter/direct-DEX/signer/RPC dependencies and endpoints; it has no direct byte-signer permission when a separate D55 signer-policy gateway is required;
- `signer-policy-gateway` when present: no LLM/news/social/strategy/database-write surface; only transaction-policy validation + signer-backend access, with deny-by-default egress;
- `worker`: no production wallet-signer credentials/SDK authorization path and no risk-authorizer private key;
- `web`: no service-role, risk-authorizer or production trading-signer credentials;
- container/image/SBOM scan verifies forbidden packages are absent from final artifacts, including transitive dependencies where policy marks them forbidden;
- runtime egress tests attempt forbidden destinations and must fail;
- each deployable reports the same canonical contract-set digest before Live Readiness can pass.

A static Dockerfile review alone is insufficient.

---

# 25. Data Retention

Suggested initial policy; make configurable.

- 15s market bars: short retention (e.g. weeks) except snapshots tied to decisions.
- 1m bars: medium/long research retention.
- 5m+ bars: long retention.
- decision feature snapshots: permanent.
- candidate records: permanent.
- normalized evidence metadata used in decisions: permanent.
- raw third-party content: per provider licensing/retention terms.
- agent inputs/outputs: permanent subject to provider/content terms;
- Trading Skill action cycles, adversarial reviews, automation runs and tool invocation metadata: permanent.
- quotes/order/fills/positions: permanent.
- audit ledger: permanent.
- health telemetry: rolled up after operational window.

Partition large time-series tables by time and index by `(asset_id, bucket_time)`.

---

# 26. Configuration

Configuration is split into three trust classes.

## 26.1 Deployment secrets / trust roots

- provider API keys;
- service authentication secret/mTLS material;
- production wallet private key — **not an application secret**; non-exportable inside the selected signer backend;
- normal signer-backend authorization credential/workload identity — held only by the native-policy execution identity or isolated D55 signer-policy gateway as applicable;
- signer-policy identity/digest/trust configuration — pinned outside mutable trading rows;
- break-glass signer/control credential — separately controlled outside application deployables; never mounted into executor/worker/web;
- pre-registered cold-recovery wallet public key/fingerprint — pinned in signer/recovery control plane and offline runbook;
- worker `RiskStateProjection` private signing key — state-projector role only;
- projection public verification key(s) — risk-authorizer pinned config;
- risk-authorization private key — risk-authorizer only;
- risk-authorization public verification key — executor pinned config;
- operator emergency-command public key — worker/executor pinned config;
- accepted admin step-up/WebAuthn trust fingerprints for Release/control attestation — risk-authorizer/control verifier;
- Supabase backend credentials where needed.

## 26.2 Executor absolute guardrails

These are non-database hard ceilings/trust roots loaded at deployment:

- live capability enabled/disabled;
- maximum per-entry notional;
- maximum aggregate non-settlement exposure;
- allowed settlement mints;
- accepted risk-authorizer key ids;
- accepted emergency-operator key ids;
- expected signer-policy id/digest and signer workload-identity fingerprint;
- hard maximum live/protective slippage;
- allowed network/cluster;
- canonical trading-wallet public address/fingerprint exposed to the web funding flow;
- allowed browser-funding asset mints (initially SOL/USDC).

Day-to-day strategy/risk tuning should **not** use these values. They exist so a database compromise cannot widen the blast radius. Increasing them is a deliberate deployment action; versioned database policy remains the normal, stricter control plane.

## 26.3 Versioned database policy

- strategy versions and speed/latency contracts;
- Trading Skill versions/tool manifests;
- guideline versions;
- automation-set definitions/versions;
- proposer/adversary model policies;
- token eligibility thresholds;
- deterministic taxonomy/correlation cohort definitions and limits;
- strategy sleeve allocations;
- normal risk limits;
- data freshness;
- stop/target policies;
- strategy parameters;
- provider protection mode and lot-isolation capability;
- strategy/account signer-outage unprotected-exposure limit (must be <= deployment cap);
- operator-attested live capital ceiling / re-attestation state;
- human-reaction floor / LIVE_APPROVAL eligibility;
- model/action-cycle/provider spend and rate budgets;
- notification severity/escalation/dead-man policy;
- emergency-route adapter/program/version configuration.

## 26.4 Runtime controls

- operating mode;
- paused strategies;
- token allow/deny overrides;
- emergency state;
- `PROTECTION_ONLY` / `BUDGET_PAUSED` / `CAPITAL_REATTEST_REQUIRED` operational states;
- alert acknowledgement/escalation state.

Normal controls are audited in Postgres. The out-of-band signed kill path can impose a local pause/emergency state without Postgres; it must be reconciled into the audit ledger after recovery.

Do not hide ordinary live risk changes inside an environment variable. Deployment guardrails are only hard upper bounds/trust roots, not the strategy-control surface.

---

# 27. Initial Risk Defaults

These are conservative **starting configuration for experimentation**, not claims about optimal trading parameters. They remain editable/versioned.

For the first funded experiment, configure small absolute and percentage caps. Example starting posture:

- small dedicated trading wallet;
- modest fraction of account equity per position;
- low percentage of equity at risk at the defined stop;
- few simultaneous positions;
- hard daily drawdown circuit breaker;
- no leverage;
- no averaging down unless a later strategy explicitly and deterministically supports it;
- no martingale sizing;
- no increase in position merely because model confidence is higher;
- strict price-impact/slippage caps;
- no new entry when critical feeds are degraded;
- explicit minimum SOL gas reserve and settlement-capital reserve alerts;
- manual wallet funding only;
- emergency-exit provider readiness required before LIVE_AUTO arming.

The UI should display the actual configured values prominently rather than burying them in code.

---

# 28. Implementation Phases

The system is not considered complete until all phases required for live capability are finished. Development can be staged without releasing a half-built trading product.

## P0 — Repository, contracts and invariants

Deliver:

- four-app Nx monorepo (`web`, `worker`, `risk-authorizer`, `execution-service`) with isolated runtime manifests, trust/scope project tags, enforce-module-boundaries rules and the D57/D58 profile-aware hosting topology encoded in deployment/IaC manifests;
- canonical shared Zod domain contracts in `/libs/contracts`, with local duplicate wire schemas forbidden;
- generated contract-set digest + cross-module compatibility harness;
- Supabase project/migrations + Realtime Broadcast + durable `pgmq`/Supabase Queues baseline;
- auth;
- worker heartbeat framework;
- versioned config model;
- signed/sequenced `RiskStateProjection` contract/projector key boundary;
- mode/audit model;
- point-in-time `Clock` abstraction;
- base OpenTelemetry/Sentry/DigitalOcean Monitoring/Vercel observability wiring;
- canonical intent/risk-authorization/approval/emergency-command contracts;
- executor-local durable journal contract;
- deterministic risk-cohort schema;
- immutable Release + step-up attestation contract;
- `PROTECTION_ONLY`, spend-budget and position-shadow state contracts;
- browser Wallet Standard connector contract + typed `FUND_TRADING_WALLET`/funding-event schema with no backend signing authority.

Acceptance:

- every deployable imports the canonical contract package, embeds the same contract-set digest and passes cross-boundary encode/decode compatibility tests;
- mode changes audited;
- workers recover leases;
- Vercel deploy contains only `/apps/web`; no worker/risk/executor entrypoint is deployable as a Vercel Function/Cron/Workflow;
- Profile 0/1 manifests prove logical process/credential boundaries without provisioning paid hardened hosts; Profile 4 Terraform/DigitalOcean manifests prove three distinct Droplets, VPC/firewall boundaries, separate service secrets and service-specific attached persistence for worker/risk-authorizer/execution-service;
- only executor stub has normal wallet-signature-request capability; risk-authorizer stub has only its distinct envelope-signing key and is process-isolated from the worker.

## P1 — Market data and asset registry

Deliver:

- Birdeye adapter;
- asset discovery;
- market stream;
- OHLCV storage;
- feature snapshots;
- token identity by mint;
- freshness/health;
- Jupiter Price API V3 secondary price adapter.

Acceptance:

- live eligible/watch universe populates;
- chart data updates continuously;
- reconnect/backfill prevents obvious candle gaps;
- stale feed blocks candidate progression.

## P2 — Security/eligibility and on-chain intelligence

Deliver:

- token security adapter;
- holder distribution;
- smart-money/top-trader integration;
- Helius tracked-wallet events;
- eligibility state machine;
- hard reject reasons;
- route/price-impact probes;
- open-position safety state and exit-compatibility re-evaluation.

Acceptance:

- unsafe/untradeable fixtures are deterministically rejected;
- every eligible token has a current evidence-backed eligibility record;
- no candidate can bypass eligibility;
- a held asset can become ineligible without becoming mechanically unsellable by policy.

## P3 — Signal and candidate engine

Deliver:

- multi-horizon features;
- relative strength/regime;
- trigger families;
- candidate dedupe/cooldown/expiry;
- deterministic momentum baseline;
- self-influence/owned-address suppression guard.

Acceptance:

- candidates arise from live data without LLMs;
- each candidate explains the exact trigger/features;
- baseline can paper-decide candidates by itself.

## P4 — News/social intelligence

Deliver:

- LunarCrush adapter;
- CryptoPanic adapter;
- normalization/deduplication;
- source quality;
- novelty/first-seen handling;
- asset entity matching.

Acceptance:

- repeated syndicated story becomes one underlying catalyst cluster;
- source/event/first-seen time retained;
- replay query cannot expose future evidence.

## P5 — Autonomous Trading Skill + adversarial agent layer

Deliver:

- model gateway;
- versioned Trading Skill and typed tool manifest;
- versioned guidelines;
- candidate and open-position automations;
- proposer action schema/runtime;
- mandatory Action Adversary schema/runtime;
- bounded challenge/revision loop;
- prompt-injection/tool boundaries;
- model/version/cost logging;
- strategy integrations S1–S4;
- explicit speed/latency-tier contracts.

Acceptance:

- malformed model output fails closed;
- model has no wallet/executor/general HTTP/SQL/shell tool;
- every discretionary exposure action receives adversarial review;
- adversary can reject/challenge but cannot create or authorize a trade;
- hard risk exits do not wait for an LLM;
- open-position HOLD is recorded as an action cycle;
- every agent action is reproducible from stored evidence/tool/action/adversarial records.

## P6 — Risk, portfolio and execution boundary

Deliver:

- portfolio accounting;
- deterministic sizing;
- policy versioning;
- circuit breakers;
- intent idempotency;
- isolated risk-authorizer process/container with Release-attestation verification;
- isolated execution service;
- Jupiter Swap V2 integration;
- production non-exportable Ed25519 `TradingWalletSigner` adapter using Turnkey as the reference v1 implementation; Privy/equivalent policy-capable signers may exist only behind the same adapter and readiness gates; dev-only local-key adapter is prohibited from Live Readiness;
- signer-side transaction policy outside the executor (native provider policy or isolated signer-policy gateway) with policy digest/version;
- separate break-glass signer identity, out-of-band executor-signing revocation and pinned cold-recovery sweep path;
- signed/sequenced `RiskStateProjection` projector/verification path plus independent risk-authorizer D45/wallet chain reads;
- asymmetric signed risk-authorization envelope;
- executor deployment absolute caps;
- approval-envelope verification contract;
- independent-RPC simulation + semantic transaction validation;
- durable pre-submit `SIGNED_NOT_SUBMITTED` journal/attempt state;
- staged `confirmed`/`finalized` transaction reconciliation plus `REORG_PENDING`/RPC-divergence handling;
- full Jupiter Trigger V2 auth/vault/deposit/cancel-withdraw adapter;
- direct-pool Raydium/Orca/Meteora risk-reducing emergency-exit adapters with persisted route snapshots/dry-runs;
- DB-independent emergency-close class, local position-risk shadow and durable journal persisted on separate DigitalOcean Block Storage volumes with service-specific mounts and application-level encryption.

Acceptance:

- live-capable executor exists;
- cannot sign arbitrary transaction from external caller;
- duplicate deliveries do not double-enter;
- ambiguous network results reconcile before retry;
- hard policy cannot be overridden by agent output or database-row tampering;
- a signed transaction is durably identifiable before submission;
- malicious assembled transactions fail semantic simulation validation;
- Trigger vault movements reconcile as known custody;
- DB-down emergency close can reduce but never increase exposure;
- the emergency-exit adapter can reduce held risk to approved settlement assets when Jupiter is unavailable;
- compromising the general worker cannot expose the risk-authorizer private key;
- an unattested/mismatched Release cannot receive a live risk authorization;
- same-mint provider protection preserves lot attribution;
- signer compatibility/identity/recovery tests prove the configured non-exportable signer derives/signs for the expected Solana wallet;
- confirmed fills become protected provisional exposure promptly but cannot become final realized P&L until finalized;
- Trigger seeded-account lot isolation contract test is green before provider protection is enabled.

## P7 — Full trade lifecycle and paper/live modes

Deliver:

- OBSERVE/PAPER/LIVE_APPROVAL/LIVE_AUTO/PAUSED;
- live-paper quote simulation;
- position monitor;
- stop/target/trail/time exits;
- approval workflow cryptographically bound to risk authorization, step-up and human-reaction floor;
- exposure-reducing cleared actions auto-execute by default in LIVE_APPROVAL;
- unresolved open-position review -> `PROTECTION_ONLY`;
- model/data/provider spend circuit breakers;
- live strategy capital sleeves + position-lot attribution;
- open-position Trading Skill reassessment automations and persisted HOLD cycles;
- manual close/reduce;
- restart recovery;
- out-of-band signed pause/close control path.

Acceptance:

- same strategy code runs in paper and live;
- only execution adapter changes behavior;
- browser closure does not affect monitoring;
- live arming requires deployment enable + requested live mode + valid attested Release + passing mode-specific Live Readiness verdict;
- open positions recover correctly after worker restart.

## P8 — Full product UI / UX / interfaces

Deliver all operator, research, autonomy, system and mobile surfaces in Section 20 on the D58 Next.js 16/Vercel UI stack, including global scope selector, Watchlist, Audit Log, Settings/Operator Security, Live Readiness, Releases, notification delivery/escalation, Supabase Broadcast realtime interface contracts, the Solana Kit/Wallet Standard Connected Funding Wallet + manual funding workflow, and explicit loading/stale/error states.

Acceptance:

- PAPER/LIVE_APPROVAL/LIVE_AUTO/PAUSED are impossible to confuse;
- every trade and open-position HOLD is explainable from the UI;
- proposer/adversary disagreement and current action-cycle stage are visible;
- Trading Skill, guideline and automation versions are inspectable;
- risk/custody/system health are visible without logs/SQL;
- live arming follows the Release-bound readiness-review + step-up UX;
- risk-increasing controls enforce role + step-up while pause/reduce/close remain fast;
- critical notification delivery/escalation/dead-man state is visible/testable;
- stale data cannot masquerade as live/zero data;
- emergency controls and approval queue work on mobile where applicable;
- Wallet Standard connect/disconnect and SOL/USDC manual funding work without exposing the trading signer; rejected/disconnected wallet prompts leave autonomous runtime unchanged;
- every funding transaction is visibly bound to the configured trading-wallet destination and is reconciled from chain truth before balances/state update.

## P9 — Replay/research framework

Deliver:

- replay clock;
- historical/captured replay;
- point-in-time evidence enforcement;
- cost model;
- strategy comparison;
- proposer/adversary disagreement attribution;
- latency-cost attribution;
- trading/strategy-economic/platform-economic P&L;
- attribution/confidence dashboards.

Acceptance:

- a replay test intentionally attempting future evidence fails;
- baseline and AI strategies run against the same timeline;
- results identify strategy/model/prompt/data versions.

## P10 — Adversarial hardening and live-readiness closure

Deliver:

- threat-model review;
- secret scan;
- prompt-injection tests;
- provider outage drills;
- duplicate/timeout execution drills;
- restart/reconciliation drills;
- emergency controls including DB/web-down drills;
- signer-outage + executor-compromise + break-glass/cold-recovery drills;
- risk-state projection tamper/rollback/freshness + independent-chain-mismatch drills;
- post-arm funding/capital re-attestation drill;
- DB-tamper/approval-replay/self-influence tests;
- Trigger vault deposit/cancel-withdraw drills;
- full audit review;
- production runbook including complete-infrastructure-loss/chain-first recovery;
- wallet reserve and manual-funding runbook;
- economic-cost attribution closure;
- Release-attestation / risk-authorizer isolation drills;
- spend-budget and `PROTECTION_ONLY` drills;
- out-of-app notification/escalation/dead-man drills;
- direct-pool emergency-route dry-run/forced-Jupiter-outage drills;
- wallet-connector tests: wrong cluster, destination substitution attempt, arbitrary-instruction injection, rejected signature, browser-close mid-prompt, fake provider success, duplicate funding notification and proof that connector disconnect cannot affect autonomous execution;
- canonical-contract digest/cross-module compatibility gate;
- forbidden-import/container-artifact scan and runtime egress isolation tests;
- property-based invariant suite with zero unmapped §24.6 invariants;
- independent adversarial code-review pass by a different AI instance/session or human reviewer against every §32 item and compositional combinations;
- confirmed→reorg/RPC-divergence/chain-stall drills;
- MEV/execution-shortfall measurement and direct-pool landing-mode drill.

Acceptance:

- all critical invariants automated;
- no unresolved high-severity finding;
- live execution path is fully implemented even if operational mode remains PAPER;
- a tiny deliberate mainnet execution test can be performed when the operator decides to validate the path.

---

# 29. Live-Readiness Gate

Readiness is profile-aware. The UI computes at least:

- `READY_FOR_ATTENDED_TINY_LIVE` (Profile 2): preserves signer/policy/risk/adversary/execution/capital/reconciliation protections but may accept single-host physical co-residency and requires operator-presence heartbeat + deliberately tiny attested capital;
- `READY_FOR_UNATTENDED_LIVE_PILOT` (Profile 3): adds persistent-runtime, watchdog/durability and unattended-alert requirements;
- `READY_FOR_HARDENED_LIVE_AUTO` (Profile 4): requires the full physical-isolation and hardened infrastructure gate below.

No profile may waive transaction authorization, signer policy, deterministic risk, Action Adversary, chain reconciliation or hard capital caps merely to save hosting cost. Infrastructure/isolation gates are introduced at the profile where their threat reduction is economically justified.

`LIVE_AUTO` may exist in the application before it is used. Before first **hardened unattended autonomous funding**, require an explicit readiness record confirming:

- live-paper trade sample is large enough to evaluate;
- selected strategy version is named;
- bound Trading Skill/guideline/automation-set versions are named and immutable;
- mandatory Action Adversary coverage tests are green for all discretionary exposure actions including open-position HOLD;
- hard-stop/emergency tests prove LLM unavailability cannot block mandatory exits;
- risk policy version is frozen;
- production signer uses a non-exportable Ed25519 backend; configured wallet public key, signature compatibility, signer workload identity, audit logging and provider-specific recovery path are verified;
- production signer contract tests prove canonical Solana Ed25519 transaction signing, policy enforcement, timeout/retry behavior, audit metadata and break-glass recovery against the selected Turnkey/Privy/equivalent backend;
- when Turnkey is selected, explicit deny-export policy is active for both autonomous and break-glass principals, its policy/version identity is pinned, and attempted export under each principal is denied in a readiness contract test;
- when Turnkey + Jupiter versioned transactions are selected, the exact `/order` route classes pass the D55 address-lookup-table policy compatibility suite: legitimate routes sign, lookup-table/program-key behavior matches the pinned policy, and malicious/unsafe placeholder or transfer cases deny rather than widening policy;
- `LIVE_AUTO` signer-side transaction policy is active outside the executor (native provider policy or isolated signer-policy gateway), its policy digest/version is pinned, and an unapproved-program/recipient test is denied;
- signer-outage drill proves new entries stop, provider protection remains independent where installed, signer-dependent monitored exposure alerts/escalates, and direct-pool fallback is not incorrectly treated as signer-independent;
- D33 signer-outage unprotected-exposure cap is configured/tested;
- D53 break-glass identity activation, signer revocation and D54 cold-recovery sweep are exercised in a controlled DR drill without using the executor;
- no raw/local software trading key is selected for a mainnet live mode;
- risk-authorizer runs in its isolated process/container and its signature/DB-tamper boundary tests are green;
- signed/sequenced risk-state projection tamper/rollback/freshness tests are green and risk-authorizer independent D45/wallet chain-read mismatch denies entry;
- active Release digest has valid operator step-up attestation and matches the risk-authorizer/executor view;
- executor absolute caps independently verified;
- pre-submit durability/recovery test green;
- approval hash binding/replay tests green for `LIVE_APPROVAL`;
- wallet contains only intended experiment capital and current recognized wallet/custody value is at or below the operator-attested D56 capital ceiling;
- post-arm funding/capital-ceiling test proves `CAPITAL_REATTEST_REQUIRED` blocks the next exposure-increasing intent until step-up re-attestation or risk reduction;
- no unknown wallet transactions;
- reconciliation clean;
- provider health alerts configured;
- CRITICAL out-of-app delivery, escalation and dead-man pause tests green;
- spend/rate budgets configured and enforcement tests green;
- normal and out-of-band emergency controls tested;
- DB-down emergency close tested;
- provider-independent direct-pool emergency-exit adapter tested and healthy for every asset currently eligible for LIVE_AUTO;
- emergency-route snapshot dry-runs are fresh;
- wallet SOL/USDC reserve thresholds healthy;
- if the built-in funding connector is used for initial funding, its transaction has reconciled on-chain to the configured trading wallet; connector presence/connection is **not** required for continued live readiness;
- Trigger vault/cancellation lifecycle tested for any strategy using provider protection;
- signer-provider vs protective-custody provider concentration is explicitly recorded; using Privy for both production signing and Jupiter Trigger custody requires an acknowledged correlated-provider risk in the readiness record;
- exact Trigger mode/version lot-isolation contract test green before lot-scoped provider protection is used;
- canonical contract-set digests match across all live-capable deployables;
- forbidden-import/artifact and runtime egress-isolation checks are green;
- every §24.6 invariant has an executable property-test mapping and the suite is green;
- independent adversarial code-review closure has no unresolved critical/high-severity invariant defect;
- chain confirmation/finality/reorg/RPC-divergence drills are green;
- MEV/adverse-execution cost model and execution-path telemetry are enabled;
- execution harness green;
- data freshness gates green;
- complete infrastructure-loss/chain-first recovery runbook exercised;
- Section 20 Release, step-up, live-readiness, live-arming, stale-data, `PROTECTION_ONLY` and mobile emergency E2E tests green;
- activity/capital-authority state-machine E2E tests prove `OFF`/`STARTING`/`WATCH`/`ACTIVE`/`EVENT_WINDOW`/`WIND_DOWN` are orthogonal to `OBSERVE`/`PAPER`/`LIVE_APPROVAL`/`LIVE_AUTO` and `PAUSED` cannot be schedule-cleared;
- `END SESSION` refuses `OFF` while any execution/custody transition is in-flight or any lot is unmanaged under D61;
- any plan carrying `OFFLINE_PROTECTED` lots across a runtime-off period has a healthy/tested external `session-resume-watchdog`; an overdue resume raises/escalates `CRITICAL` and persists `PAUSE_NEW_ENTRIES` while the worker is still off;
- `STARTING` warm-up/backfill test proves candidates cannot score before required indicator history exists and BACKFILL events do not masquerade as live first-seen evidence;
- catalyst-window test proves source-time age, not session ingestion time, controls expiry;
- attended Profile 2 presence-heartbeat loss pauses new entries without disabling exits;
- no open severity-1/security defects.

This gate is operational evidence, not a UI checkbox that magically makes a strategy good.

---

# 30. Research Questions the App Must Eventually Answer

1. Does AI-filtered momentum outperform `S0_RAW` raw momentum after fees, and how much does the `S0_SAFE` deterministic second-look gate add/remove independently?
2. Does fresh catalyst evidence improve continuation probability?
3. Is social acceleration predictive before price, or mostly reactive?
4. Do high-PnL wallet cohorts lead moves in a useful time horizon?
5. Are smart-money signals still useful after excluding related/insider wallets?
6. Which liquidity bands provide enough volatility without destructive price impact?
7. What move size is already “too late” to chase?
8. Does mandatory adversarial review improve expectancy enough to justify missed opportunities, latency and model cost?
9. Are multiple independent weak signals better than one very strong momentum signal?
10. Which market regimes should disable long momentum entries?
11. Does model confidence calibrate to outcomes?
12. Which model/provider gives the best incremental value per dollar and latency?
13. Are exits more important than entries for net performance?
14. Does dynamic trailing beat fixed profit-taking in this universe?
15. How much theoretical edge disappears in actual Jupiter quote/slippage conditions?
16. Does proposer/adversary disagreement predict future drawdown or improve trade selection?
17. Which speed tiers gain from AI context versus losing edge to reasoning latency?
18. How often does a reviewed `HOLD` decision add or destroy value versus exiting at the reassessment point?
19. Which strategies remain profitable after directly attributable model/data/RPC cost and full platform operating cost?
20. Which strategies genuinely perform better in Asia, Europe, US, overlap or weekend sessions after controlling for volatility/liquidity regime rather than operator attendance?
21. How does catalyst continuation probability decay as a function of **source-time age**, and what event-window lengths maximize expectancy by catalyst class?
22. Does attended-vs-unattended execution materially change slippage, missed-entry rate, intervention rate or strategy outcome?

The application should make these empirical questions easy to query rather than leaving them as opinions.

---

# 31. Implementation Guardrails for Claude/Kimi/Other Reviewers

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

# 32. Adversarial Review Checklist

Before implementation is declared complete, specifically attempt to break the system by asking:

## Trading correctness

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

## Data correctness

- Can a stale WebSocket connection continue to look healthy?
- Can provider zeros/nulls be mistaken for real market values?
- Can duplicate news inflate confidence?
- Can our own wallet/vault transaction inflate momentum, flow or smart-money evidence for another strategy?
- Can historical replay use a wallet label learned in the future?
- Can revised metadata overwrite what the strategy knew at the time?

## AI boundary

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

## UX / operator correctness

- Can the operator mistake PAPER for LIVE_AUTO anywhere in the app?
- Can stale or missing market/risk data appear as a valid zero?
- Can an operator understand why the agent is holding a losing position?
- Can the agent be live while its emergency-exit adapter is unhealthy?
- Can a critical alert disappear as a toast without acknowledgement?
- Can mobile pause/close still function when non-critical panels fail?

## Security

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

## Research validity

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

# 33. Definition of Done

The project is complete only when:

1. A live Solana market/on-chain/news/social pipeline operates continuously for every active runtime responsibility interval; Profile 1B may run it unattended across all sessions for research coverage, while intentional `OFF` periods are valid only under D61.
2. A deterministic eligible universe and candidate engine are working.
3. S0–S4 strategies are implemented, speed-tiered and versioned.
4. A versioned Trading Skill, guidelines and automations manage autonomous candidate and open-position decisions with typed, auditable point-in-time tools/evidence.
5. Every discretionary autonomous exposure action — including open-position `HOLD` — passes the mandatory adversarial action loop; mandatory risk-reduction actions cannot be LLM-blocked.
6. Risk policy is deterministic, cryptographically authorized and independently tested.
7. Paper and live execution share the same trade lifecycle and strategy code.
8. Jupiter live execution is fully implemented behind the isolated signer.
9. Protective exits are implemented, including full Trigger auth/vault/cancel lifecycle when enabled, plus a provider-independent emergency-exit path.
10. Idempotency/reconciliation survive timeout/restart scenarios, with durable transaction identity recorded before submission.
11. Continuous held-asset safety/exit-compatibility checks operate and cannot turn ineligibility into an inability to attempt exit.
12. The full Section 20 UI/UX exists: control room, scanner, asset workspace, agent activity, action inspector, approvals, positions, skill/guideline/automation/adversary consoles, research/economics, risk/custody/health/audit and mobile safety surfaces.
13. Replay enforces first-seen point-in-time semantics across proposer, adversary and all Trading Skill tools.
14. Baseline-vs-AI, proposer-vs-adversary, latency and economic-cost attribution are visible.
15. All critical security, trading, autonomy, recovery and UI-state invariants have automated tests.
16. Emergency pause/manual close work on mobile, and a separate signed out-of-band pause/close path works without Next.js or Postgres.
17. Live strategy capital sleeves and strategy-attributed position lots reconcile to physical wallet/provider-custody state.
18. Wallet reserve monitoring is live, funding remains manual, and no treasury auto-pull exists.
19. Complete infrastructure-loss recovery is documented and exercised from chain/custody truth plus independent wallet recovery material.
20. Live capability can remain disabled without any missing implementation work.
21. Adversarial review has no unresolved critical/high-severity defect.
22. Risk authorization runs in a process isolated from general worker/LLM compromise and live Release attestation is enforced.
23. `PROTECTION_ONLY` behavior, spend circuit breakers and shared-cutoff refresh semantics are implemented/tested.
24. Provider-independent direct-pool emergency exit is continuously dry-run for LIVE_AUTO assets.
25. Step-up operator security, out-of-app critical alerting/escalation and Live Readiness UI are operational.
26. Provider protective fills preserve deterministic strategy-lot attribution.
27. The Next.js UI has a Wallet Standard/Solana Kit funding-wallet connector with typed user-signed SOL/USDC funding, chain-reconciled funding events, strict visual/authority separation from the executor trading wallet, and no dependency of autonomous runtime on browser connection.
28. Production signing has an external signer-side policy, signer-outage controls, independently tested revocation/break-glass recovery and a pinned cold-recovery path.
29. Risk authorization rejects tampered/stale projections and independently verifies chain-hard security + wallet/custody state before exposure increases.
30. Live capital above its attested ceiling blocks new exposure pending step-up re-attestation or risk reduction.

At that point the remaining decision is not “can the application trade?” It is simply **whether the evidence is good enough to fund and arm it.**

---

# 34. Current Provider Assumptions Verified for This Blueprint

As of 2026-09-05, the design assumes the following currently documented capabilities:

- **Jupiter Swap V2** uses `GET /swap/v2/order` + `POST /swap/v2/execute`, returns an assembled versioned transaction, and may select Metis, JupiterZ, Dflow or OKX routing. Jupiter-managed `/order` execution currently documents integrated execution-quality/MEV protections; the platform nevertheless measures realized execution shortfall rather than assuming extraction is impossible.
- **Privy** documents server-side Solana signing plus Solana-aware wallet policy conditions/allowlists enforced at the wallet-policy layer. **Turnkey** documents Solana `signTransaction` integration with its Policy Engine. Their exact policy semantics still require contract tests before being treated as a production signer-side control.
- **Solana commitment** distinguishes `processed`, `confirmed` and `finalized`; Solana recommends higher commitment when stronger irreversibility is required. This blueprint uses `confirmed` for provisional operational exposure/protection and `finalized` for durable final accounting.
- **Jupiter Trigger V2** supports single price orders, stop-loss, trailing stop, OCO and OTOCO. It uses challenge-response wallet authentication with a 24-hour JWT, a per-wallet Privy-managed vault, signed deposit transactions, and two-step cancel + signed withdrawal confirmation. Jupiter's current order architecture documents per-order deterministic seeded token accounts for balance isolation; this supports lot-scoped order attribution but must be contract-tested against the exact Trigger mode/version used.
- **Jupiter Trigger stop-loss slippage** must be set explicitly by this application; provider documentation currently shows a very loose default for stop-loss/buy-above when omitted, which is unacceptable as an implicit risk setting.
- **Jupiter Price API V3** is available as a secondary/reference Solana token price source; executable Jupiter order/quote data remains the more relevant source for actual exitability.
- **Solana `simulateTransaction`** can be used for semantic preflight and current RPC structures expose transaction logs/account/balance information suitable for validating expected wallet deltas. Simulation does not replace final chain reconciliation.
- **Solana `getTokenLargestAccounts`** returns the 20 largest token accounts for a mint; this supports direct top-1/top-5/top-10/top-20 account-concentration checks, not a complete holder/entity distribution. Full holder counts/clustering therefore remain indexer/analytics-derived.
- **Solana Kit / Wallet Standard** is the current recommended frontend path for new Solana TypeScript/React applications: `@solana/kit` + `@solana/kit-plugin-wallet` provide Wallet Standard discovery/connection, with `@solana/react` providing React bindings. Legacy `@solana/wallet-adapter-*` is not the default for this new build.
- **Birdeye** provides Solana real-time market WebSockets, token security, holder distribution, wallet PnL/top-trader/smart-money data and related discovery APIs.
- **Helius** provides Solana WebSocket/webhook event delivery and higher-performance streaming options.
- **LunarCrush** provides crypto social metrics including sentiment, mentions, interactions, creators/topics and trending signals.
- **CryptoPanic** provides a crypto news API with recent-news and sentiment-related metadata depending on plan.
- **Raydium** exposes program/SDK support for direct AMM v4, CPMM and CLMM swaps suitable for a constrained direct-pool emergency adapter.
- **Orca Whirlpools** exposes TypeScript/Rust SDKs and direct concentrated-liquidity swap instruction construction.
- **Meteora DLMM** exposes a TypeScript SDK/IDL and direct quote/swap construction over known DLMM pools, including transfer-fee/hook-aware account handling.

All external capabilities remain behind adapters because APIs, authentication, routing, pricing, custody behavior and plan access can change.

**Correlated-provider trade-off:** Jupiter Trigger V2 currently uses Privy-managed vault custody. Selecting Privy as the production trading-wallet signer therefore concentrates signer/key service and protected-order custody with the same provider. Live Readiness must surface this explicitly; it is a conscious operational/counterparty trade-off, not provider redundancy.

Primary verification references for implementation review:

- Jupiter Swap: `https://developers.jup.ag/docs/swap/order-and-execute`
- Jupiter Trigger lifecycle: `https://developers.jup.ag/docs/trigger/lifecycle`
- Jupiter Trigger vault/deposit: `https://developers.jup.ag/docs/trigger/deposit`
- Jupiter Trigger create/order slippage: `https://developers.jup.ag/docs/trigger/create-order`
- Jupiter Price API: `https://developers.jup.ag/docs/price`
- Solana simulation: `https://solana.com/docs/rpc/http/simulatetransaction`
- Solana commitment/RPC: `https://solana.com/docs/rpc`
- Privy Solana server transaction signing: `https://docs.privy.io/api-reference/wallets/solana/sign-transaction`
- Privy wallet policies: `https://docs.privy.io/controls/policies/overview`
- Turnkey Solana signing / Policy Engine: `https://docs.turnkey.com/sdks/web3/solana` and policy documentation
- Turnkey Solana policy language / address lookup tables: `https://docs.turnkey.com/features/policies/language`
- Turnkey access-control/export policy examples: `https://docs.turnkey.com/features/policies/examples/access-control`
- Next.js support policy: `https://nextjs.org/support-policy`
- Base UI: `https://base-ui.com/react/overview/quick-start`
- Nx module boundaries: `https://nx.dev/docs/features/enforce-module-boundaries`
- Supabase Queues/pgmq FIFO semantics: `https://supabase.com/docs/guides/queues/quickstart`
- Lightweight Charts attribution: `https://tradingview.github.io/lightweight-charts/docs`
- Solana largest token accounts: `https://solana.com/docs/rpc/http/gettokenlargestaccounts`
- Jupiter execution quality/MEV: `https://developers.jup.ag/blog/why-you-dont-get-what-you-were-quoted`
- Jupiter seeded per-order balance isolation: `https://developers.jup.ag/blog/lov2-correctness-under-failure`
- Solana frontend / Wallet Standard: `https://solana.com/docs/frontend`
- Solana Next.js + Kit wallet tutorial: `https://solana.com/docs/frontend/nextjs-solana`
- Raydium docs: `https://docs.raydium.io/`
- Orca developer overview: `https://docs.orca.so/developers/overview`
- Meteora DLMM developer docs/source: `https://github.com/MeteoraAg/docs/tree/main/developer-guides/dlmm`

---

# 35. First Build Sequence

When implementation begins, the first work should be:

1. Create the four-app pnpm/Nx workspace (`web`, multi-role `worker`, isolated `risk-authorizer`, isolated `execution-service`), pin Node.js 24 LTS and Next.js 16 Active LTS, configure Base UI + project-owned CSS/oklch tokens, and lock `/libs/contracts` as the only canonical wire-schema source. Tag apps/libs by trust/scope and enable `@nx/enforce-module-boundaries` plus external-import restrictions before app-specific implementation; generate the contract-set digest/compatibility harness at the same time.
2. Provision only the **Profile 0/1 foundation** before trading logic: Vercel web project; Supabase project with Auth, Realtime Broadcast and durable Queues/`pgmq`; local Docker/process launch profiles and optional Vercel Sandbox session launcher. Define D65 deployment profiles in configuration/CI, but do **not** provision three paid persistent hosts before research evidence warrants them. Configure GitHub Actions/GHCR so the same logical apps can later promote to fixed-price persistent hosts without code-boundary changes.
3. Write the trade/position/order/custody/strategy-lot/action-cycle state machines and the `invariant-test-map`; generate property-based tests for every critical invariant before UI work.
4. Define canonical risk-authorization, approval and emergency-command envelopes plus signing/verification tests, and configure deployable-specific forbidden-import/egress policies.
5. Create migrations for asset, eligibility, cohort, skill/guideline/automation/action-cycle, audit, strategy sleeve, candidate, proposal, risk, authorization, approval, intent, order attempt, fill, custody, position-lot and manual wallet-funding-event records; create the required durable queues.
6. Implement `Clock`, provider adapter contracts, owned-address registry and system-health contracts.
7. Implement the isolated risk-authorizer and executor skeletons early: Release attestation verification, profile-appropriate separate identities/secrets, deterministic authorization, deployment caps, risk-signature verification, profile-required durable journals/shadows and DB-independent pause/emergency-close restrictions. Add the production `TradingWalletSigner` interface and prove the Turnkey reference signer + Solana policy path end-to-end, including deny-export and real Jupiter v0/address-lookup-table policy compatibility; no raw key is a production placeholder.
8. Run the earliest available Jupiter Trigger/LO V2 contract probe for seeded per-order balance isolation and record the exact API/mode/version result before provider-protection assumptions spread into strategy code.
9. Implement Jupiter Swap V2 order handling with structural checks, independent-RPC simulation, semantic balance-delta validation and **persist-before-submit** transaction identity.
10. Implement Birdeye market/eligibility ingestion plus Jupiter Price V3 secondary/reference pricing.
11. Add Helius on-chain reconciliation/tracked-wallet stream, continuous held-asset safety checks and self-influence exclusion.
12. Add deterministic cohort/correlation exposure engine, feature/candidate engine, speed-tier contract and S0 baseline.
13. Add social/news normalization and point-in-time evidence store.
14. Implement the versioned Trading Skill, typed tool manifest, guidelines, candidate/open-position automations and mandatory proposer/adversary action loop; bind S1–S4.
15. Add deterministic risk sizing, strategy sleeves and signed risk-authorized intents.
16. Complete paper/live lifecycle, approval binding, autonomous open-position HOLD/REDUCE/EXIT management, restart reconciliation and position-lot accounting.
17. Implement full Jupiter Trigger V2 JWT/vault/deposit/order/cancel-withdraw lifecycle and protective-order reconciliation.
18. Implement Raydium/Orca/Meteora direct-pool emergency adapters, persisted route snapshots/dry-runs, normal/out-of-band emergency controls and DB-down position-shadow recovery.
19. Build the complete Section 20 Next.js/Vercel product UI/UX over working services, including scope selector, Autonomy workspace, Releases, Live Readiness, Watchlist, Audit, operator security/step-up, notification escalation, live arming, Supabase Broadcast realtime interfaces, the Solana Kit/Wallet Standard Connected Funding Wallet + typed manual SOL/USDC funding flow, and mobile safety controls.
20. Add replay/strategy lab, proposer/adversary analysis, latency attribution and three-layer economic P&L.
21. Exercise chain-first complete-infrastructure-loss recovery, profile-appropriate runtime/container replacement + durable-journal persistence, signer outage, external offline-resume watchdog failure/overdue-resume behavior, and wallet-reserve/manual-funding runbooks. Profile 4 additionally exercises DigitalOcean host/attached-volume replacement.
22. Run adversarial closure with a **different AI instance/session or human reviewer than the implementation author**, including DB tampering, transaction substitution, stale approvals, adversary bypass, LLM-outage hard exits, self-influence, provider outages, custody mismatch, Vercel redeploy while live runtime continues, browser-wallet destination/instruction substitution attempts and crash-at-every-execution-boundary drills before any decision to fund live autonomous trading.

This order intentionally proves the dangerous and stateful parts early. It does **not** defer S2/S3, the research UI, replay, or live-capable execution from Definition of Done; staging is a build sequence, not a scope reduction.

---

# 36. v1.1 Adversarial Review Closure

This revision incorporates the first external review using the §31 taxonomy.

## Accepted defects

1. **Signature persistence ordering:** fixed. Signed transaction identity is durably recorded before submission.
2. **DB-down emergency exits:** fixed with a narrow chain-state-only risk-reducing emergency-close class and executor-local journal.
3. **Trigger V2 vs D9/D10:** fixed. JWT auth, provider vault custody, deposit and cancellation-withdraw transaction classes are explicitly modeled under the one signing boundary.
4. **Cohort source:** fixed. Active risk cohorts are deterministic/versioned; AI cannot create them live.

## Accepted missing requirements

5. **DB tampering:** fixed with asymmetric signed risk authorization plus executor deployment caps.
6. **Transaction validation:** fixed with structural checks + independent-RPC simulation + semantic wallet/custody delta assertions + final reconciliation.
7. **Live capital allocation:** fixed with per-strategy virtual sleeves and strategy-attributed position lots over one physical wallet.
8. **Self-influence:** fixed with owned-address exclusion and self-trade suppression/re-baselining.
9. **Out-of-band kill:** fixed with signed DB/web-independent emergency commands.
10. **Approval binding:** fixed. Approval binds to exact authorization hash/nonce/expiry.

## Accepted trade-offs made explicit

- Provider-side stop protection trades fill certainty against slippage protection; explicit bounded slippage is mandatory and failure to fill is an emergency state.
- Jupiter Price API V3 is added as a secondary/reference price source; executable quotes remain authoritative for exitability.
- Token-2022 transfer behavior is included in eligibility, execution-path compatibility and actual net fill/P&L accounting.

## Scope response

The full product scope remains. v1.2 initially reduced deployment complexity, but v1.3 restores a fourth deployable because `risk-authorizer` is a required security boundary, not ordinary worker scaling. P8, S2 and S3 are not deferred from completion; implementation remains phased so unsafe or stateful boundaries are proven before polish.


---

# 37. v1.2 Product / Autonomy / Operations Closure

v1.2 incorporates the operator requirements and the useful operational findings from the subsequent review round.

## 37.1 UI/UX is no longer implicit

Section 20 now specifies the application information architecture, page purpose, layouts, interactions, live-arming flow, approval queue, agent/action visualization, Trading Skill/guideline/automation/adversary consoles, wallet/custody view, economic P&L, realtime event interface, stale/error behavior, mobile safety surface and UI acceptance criteria.

The implementation may refine visual design, but it may not replace these required capabilities with a generic admin dashboard or backend-only controls.

## 37.2 Autonomous agent capability is explicit

The platform's autonomous behavior is represented by a versioned Trading Skill. It is not merely an LLM prompt invoked by a scanner.

The skill manages discretionary decisions throughout a position lifecycle, using only a bounded typed tool manifest. Strategies, guidelines, automations, risk policy and execution remain distinct versioned artifacts.

## 37.3 Mandatory adversarial loop is a system invariant

Every discretionary autonomous action that creates, maintains or changes exposure receives an independent adversarial review before deterministic risk authorization. This explicitly includes `HOLD` while a position remains exposed.

Hard stops and emergency risk reduction remain deterministic and cannot be vetoed/delayed by a model. The adversary may inspect those actions for research afterward/in parallel, but never becomes a safety blocker.

## 37.4 Operational review improvements accepted

- strategy speed/latency tiers are first-class;
- held-asset safety/Token-2022/executability is continuously revalidated;
- `LIVE_AUTO` requires an independent emergency-exit path rather than Jupiter-only exit availability;
- wallet reserve monitoring/alerts are automatic but funding remains manual;
- complete infrastructure-loss recovery begins from chain/custody truth;
- trading, strategy-economic and platform-economic P&L are tracked separately.

These are requirements for the complete platform, not scope reductions.

---

# 38. v1.3 Finished-Product / Authority-Boundary Closure

v1.3 incorporates the Fable 5 finished-product review without reopening the protected product goals.

## 38.1 Accepted defects

1. **Risk-authorizer process isolation:** fixed by making it a separate deployable/container with its own secret mount, no LLM/provider-text runtime and no wallet key.
2. **Undefined open-position fail-closed semantics:** fixed with deterministic `PROTECTION_ONLY`.
3. **Evidence refresh cutoff mismatch:** fixed with ordered shared cutoff versions; a refresh forces proposer revision and re-review on the new cutoff.

## 38.2 Accepted missing requirements

- Provider-independent emergency execution is now specified as persisted direct-pool route snapshots plus Raydium/Orca/Meteora adapters, independent simulation/submission and periodic dry-runs.
- Step-up authentication is v1 behavior for risk-increasing human controls.
- CRITICAL alerts have mobile/out-of-app delivery, confirmation, escalation, heartbeat and dead-man `PAUSE_NEW_ENTRIES`.
- Model/data/provider spend has deterministic circuit breakers.
- Provider protection is strategy-lot scoped; no shared mint-wide tightest-stop policy.
- DB-down deterministic stop evaluation uses a durable local position-risk shadow while chain/custody truth caps quantity.
- `LIVE_APPROVAL` defaults to human approval for exposure increases; cleared risk-reducing discretionary actions may auto-execute, and fast-expiry strategies are explicitly ineligible.
- Audit Log, Settings/Operator Security, Watchlist, Live Readiness and Releases have explicit UI contracts.
- The architecture diagram is current.

## 38.3 Trade-off decisions

- Hard protocol-state token security is derived/cross-checked from chain truth rather than accepting one analytics provider as authority.
- T0 uses a deterministic independent adversarial gate; T1–T3 publish explicit end-to-end budgets including required adversarial review. No tier gets a hidden review bypass.
- Operator roles (`viewer`/`operator`/`admin`) exist even though initial deployment may have one administrator; multi-tenant SaaS remains out of scope.

## 38.4 Accepted enhancements

- trade/position/audit export;
- global desktop pause shortcut;
- per-action S0 counterfactual;
- hash-chained audit events with checkpoint replication outside Postgres.

## 38.5 Additional security refinement

Process-isolating the risk-authorizer protects its private key from general worker/LLM compromise, but that alone does not make mutable database policy trustworthy. v1.3 therefore binds live strategy/policy artifacts into an immutable **Release** whose digest requires operator step-up attestation before live promotion/arming and before the risk-authorizer accepts it as live authority.

---

# 39. v1.4 Solana Wallet Connector Closure

v1.4 adds the browser/operator Solana wallet connector requested for product usability without changing any existing autonomous-trading, signing, risk or emergency boundary.

## 39.1 Added capability

The Next.js UI now requires a Solana Kit / Wallet Standard **Connected Funding Wallet** surface. It can discover compatible browser wallets, display the connected account/balances and let the human manually fund the dedicated trading wallet with allowlisted SOL/USDC through a user-reviewed wallet signature.

## 39.2 Preserved boundaries

The connected funding wallet:

- is not the executor trading wallet;
- cannot authorize autonomous trades;
- cannot substitute for Supabase/operator authentication or WebAuthn/TOTP step-up;
- cannot approve risk envelopes or attest Releases;
- is never available to `worker`, `risk-authorizer` or `execution-service`;
- cannot be debited automatically or by an automation;
- is not required to remain connected after funding;
- has no effect on running strategies, protective orders, emergency exits or restart/disaster recovery.

The executor remains the only **application process authorized to request normal autonomous trading signatures**; the production private key itself is non-exportable at the signer backend under D47, with the separate incident-only D53 break-glass principal added later. D4, D10, D21, D22, D25 and all existing execution validation/reconciliation rules remain unchanged in intent.

## 39.3 Funding correctness

The application exposes only a typed `FUND_TRADING_WALLET` operation, resolves the destination from configured trading-wallet identity, restricts funding assets/cluster, displays the exact transfer before wallet prompt, records the transaction signature, and treats chain-confirmed balance deltas as authoritative. A wallet/provider success callback alone cannot create funding state.

## 39.4 Product impact

Section 20 now makes the operator funding wallet and autonomous trading wallet visually distinct and provides a complete connect → review → sign → submit → reconcile flow. The trading-wallet address/QR remains available for manual funding outside the connector. No automatic treasury pull was introduced.

---

# 40. v1.5 AI-Build, Signer, Finality and MEV Closure

v1.5 incorporates the corrected Kimi review while preserving all v1.4 product/autonomy/UI/wallet-connector requirements.

## 40.1 Production signer boundary

The earlier allowance for a raw encrypted executor-mounted key is removed for production/mainnet. Live wallet signing now requires a non-exportable Ed25519 backend through the `TradingWalletSigner` adapter. The executor remains the sole application authority allowed to request signatures and still performs authorization, transaction validation, simulation and persist-before-submit handling before any signer call.

A provider/HSM compromise remains a custody risk, but an executor/container compromise no longer automatically yields exportable wallet key material. Dev/test software keys are explicitly barred from Live Readiness.

## 40.2 MEV/execution-quality modeling

MEV/adverse execution is now explicit in paper/replay cost models, live execution-path telemetry and performance measurement. Jupiter managed execution is treated as a mitigation, not a proof of zero extraction. Direct-pool emergency exits are modeled as higher-risk and may use private/Jito-style landing when healthy without delaying mandatory risk reduction solely for that protection.

## 40.3 Chain finality and reorg semantics

The system now distinguishes `processed`, `confirmed` and `finalized`. Confirmed fills create provisional exposure quickly enough to install protection; finalized state is required for final accounting/P&L. Confirmed-then-missing/conflicting transactions enter `REORG_PENDING`, and chain halt/RPC-divergence behavior fails closed for entries without blindly retrying ambiguous transactions.

## 40.4 Jupiter lot-isolation assumption promoted to an executable gate

Seeded per-order token-account isolation is currently documented by Jupiter, but documentation alone is not accepted as the production invariant. The exact Trigger/LO V2 mode/version used must pass a contract probe before same-mint strategy-lot provider protection can be enabled.

## 40.5 AI build guardrails

Because AI implementation speed can hide cross-module drift and superficial tests, v1.5 adds:

- one canonical `/libs/contracts` source and a contract-set digest embedded in all live-capable artifacts;
- cross-module encode/decode compatibility tests;
- an `invariant-test-map` with property/fuzz tests for every critical §24.6 invariant;
- deployable-specific forbidden-import and runtime egress policies verified against built artifacts, not only source/Dockerfiles;
- UI-state reconciliation tests against authoritative backend aggregates;
- a separate adversarial code-review pass by a different AI instance/session or human reviewer before live arming.

The `risk-authorizer` does **not** have literally zero network access: it requires narrowly allowlisted access to authoritative database/control-plane state. It has no arbitrary/public LLM, news, social, DEX or wallet-signing egress. Writing "no outbound network" would contradict its required function.

## 40.6 Regression statement

No v1.4 wallet connector, autonomous Trading Skill, adversarial-action loop, deterministic risk boundary, Release attestation, emergency-exit path, product UI, strategy scope or research requirement is removed by v1.5. The changes harden implementation correctness, custody, execution-quality measurement and chain-state semantics.



---

# 41. v1.6 Signer-Availability, Authorization-Input and Break-Glass Closure

v1.6 incorporates the Fable 5 review of v1.5. The changes are fallout from moving production custody to a non-exportable remote signer and do not reopen the protected product/autonomy decisions.

## 41.1 Closed defects

1. **Signer dependency propagated:** D33 now explicitly means Jupiter-independent, not signer-independent. Signer health appears in System Health, degraded modes, alerts, Live Readiness, tests and the adversarial checklist. `MONITORED_EXIT` exposure is bounded by a signer-outage unprotected-exposure cap; provider-side protection is preferred where compatible.
2. **Authorization-input DB tampering:** signed/sequenced `RiskStateProjection` records make database-only projection mutation detectable. The risk-authorizer independently re-reads D45 hard security state and wallet/custody balances before exposure-increasing authorization.
3. **Architecture diagram:** executor no longer contains a depicted wallet private key; it requests signatures through a signer-policy layer into a non-exportable signer backend.

## 41.2 Closed missing requirements

- **Break-glass signing:** D53/§15.7B define a separate MFA/quorum/time-boxed incident signer principal outside the application/executor and include it in DR testing.
- **Compromise response:** D54 revokes the executor signer identity out-of-band first, then permits recovery/sweep only to a pre-registered cold wallet.
- **Signer-side policy:** D55 makes transaction-aware policy outside the executor mandatory for `LIVE_AUTO`; the v1 reference uses Turnkey's native policy layer. Any future byte-only signer would require an isolated policy gateway.
- **Executor aggregate exposure:** §13.7 now uses a local append-only `ExecutorExposureLedger` with conservative cost-basis/authorized-notional enforcement and price only as an additional sanity check.
- **Funding after arming:** D56 adds a capital attestation ceiling; crossing it creates `CAPITAL_REATTEST_REQUIRED` and blocks new exposure.

## 41.3 Explicit trade-offs/research corrections

- Jupiter Trigger custody and signer-provider concentration must be shown in readiness/architecture review; selecting Privy for both is a deliberate correlated-provider risk, not hidden independence.
- `S0_RAW` remains an ungated shadow/paper counterfactual while `S0_SAFE` is the execution-eligible D30-gated baseline, preserving a clean raw-momentum research comparator.
- direct Solana RPC cheaply verifies supply and top-1/top-5/top-10/top-20 token-account concentration; full holder distribution/entity clustering remains indexed analytics evidence.
- the selected production signer must pass canonical Solana Ed25519 transaction-signing contract tests plus signer-side policy, availability and recovery tests; v1.8 carries no AWS signing dependency.
- retrying a timed-out sign request for identical canonical Ed25519 bytes is cryptographically deterministic; operational idempotency/audit correlation is still required.

## 41.4 Regression statement

No v1.5 Trading Skill, adversarial loop, strategy scope, Solana wallet connector, Release, risk-authorizer isolation, provider-independent emergency routing, protective-order lot attribution, `PROTECTION_ONLY`, finality/reorg semantics, MEV accounting, UI/UX, replay/research or AI-build guardrail is removed. v1.6 narrows and hardens the custody/authorization failure boundaries created by remote signing.

---

# 42. v1.7 Explicit Technology Stack and Vercel Hosting Closure

v1.7 made the stack explicit and correctly preserved Vercel as the product/control-plane host while keeping the autonomous runtime on persistent compute. v1.8 supersedes only the AWS-specific runtime choice from that closure.

## 42.1 Vercel decision superseded by v1.9 session/maturity profiles

Vercel remains the intended home of the application UI/control plane. v1.9 supersedes the blanket statement that Vercel may never host any runtime role: Vercel Sandbox/Workflow may host early session-shaped/PAPER/request-shaped work under D57/D65. The non-negotiable requirement is now exposure-driven availability/durability, not provider branding.

Traditional short-lived Functions/Cron still may not impersonate a resident financial monitor by chaining invocations. Hardened unattended `LIVE_AUTO` remains independent of the web deployment.

## 42.2 Stack decision superseded by v1.8

The AWS-specific persistent-runtime references introduced in v1.7 are superseded by D58/D59 and §5 in v1.8. No AWS component remains in the reference implementation.

---

# 43. v1.8 Fixed-Cost DigitalOcean Runtime Closure

v1.8 replaced the AWS runtime choice from v1.7 with fixed-cost DigitalOcean infrastructure without reducing trading, autonomy, security, persistence or observability requirements. v1.9 supersedes when that persistent topology is required.

## 43.1 Hosting decision superseded in timing, retained as hardened target

The three-Droplet DigitalOcean topology remains the **Profile 4 hardened reference**, not the mandatory starting topology. v1.9 explicitly permits local/Vercel session runtimes and single-host early live pilots while preserving logical boundaries and tiny capital caps. Supabase and Turnkey remain unchanged.

AWS is explicitly out of scope for v1.

## 43.2 Cost posture superseded by v1.9 maturity profiles

The $24/month three-host figure is retained only as a reference for the hardened Profile 4 topology. v1.9 explicitly avoids incurring that cost during Profiles 0/1 and normally during tiny attended Profile 2 testing. Infrastructure spend is promoted only after technical/strategy/live evidence justifies it.

## 43.3 Isolation is profile-scaled, not deleted

Logical process/credential/contract boundaries remain from the first build. Physical host isolation is required when D65/profile readiness says the blast radius justifies it; early no-capital/tiny-capital profiles may co-reside physically by explicit acceptance. Turnkey remains external and non-exportable throughout.

## 43.4 Persistence is profile-specific

PAPER requires reproducible database/research state but not a DB-independent live execution journal. Any profile permitted to hold live unmanaged exposure must provide the D22/D23 synchronous durability required by its execution path. Profile 4 may use separate DigitalOcean volumes; this is not imposed on Profile 0/1.

## 43.5 Regression statement

No v1.8 Trading Skill, adversarial loop, autonomous execution, strategy scope, UI/UX, wallet connector, Release attestation, risk-authorizer isolation, remote signer/signer policy, break-glass recovery, emergency DEX routing, protective-order lot attribution, `PROTECTION_ONLY`, finality/reorg semantics, research/replay, capital attestation or AI-build guardrail is removed. v1.9 changes runtime/session economics and deployment timing only.

---

# 44. v1.9 Session-Oriented Early Operation and Autonomy Preservation Closure

v1.9 changes **when** infrastructure must run and **when** physical isolation becomes economically justified. It does not reduce the finished autonomous trading capability.

## 44.1 Closed operating-model issues

- 24/7 runtime is no longer a universal invariant; D61 makes availability proportional to unmanaged exposure.
- activity state and capital authority are separate axes; `PAUSED` remains sticky and operator-cleared.
- `STARTING` makes backfill/warm-up/reconciliation explicit before candidate scoring.
- `WIND_DOWN` makes session end a safe state transition rather than killing a process.
- `OFFLINE_PROTECTED` is narrowly defined and time-bounded; provider-side price protection alone is not indefinite offline safety.
- catalyst `EVENT_WINDOW` age is based on source/event time while replay availability remains based on `first_seen_at`.
- attended Profile 2 live requires operator-presence heartbeat and tiny attested capital.
- unattended all-session PAPER is retained specifically to prevent operator-attendance bias in global-session research.
- Vercel Sandbox is a valid early research/session substrate; its snapshot/session semantics are not silently assumed to satisfy live persist-before-submit durability.
- the three-host DigitalOcean topology is retained as the Profile 4 hardened target rather than charged from day one.

## 44.2 No regression of autonomy/security

No v1.8 Trading Skill, mandatory Action Adversary, `LIVE_AUTO`, risk-authorizer, signed projection/envelope, signer-side policy, Turnkey non-exportable signer, break-glass recovery, emergency DEX routing, lot-scoped protection, point-in-time replay, capital attestation, wallet connector, UI/audit/readiness or AI-build guardrail is removed.

The intended destination remains an unattended autonomous trader. v1.9 simply requires the platform to **earn the right to run unattended with meaningful capital** through technical correctness, paper evidence, tiny attended live execution and profile-specific readiness gates.

---

# 45. v1.10 Final Pinned-Stack / Turnkey / Session-Watchdog Closure

v1.10 incorporates the final Fable pass over v1.9. It does not reopen the autonomous product or security architecture; it closes the remaining consequences of pinning the concrete signer, queue, workspace and early-live runtime choices.

## 45.1 Turnkey readiness blockers closed

- Turnkey's policy engine does not resolve account addresses loaded through Solana address lookup tables and rejects program addresses loaded via lookup tables. D55/§15.7A/§29 now require a real Jupiter v0 `/order` compatibility suite before Turnkey can satisfy `LIVE_AUTO`; signer policy is explicitly a second layer, not a substitute for executor simulation/delta validation.
- Turnkey key export is possible as a platform capability, so D47 no longer treats non-exportability as intrinsic. Explicit deny-export policy for autonomous and break-glass principals is a mainnet readiness requirement and is tested.

## 45.2 Specification defects closed

- §24.8 now permits the risk-authorizer's required narrowly scoped read-only Solana RPC/decoder path while continuing to ban wallet/signing and DEX/provider tooling.
- duplicate §21.2A numbering is corrected and an external `session-resume-watchdog` is specified for deadlines that must be enforced while the runtime itself is `OFF`.
- Profile 2 local live testing isolates executor/Turnkey credentials from AI coding-agent shells/workspaces even when the services share one physical workstation.
- Supabase Queues/`pgmq` priority is implemented by distinct FIFO queues consumed in fixed risk-first order; no nonexistent native priority field is assumed.

## 45.3 Stack choice deliberately aligned with the user's existing application architecture

v1.10 replaces the reviewer-default Tailwind/shadcn/Turborepo combination with **pnpm + Nx**, Base UI (`@base-ui/react`) and project-owned CSS/CSS Modules using `oklch()` tokens. Nx tags and `@nx/enforce-module-boundaries` become a source-level complement to §24.8 artifact isolation. This is a deliberate greenfield reuse/alignment decision rather than an accidental second design system.

Next.js **16 Active LTS** wording is retained: Next.js now formally uses Active LTS / Maintenance LTS support terminology, so the reviewer's small correction on that point does not apply.

TradingView Lightweight Charts attribution is now an explicit UI/license requirement. `S0_RAW` and `S0_SAFE` are explicitly distinct Strategy Lab/UI identities.

## 45.4 Regression statement

No v1.9 session model, deployment maturity profile, `LIVE_AUTO`, Trading Skill, mandatory Action Adversary, risk-authorizer, signed projection/envelope, signer-side policy, break-glass recovery, emergency routing, lot-scoped protection, finality/reorg semantics, point-in-time replay, wallet connector, capital attestation, UI/readiness/audit or AI-build guardrail is removed. v1.10 closes implementation ambiguity around the pinned stack and signer rather than expanding product scope.

