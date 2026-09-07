# Plan v4 against the external recommendations — repository-verified assessment

| | |
| --- | --- |
| Author | Implementing session (Claude), 2026-09-07 evening, at commit `a846898` (M4 closed). |
| Input | The operator's twelve-point review of Execution Plan v4 ("Overall recommendation: keep v4's general structure, but revise its dependency graph and tiny-live gate"). |
| Method | Every claim below was checked against the repository, the hosted Supabase project and the local reset, not against the plan text alone. Commands and results are in the verification table. |
| Files modified | None besides this file. Plan scope, dependencies and gates are not edited: GUARDRAILS ground rule 8 reserves those for the operator after an ADR. The proposed plan patch is at the end. |

## Verification performed

| Check | Result |
| --- | --- |
| Where the read-only chain library lives and what it depends on | `libs/solana-hard-state` exists since M4 (not M3 as the plan says); `package.json` depends on `contracts` and `zod` only; tag `trust:shared`; ESLint `depConstraints` allow only `scope:contracts`/`scope:observability` and ban signer, DEX, browser and LLM packages. The RPC client has a closed method allowlist (`READ_ONLY_METHODS`) and refuses non-allowlisted origins at construction (spec `read.spec.ts:37`). There is no test that a signing/submission call is rejected — the allowlist makes it impossible to express, but no test proves it. |
| ADR-0004 wording | Row "Probe A passed for the routes in use — **preferred, not required** for `LIVE_APPROVAL`, because D55 scopes the second signer-side policy layer to `LIVE_AUTO`". Header claims "§31-protected decision affected: none". |
| M5b → M8a dependency | Plan §4: M7 "depends on M3 + M5a"; M8a follows M7; M5b has no consumer before M12's Profile 1B rule. The candidate-side self-influence guard now exists in code (`libs/signals/src/self-influence`, built in M4 for INV-11), but cohorts, speed-tier enforcement and session/regime labels do not. |
| Contracts for the financial-boundary requirements | `grep` over `libs/contracts`: approval binding with nonce ledger and hash (`envelopes/approval.ts`), `RiskAuthorizedIntent` with nonce + `projectionSequence`, `RiskStateProjection` signed and sequenced (rollback rejected by the authorizer contract), `EmergencyCommand` nonce, journal `sequence`. **Absent:** any reservation/capacity primitive (only `position_lots.reserved_for_protection`), any signed adversary-clearance artifact (the `ActionCycle` carries a `verdict` and `cutoffs` but no signature, Release digest or expiry), any arming/control epoch, any readiness-row entity, any protection-installation lifecycle state. |
| M1 position-review machine | `libs/execution/src/state/position-review.ts:82-89`: `UNRESOLVED`, `EXPIRED` and `REJECTED` all enter `PROTECTION_ONLY` (EXPIRED normalised to reason `TIMEOUT`, REJECTED to `DISAGREEMENT`); a `BUDGET` reason enters `BUDGET_PAUSED` instead of `PROTECTION_ONLY`. Review state is a column of `trading.positions` (aggregate per mint); `trading.position_lots` carries `strategy_version_id` and `sleeve_id` but no review state. Cycle-termination → position handoff is a pure function; no outbox or transactional event exists. |
| Invariant map schema | Fields: `id`, `statement`, `owner_modules`, `tests`, `status`. No `required_by`, `applicable_profiles`, `applicable_strategy_classes`, `evidence`. 14/28 mapped. No mutation tests. INV-05 reads "No live trade while PAUSED or in OBSERVE/PAPER" (the runtime machine already exempts risk reduction: `riskReductionAllowed()` is unconditional). |
| MP section | Lists three probes and an exit gate; no probe wallet value cap, fee/loss cap, allowed destinations, script/build hash approval, abort/recovery, post-probe reconciliation or credential cleanup. No Trigger authentication probe. Cold-recovery registration is in M8a. |
| M8a gate wording | Harness-based drills; "no open severity-1 defect"; readiness rows are not yet a contract or a table. |
| Paper/live parity | ADR-0003 fixes one shared Jupiter client (`libs/execution/src/jupiter`, verified: eligibility and safety use the same `JupiterSwapClient`). No parity test suite exists yet (M5a/M7 not started). |
| Profile 1B / M10 / M9 step 8 | Plan §M12: 1B "after M5b once M7's restart recovery exists". M10 after M9 operational surfaces. M9 step 8 lists Strategy Lab, Trade History, Attribution; "Replay Lab" is not named anywhere in the plan (`grep -i "replay lab"` empty). |
| Plan header | Still says "Repo state today: one blueprint file, no git, no code" while §8 ticks M0–M4. |
| Hosted migration history | Hosted project has **no** `supabase_migrations.schema_migrations` relation (every migration was applied through the SQL editor). Schema equivalence against a clean local `supabase db reset` of the 18 repository migrations: 72/72 tables, 30/30 functions, 57/57 triggers, 73/73 RLS policies identical by name (`migration-audit.mjs`, 2026-09-07 19:40Z). |
| Run-rate | `docs/costs.md` records Hobby Vercel with the D57 Pro requirement deferred to M8a, and now Birdeye Lite USD 39/month as the only paid tier. |
| Birdeye blocker | Resolved by the Lite upgrade on 2026-09-07; no zero/false substitution was made (missing security data fails closed to EVALUATING, unit-tested). Freshness contracts are, however, sized by purchased tier (`defaultFreshnessContracts(tier)`: 5 s streaming / 15 s / 60 s polled) — see item 12. |

