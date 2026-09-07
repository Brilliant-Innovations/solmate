import { instantToMs, type CapitalAuthority, type ColdStartGate, type ColdStartGateName, type Instant, type SessionPolicy } from '@sol-agent-trader/contracts';

/**
 * Cold-start gates (blueprint D63) and attended presence (D2, D62, §20.21). Pure: facts in, a
 * named verdict per gate out. STARTING can only leave when every gate passed; a missing fact is a
 * failed gate, never a pass.
 */

export interface ColdStartFacts {
  authority: CapitalAuthority;
  /** LIVE accounts: latest custody reconciliation status per account; a PAPER-only deployment has none. */
  reconciliations: { accountId: string; status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE' }[];
  /** Provider health rows whose effect on entries is BLOCK. */
  blockingFeeds: string[];
  /** Newest eligibility evaluation time across the universe; null when nothing was ever evaluated. */
  universeRefreshedAt: Instant | null;
  eligibleAssets: number;
  /** Tracked assets and how many carry a warm feature snapshot (every required feature present). */
  trackedAssets: number;
  warmAssets: number;
  /** Open positions and how many have a stale or missing safety evaluation. */
  openPositions: number;
  positionsWithStaleSafety: number;
  /** Live-only checks (signer, protection adapter, readiness); paper needs none. */
  liveChecksHealthy: boolean | null;
}

export function evaluateColdStartGates(facts: ColdStartFacts, policy: SessionPolicy, now: Instant): ColdStartGate[] {
  const gate = (name: ColdStartGateName, passed: boolean, detail: string | null): ColdStartGate => ({ name, passed, checkedAt: now, detail });
  const mismatches = facts.reconciliations.filter((r) => r.status !== 'CLEAN');
  const universeAge = facts.universeRefreshedAt === null ? null : instantToMs(now) - instantToMs(facts.universeRefreshedAt);
  const live = facts.authority === 'LIVE_APPROVAL' || facts.authority === 'LIVE_AUTO';
  return [
    gate('RECONCILIATION_CLEAN', mismatches.length === 0, mismatches.length ? `${mismatches.length} live account(s) not clean: ${mismatches.map((m) => `${m.accountId}:${m.status}`).join(', ')}` : facts.reconciliations.length ? `${facts.reconciliations.length} live account(s) clean` : 'no live accounts to reconcile'),
    gate('FEEDS_FRESH', facts.blockingFeeds.length === 0, facts.blockingFeeds.length ? `entries blocked by ${facts.blockingFeeds.join(', ')}` : null),
    gate('UNIVERSE_REFRESHED', universeAge !== null && universeAge <= policy.universeMaxAgeMs && facts.eligibleAssets > 0, universeAge === null ? 'no eligibility evaluation recorded' : `${facts.eligibleAssets} eligible, refreshed ${Math.round(universeAge / 60_000)} min ago`),
    gate('WARMUP_SUFFICIENT', facts.warmAssets >= policy.minWarmAssets && facts.warmAssets > 0, `${facts.warmAssets} of ${facts.trackedAssets} tracked assets warm (need ${policy.minWarmAssets})`),
    gate('HELD_ASSET_SAFETY_FRESH', facts.positionsWithStaleSafety === 0, facts.openPositions ? `${facts.positionsWithStaleSafety} of ${facts.openPositions} open positions without a fresh safety evaluation` : 'no open positions'),
    gate('AUTHORITY_CHECKS', live ? facts.liveChecksHealthy === true : true, live ? (facts.liveChecksHealthy === true ? 'live checks healthy' : 'live signer/protection/readiness checks not healthy') : `${facts.authority}: no signer or protection check required`),
  ];
}

export function coldStartPassed(gates: readonly ColdStartGate[]): boolean {
  return gates.length > 0 && gates.every((g) => g.passed);
}

export type Presence = 'PRESENT' | 'ABSENT' | 'NOT_REQUIRED';

/** Attended profiles need a live operator heartbeat for ACTIVE; unattended ones do not (D2, §20.21). */
export function presenceState(attended: boolean, lastHeartbeatAt: Instant | null, now: Instant, policy: SessionPolicy): Presence {
  if (!attended) return 'NOT_REQUIRED';
  if (lastHeartbeatAt === null) return 'ABSENT';
  return instantToMs(now) - instantToMs(lastHeartbeatAt) <= policy.presenceTimeoutMs ? 'PRESENT' : 'ABSENT';
}
