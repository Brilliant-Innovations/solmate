# ADR-0011 — Freshness requirements come from the strategy speed tier, not the purchased provider tier

**Status:** Accepted
**Date:** 2026-09-08
**Class (§31 taxonomy):** DEFECT (§21.1 freshness is a property of what a decision needs; sizing it to the purchased tier hides a capability shortfall)
**Blueprint text affected:** §21.1, §21.2; plan v4 M4 (freshness contracts "sized to purchased tiers").
**§31-protected decision affected:** "critical stale data fails closed for entries" — strengthened, not weakened.
**Source:** operator review item 12 (unacceptable shortcut: "widening freshness limits merely to fit the purchased tier").

## Context

`defaultFreshnessContracts(tier)` sets the price freshness limit to 5 s with streaming, 15 s on a fast polled tier and 60 s on a 1 rps tier. The system then reports HEALTHY on a tier that could never serve a fast decision. Degradation was honest relative to the tier, not relative to the decision.

## Decision

- Freshness contracts are a versioned policy keyed by data class and **strategy speed tier** (`T0_FAST`, `T1_STANDARD`, `T2_SLOW`); the deployment's enabled Releases determine the strictest tier in force. Until M5a defines speed tiers, the default is the `T1_STANDARD` requirement set (price fresh ≤ 15 s, degraded ≤ 45 s; candles ≤ 90 s; overview ≤ 120 s; security ≤ 1 h) regardless of provider tier.
- A purchased provider tier that cannot meet the requirement produces `DEGRADED`/`FAILED` rows with `effectOnEntries: BLOCK` for the classes a decision needs. That is reported in Live Readiness as a capability failure, never absorbed by loosening the limit.
- The provider tier still sizes rate and compute-unit budgets (that is what it is for).

## Consequences

- `libs/market/src/freshness/evaluate.ts` takes a `FreshnessRequirements` policy instead of a `ProviderTier`; the worker passes the default policy; M5a binds it to the Release's speed tier.
- On the current Lite tier with 5-minute ingest and no price polling for candidates, `CANDIDATE_PRICE` will read FAILED with no effect until candidates exist, then BLOCK until the ingest cadence meets 15 s for candidate mints. That is the intended signal.

## Operator sign-off

Sean Rogers, 2026-09-08.