## Assessment, recommendation by recommendation

### 1. Track A / Track B dependency — agree; already resolved in code, not in the plan

The recommendation is right that the plan text makes M4 depend on M3. In practice the dependency was cut the other way round: `libs/solana-hard-state` was built inside M4 (commit a220cf9 onward) because Track B needed it first, and M3 has not started. It already has everything the recommendation lists except the forbidden-capability test: read-only RPC interfaces with a closed method set, mint/token-account decoders, balance and security-state reads, slot/freshness metadata (`readAt`, minimum slot of the reads), fixtures and contract tests, no Turnkey or Trigger dependency.

**Action:** plan patch (operator) moving the library's ownership from M3 to a named "shared chain foundation" package under M4, with the evidence links already in §8; M3 becomes a consumer. **Implementation (this session, no decision needed):** add an executable capability test that constructing a request for `sendTransaction`, `signTransaction`, `requestAirdrop` or any non-allowlisted method throws before any transport call, and an artifact-level assertion that the built risk-authorizer bundle contains no such method string. Map it under INV-01's owner list as a supporting test.

### 2. ADR-0004 signer-policy exception — agree; it is a real weakening and the ADR should say so

The ADR's header claims no §31 decision changes, but §31 lists "production live signer key remains non-exportable and is never regressed to a raw executor secret" and D65/§29 say no profile waives signer policy for cost. Human approval of an envelope hash (INV-10 binding) does not constrain the bytes the executor signs afterwards; only simulation-based semantic checks (M3) and the external policy do. The ADR resolves a blueprint inconsistency by picking the weaker reading and labelling it unchanged.

**Action:** a new ADR (operator decision, classify TRADE-OFF) that either (a) makes external signer-policy validation mandatory for the exact transaction shapes Profile 2 permits — a small tested asset/route set, everything else rejected at the executor before signing, lookup-table breadth deferred, gateway required if the native policy cannot express the subset — or (b) states an explicit, time-boxed waiver as an accepted risk with the compensating control named (executor semantic simulation + tiny capital). Split Probe A into four recorded results: deny-export and policy-administration restrictions; supported-shape acceptance; malicious-shape rejection; lookup-table compatibility. The `docs/probes/README.md` template can carry the four rows without a plan edit.

### 3. M5b safety work before tiny live — agree, with a correction

The self-influence guard already exists (M4, INV-11 mapped: owned-address registry, `selfInfluenceCheck`, database-level refusal of owned wallets). Cohort/correlation inputs, speed-tier enforcement and session/regime labels do not. M7's "live risk policy" cannot enforce cohort caps or speed tiers on data that does not exist.

**Action:** plan patch (operator) naming an `S0_LIVE_SAFETY` package as an explicit M8a dependency: cohort inputs for every policy field the tiny-live variant enables, speed/expiry/chase enforcement with the `human_reaction_floor_ms` binding, conservative handling of unknown classifications (unknown cohort = most restrictive cap), candidate self-influence wiring into the candidate machine (the guard is a library today; the M5b candidate machine must call it). Simplest alternative: require M5b before M8a.

### 4. Owners for the financial-boundary requirements — agree; all seven are unowned today

Verified absent from contracts and plan text: capacity reservations, authenticated clearance artifacts, arming/control epochs, protection-installation lifecycle, canonical financial arithmetic properties, execution-time transaction bounds as a named package. Durable fencing exists only for worker leases (`ops.worker_leases`, fenced by token) and the audit chain; nothing covers the executor.

The reservation example is exact: two USD 700 intents against a USD 1 000 remaining cap both pass today's design because `RiskStateProjection` is a signed read of the past, and idempotency keys dedupe retries of the same intent, not two different intents. The blueprint's `ExecutorExposureLedger` (M3) is an append-only local record, not a reservation.

**Action:** plan patch (operator) adding contract work now and implementation owners as the recommendation tabulates; specifically:
- `CapacityReservation` contract (sleeve id, cohort keys, amount, intent id, reserved-at sequence, expiry, state `RESERVED → CONSUMED | RELEASED`), reserved by the risk-authorizer before signing, consumed on `SUBMITTED`, released only when the attempt is proven `NOT_LANDED` or `FINALIZED`-reconciled — never on envelope expiry alone. Property test: N concurrent valid intents never exceed the cap. Owner: contracts M5a (so the paper path exercises it), enforcement M7.
- `ActionClearance` signed envelope: proposal hash, cutoff version, Release digest, candidate/lot revision, verdict, expiry, adversary key id. The risk-authorizer verifies it, not the database row. Owner: contracts before M6, enforcement M6/M7.
- `ArmingEpoch` on every authorization and approval; pause/re-arm increments the epoch; the executor rejects any envelope from an older epoch. Owner: contracts M3, enforcement M7.
- Executor durable nonce/sequence with restart, rollback and split-brain tests. Owner: M3.
- Protection-installation lifecycle (`INSTALLING`, `ACTIVE`, `FAILED`, `CANCELLING`) counted as unprotected exposure until `ACTIVE`. Owner: contracts now, M8a.
- Canonical arithmetic module (base-unit bigint everywhere, rounding rules, fee attribution, cash-flow identities as property tests). Owner: M5a paper accounting, M7 live.
- Execution-time transaction bounds: input/output/recipient/program constraints for the supported shapes, enforced at landing by simulation deltas. Owner: MP for the shapes, M3 for the validator.

### 5. ADR-0001 and the position-review machine — mostly already correct; two changes needed

A. All unsuccessful outcomes already fall back: `REJECTED`, `EXPIRED` and `UNRESOLVED` each enter `PROTECTION_ONLY` (verified at `position-review.ts:82-89`). The recommendation's invariant holds in code; ADR-0001's text only describes the `UNRESOLVED` path. **Action:** ADR-0001 amendment (text only) stating the normalisation; no code change.

B. Budget as a separate review state: the recommendation is right and the code does the risky thing — a `BUDGET` reason produces `BUDGET_PAUSED` instead of `PROTECTION_ONLY`, so `discretionaryActionsAllowed()` returns false (safe) but every consumer that checks `=== 'PROTECTION_ONLY'` would miss it. **Action:** change the enum: `review_state ∈ {REVIEWED, PROTECTION_ONLY}` with `reason` carrying `BUDGET`; move `BUDGET_PAUSED` to the strategy automation/spend state (`ops.spend_usage.state` already has it). Migration, contract, machine and spec change; re-review by a fresh session since it touches an M1 contract.

C. Strategy scope: review state sits on the aggregate `trading.positions` row. Two strategies holding the same mint would freeze or clear each other. **Action:** move `review_state`/`reason`/`since`/`last_reviewed_cycle_id`/`unreviewed_stop` to `trading.position_lots` (strategy-scoped, one row per sleeve lot) and derive the aggregate for the UI. The M4 held-asset `safety_state` is correctly per physical position (chain facts are mint-wide) and stays.

Handoff durability: today the handoff is a pure function the M6 worker would call. **Action:** the M6 package must write the cycle terminal state and the lot review transition in one transaction through an outbox row consumed idempotently (the pgmq `trading_actions` queue with `ops.processed_messages` already provides the consumer side).

### 6. Applicability-based readiness — agree; the map is progress reporting, not a gate

**Action (implementation, no decision needed for the schema; operator decision for the gate rule):** extend `invariant-test-map.yaml` with `required_by`, `applicable_profiles`, `applicable_strategy_classes`, `evidence`, and a `not_applicable_reason` where used; extend `tools/check-invariant-map.mjs` so a readiness computation for a profile fails when any applicable invariant is unmapped or its tests are not green. Plan patch: replace "≥ 12 invariants mapped" and "zero unmapped at M11" with "every invariant applicable to the target profile and enabled strategy class mapped and green before that profile's readiness verdict". Fix INV-05's wording to "no new exposure while PAUSED or in OBSERVE/PAPER; mandatory exits are never blocked", add an emergency-signing allowed-authority case to INV-01/INV-12, and state that transactions broadcast before a pause may land afterwards (reconciliation, not prevention). Add mutation tests as a CI job: a script that applies a small set of named source mutations (drop signature verification in `checkApprovalBinding`, drop the cap check in the eligibility gate, drop expiry in the intent check, release a reservation early once it exists) and asserts the mapped tests fail.

### 7. MP as a controlled real-capital exception — agree

**Action:** plan patch adding the probe authorization boundary (wallet value cap, cumulative fee/loss cap, allowed assets/programs/destinations, approved script and build hashes, who authorises and runs, abort and recovery, post-probe reconciliation, credential revocation), a Trigger authentication probe (challenge format and domain, freshness/replay, narrow signing permission, no escalation to arbitrary message signing), separate results for routing, signer and custody-release availability, and cold-recovery destination registration moved from M8a to MP. `docs/probes/README.md` is where the template lives and can be extended now.

### 8. M8a proves the deployment, not the harness — agree

**Action:** plan patch adding target-environment drills (termination after journal write; termination after submission before response persistence; runtime restart with an ambiguous transaction; DB outage with an open monitored position; signer outage; stale/divergent RPC; loss of presence; pending transactions during pause; laptop sleep if local) and the minimum-UI content (pending/ambiguous executions, current protection state, why entries are blocked, unmanaged exposure, emergency-command outcome). Contracts now: a `ReadinessRow` entity binding commit/image digest, contract digest, policy digests, wallet, cluster, profile, strategy Release, timestamp and expiry, with an invalidation rule when any bound digest changes — M8a persists and displays it. Replace "no open severity-1 defect" with "no unresolved critical/high security or financial-invariant finding".

### 9. Paper/live parity — agree; not started yet

**Action:** M5a scope (implementation session; no plan edit needed since M5a is the next milestone and its text already requires "same strategy code in paper and live") gains a parity suite over identical inputs: sizing and rejection, expiry/chase, stop and trail transitions, lot allocation, retry/failure outcomes, fee and fill accounting, with paper using virtual balances/custody adapters and the differences named. The paper fill model records decision-time quote, simulated submission time, executable quote at that time, expiry/chase rechecks, modelled shortfall and failure outcome (§17.4). Quote-only operation without a funded wallet is already what M4 does (`PROBE_TAKER`).

### 10. Research recovery and replay foundations — agree

**Action:** plan patch: Profile 1B starts after M5b with paper-book recovery over the shared position/reconciliation domain and a virtual custody adapter, coverage reporting and provider-budget controls (the persisted CU ledger from M4 is the start), without M7. Start replay/capture conformance in M5a (immutable evidence references, feature versions, candidate opportunity records, quote timestamps, coverage gaps, deterministic fixtures). Add to M10: model-weight look-ahead limits, forward holdout, latency-matched baseline, proposer-only shadow versus proposer+adversary, a defined confidence-calibration target. Name Replay Lab in M9 step 8.

### 11. Evidence reconciliation — done for the schema; history repair is one command away

The hosted schema is provably equivalent to the repository migrations (table above). The hosted project has no migration history at all, so the CLI will treat every migration as pending. **Action:** run `supabase migration repair --status applied <version>` for the 18 versions against the hosted project (writes history only, no DDL) and thereafter apply migrations with `supabase db push` instead of the SQL editor; record the repair in the changelog. Operator command because it needs the hosted database password in a shell the agent must not hold. Plan header: replace the "repo state today" line with initial state and current state; update the M2 evidence line from "11 migrations" to the actual count at that time (12) with the note that history was repaired on the date it happens.

Run-rate: the costs file already separates actual (USD 39 Birdeye Lite), free tiers (GitHub, Vercel Hobby, Supabase Free, Sentry Developer, Helius Free, Jupiter Lite) and the D57 Vercel Pro requirement deferred to M8a; a projected steady-state row (Vercel Pro 20, Supabase Pro 25, Birdeye Lite 39 → USD 84/month before Profile 2) should be added.

### 12. Birdeye blocker — resolved without shortcuts, with one thing to reconsider

Resolved by the Lite upgrade; nothing substituted zeros, mint inspection stayed chain-only for chain facts, and eligibility fails closed on missing analytics. One item deserves an operator decision: the freshness contracts are sized to the purchased tier (60 s price freshness on a 1 rps tier, 15 s on Lite, 5 s with streaming). That is "widening freshness limits to fit the purchased tier" by construction, even though it degrades honestly. **Action:** make freshness limits a property of the strategy class's speed tier (what a decision needs), let the purchased tier fail them, and surface the gap as a capability failure in readiness. Small change in `libs/market/src/freshness/evaluate.ts` plus a policy field; propose as an ADR because it changes what "HEALTHY" means.

## What already stands (no change needed)

- Early paper trading, provider probes as a milestone, minimum operator surface before funding, strategy-specific readiness, progressive infrastructure — kept.
- One shared Jupiter client (ADR-0003) is real and used by eligibility, safety and probes.
- Chain truth is authoritative and read-only with a closed method set; the built artifact scan enforces the package bans on the financial deployables.
- Held-asset safety is independent of entry eligibility by construction, and the M4 interim review's fixes made the exit path robust to provider unavailability.

## Proposed plan patch (for operator approval; nothing below is applied)

1. **ADR-0007 — Shared chain foundation ownership.** `libs/solana-hard-state` owned by M4 ("shared chain foundation"), consumed by M3; capability test added.
2. **ADR-0008 — Signer policy at Profile 2.** Replace ADR-0004's "preferred, not required" with mandatory validation for the permitted transaction subset (or an explicit time-boxed waiver); Probe A split into four results.
3. **ADR-0009 — `S0_LIVE_SAFETY` before M8a.** Named package or "M5b before M8a".
4. **ADR-0010 — Financial-boundary owners.** Reservations, clearance artifacts, arming epochs, executor fencing, protection lifecycle, canonical arithmetic, execution-time bounds, with the owners in item 4.
5. **ADR-0001 amendment + ADR-0011 — Position review scope.** Normalised fallback stated; `BUDGET_PAUSED` removed from review state; review state moved to strategy lots; transactional handoff.
6. **ADR-0012 — Applicability-based readiness.** Invariant-map schema, gate rule, wording fixes, mutation tests.
7. **MP boundary and Trigger authentication probe** (plan text; ADR if the operator prefers).
8. **M8a deployment drills, `ReadinessRow` binding, severity wording.**
9. **M5a parity suite and paper fill model** (implementation detail; no plan edit).
10. **Profile 1B start rule, M10 additions, Replay Lab in M9 step 8.**
11. **Migration history repair and plan header** (operational).
12. **ADR-0013 — Freshness by strategy speed tier**, not purchased tier.

Suggested order matches the operator's: 1–4 before any Track A work, 5–6 before M6, 11 now, 12 alongside M5a, then M5a with parity and capture fixtures, MP probes in parallel, and the complete Profile 2 applicable invariant set before M7/M8a.

## What the implementing session will do without a decision

- Capability test for the chain library (item 1) and the invariant-map schema extension with a checker that understands applicability (item 6, schema only; the gate rule waits for the ADR).
- `ReadinessRow` and `CapacityReservation` contract drafts as unregistered proposals in `docs/decisions/` alongside the ADRs, so the operator reviews concrete shapes.
- Nothing that changes a milestone's scope, dependencies or gate.


---

## Revision after the operator's self-review (2026-09-08)

The operator's follow-up ("Adversarial verdict on my recommendations") narrows the first review: require properties and evidence, not particular architectures; inspect completed work before restructuring it; keep disabled capabilities out of the tiny-live gate. Checked against the verification table above, that narrowing is correct, and it changes the proposed patch as follows.

### The "inspect first" table, answered from the repository

| Question | Inspected | Answer |
| --- | --- | --- |
| Can concurrent intents oversubscribe capacity? | `libs/contracts/src/envelopes/risk-authorized-intent.ts`, `risk-state-projection.ts`; risk-authorizer and execution-service are skeletons (M3/M7 not started) | Nothing to oversubscribe yet, and nothing that would prevent it: the projection is a signed read of the past, idempotency keys dedupe retries of one intent. The property must be owned by M7's authorization path. For the restricted Profile 2 the follow-up's simpler shape (one strategy, one exposure-increasing authorization in flight, durable single-writer executor gate, no entry until ambiguous execution is reconciled, pending exposure counted as spent) satisfies it without a reservation system; general sleeve/cohort reservations become required only when concurrency is enabled. |
| Can DB mutation fabricate clearance or undo an effective pause? | `libs/contracts/src/entities/agents.ts` (`ActionCycle.verdict`, `cutoffs`, no signature), `libs/db/src/server/audit.ts` (hash-chained `audit.events`, external checkpoint replication, `verifyAgainstExternalCheckpoint`), `risk-state-projection.ts` (worker-signed, sequenced) | Existing structures can carry the proof without a new certificate or key: the worker records the CLEARED transition as an audit event (proposal hash, cutoff version, verdict, Release digest in `after_summary`), the projector includes that event's sequence and hash in the signed projection, and the risk-authorizer verifies the projection signature and the audit chain against the external checkpoint. A DB-only attacker cannot rewrite the chain without breaking the checkpoint. This is the recommended route; a standalone clearance envelope is only needed if the audit chain cannot be verified at authorization time. Pause: the runtime session's sticky `PAUSED` is read by the authorizer at authorization and by the executor before submit (M3 "local pause"); envelope expiry bounds the window; transactions already broadcast may land and are reconciled, not prevented. No epoch primitive is required for that property. |
| Do unsuccessful reviews always preserve deterministic protection? | `libs/execution/src/state/position-review.ts:82-89`; new test in `position-review.spec.ts`; new property in `mandatory-exit.spec.ts` | Yes. `REJECTED`, `EXPIRED` and `UNRESOLVED` all remove discretionary permission; `BUDGET_PAUSED` is behaviourally equivalent to `PROTECTION_ONLY` (same gating, same exits, same way back through a CLEARED open-position action, unreviewed stop still tightens); `classifyMandatoryExit` ignores the review state under every combination (property test). The enum change proposed in item 5B is therefore withdrawn; the equivalence tests replace it. |
| Is review state correctly scoped for the enabled configuration? | `supabase/migrations/20260906000500_trading.sql` (`positions.review_state`, `position_lots` without one) | Aggregate per mint. Correct for a single-strategy Profile 2 **only if** more than one strategy sleeve per mint is prohibited by configuration; that prohibition does not exist yet and is the smallest fix (a Release/readiness check, not a schema move). Lot-scoped review state stays a requirement for the multi-strategy Release, not for the pilot. |
| Does Profile 2 have tested signer restrictions appropriate to its declared policy? | ADR-0004; `docs/probes/` (no results yet) | Not testable yet: MP has not run. The ADR must state which restrictions Profile 2 relies on and the residual executor-compromise risk under each reading of D55/D65/§29; the follow-up is right that this is an interpretation to resolve, not a proven violation. |
| Are all enabled live-path invariants covered? | `invariant-test-map.yaml`, `tools/check-invariant-map.mjs` | 14/28 mapped; no applicability fields; the M8a row computation does not exist. The gate must be "every invariant applicable to the Profile 2 Release is mapped and green", explicitly not "M11 before M8a". |
| Does the runtime preserve and recover execution identity? | `libs/contracts/src/envelopes/journal.ts`, `order-attempt.ts` state machine (persist-before-submit, staged confirmation, `REORG_PENDING`) | Contracts and the pure machine exist and are tested; the executor, its durable journal and any target-environment crash evidence do not (M3/M8a). |

### What changes in the proposed patch

- **Item 4 (financial boundary):** replaced by properties with executable evidence. For Profile 2: concurrent valid intents cannot exceed a cap (restricted single-writer shape acceptable); DB-only tampering cannot invent clearance (audit-chain route above); an authorization issued before a pause cannot submit after it; protection that is installing or failed counts as unprotected exposure; base-unit arithmetic identities hold. Reservation and clearance contracts are drafted only if M7's implementation cannot meet the properties with what exists. Arming epochs are dropped as a requirement.
- **Item 5 (position review):** the enum change is withdrawn; two equivalence tests landed with this revision. Lot-scoped review state is deferred behind an explicit "one sleeve per mint" Release check for the pilot. The transactional handoff requirement stays (M6).
- **Item 3 (M5b):** narrowed to the safety inputs the Profile 2 Release actually consumes: the self-influence guard wired into the candidate machine, cohort inputs only for policy fields the Release enables, speed/expiry/chase enforcement, unknown classification treated as most restrictive. Regime classification, correlation clusters, session labels and further trigger families stay out of the gate.
- **Item 2 (signer policy):** reframed as an interpretation to resolve in the ADR with the residual risk written down under whichever posture is chosen; the four-way Probe A split stays because it costs nothing and tells the truth.
- **Item 1 (chain foundation):** the smallest correction only — ownership and evidence note in the plan, no new milestone; the capability test landed with this revision.
- **Item 6 (readiness):** applicability fields and gate rule stay; mutation testing is a handful of hand-written bypass tests (drop signature check, drop cap, drop expiry, release pending exposure early) in CI, not a platform.
- **Items 9 and 10 (paper fidelity, research):** an explicit, reproducible latency/fill model whose stale decision prices cannot pose as later executable fills, with the MEV/adverse-execution allowance defined once so costs are not double-counted; not a mandated requote algorithm. Earlier Profile 1B and earlier replay are optional optimisations; the one early acceptance test worth adding to M5a is "one recorded S0 decision can be reconstructed from its stored inputs without consulting mutable current state".
- **Item 11 (costs):** basis stated in `docs/costs.md`: actual incremental monthly spend on tiers created for this project (USD 39), free tiers listed, D57 Vercel Pro deferred to M8a; a projected steady-state row before Profile 2 (Vercel Pro 20 + Supabase Pro 25 + Birdeye Lite 39 = USD 84) is to be added.

### Consolidated plan patch (replaces the twelve-item list; still for operator approval)

1. **ADR-0007 — Profile 2 restricted capability set and its dependencies.** One strategy, one sleeve per mint, one exposure-increasing authorization in flight, `MONITORED_EXIT` unless the Trigger row is green, the enumerated transaction shapes; the safety inputs of that Release (item 3 narrowed) as the M8a dependency; shared chain foundation ownership note (item 1).
2. **ADR-0008 — Signer policy at Profile 2.** Interpretation of D55/D65/§29 resolved explicitly, restrictions and residual risk documented, Probe A split four ways.
3. **ADR-0009 — Financial-boundary properties.** The five properties above with owners (M3 executor gate and pause check, M5a arithmetic and paper accounting, M7 authorization path and audit-chain clearance verification, M8a protection lifecycle) and executable evidence; reservations/clearance contracts only on demonstrated need.
4. **ADR-0010 — Applicability-based readiness.** Invariant-map fields, gate rule, wording fixes (INV-05, emergency-signing authority, broadcast-before-pause), hand-written bypass tests, target-environment drills and `ReadinessRow` binding for M8a, severity wording.
5. **ADR-0001 amendment** (text only): every unsuccessful open-position outcome normalises to protection; `BUDGET_PAUSED` equivalence proven by test.
6. Plan-text edits without an ADR: MP probe authorization boundary and Trigger authentication probe; Replay Lab named in M9 step 8; the M5a reconstruction acceptance test; plan header and M2 migration count; migration-history repair recorded when done.

Freshness by strategy speed tier (former item 12) is kept as a small ADR-0011 because it changes what HEALTHY means; it is not on the tiny-live critical path.

### Landed with this revision (no decision needed)

- `libs/solana-hard-state/src/mint/read.spec.ts`: capability-boundary test — the closed method set holds only reads, no public method can express signing/sending/airdrops/key material, every public call reaches the transport with an allowlisted method.
- `libs/execution/src/state/position-review.spec.ts`: `BUDGET_PAUSED` ≡ `PROTECTION_ONLY` for gating, exits and the way back.
- `libs/risk/src/mandatory-exit/mandatory-exit.spec.ts`: property — the review state never changes a mandatory-exit decision.
