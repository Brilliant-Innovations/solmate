import {
  DEFAULT_FRESHNESS_REQUIREMENTS,
  compareInstants,
  instantToMs,
  type DataClass,
  type FeedHealth,
  type FreshnessContract,
  type FreshnessRequirements,
  type Instant,
  type MarketDataProviderName,
  type ProviderHealth,
  type RateLimitState,
} from '@sol-agent-trader/contracts';

/**
 * Freshness → health (blueprint §21.1, §21.2 "Market feed degraded"). The risk engine and the
 * candidate machine consume the resulting FeedHealth; nothing downstream measures ages itself.
 * A feed that has never succeeded is FAILED, not "unknown": absence is the unsafe direction.
 */

export interface FreshnessInput {
  lastSuccessAt: Instant | null;
  now: Instant;
  latencyMs?: number | null;
  rateLimitState?: RateLimitState | null;
  lastError?: string | null;
}

export function healthKey(provider: MarketDataProviderName, dataClass: DataClass): string {
  return `${provider}:${dataClass}`;
}

export function evaluateFreshness(contract: FreshnessContract, input: FreshnessInput): FeedHealth {
  const age = input.lastSuccessAt === null ? null : Math.max(0, instantToMs(input.now) - instantToMs(input.lastSuccessAt));
  let state: ProviderHealth;
  if (age === null) state = 'FAILED';
  else if (age <= contract.freshMaxAgeMs) state = 'HEALTHY';
  else if (age <= contract.degradedMaxAgeMs) state = 'DEGRADED';
  else state = 'FAILED';
  if (input.rateLimitState === 'EXHAUSTED' && state === 'HEALTHY') state = 'DEGRADED';
  return {
    provider: healthKey(contract.provider, contract.dataClass),
    state,
    lastSuccessAt: input.lastSuccessAt,
    freshnessAgeMs: age,
    latencyMs: input.latencyMs ?? null,
    rateLimitState: input.rateLimitState ?? null,
    effectOnEntries: state === 'HEALTHY' ? 'NONE' : contract.effectOnEntries,
    effectOnExits: state === 'FAILED' ? contract.effectOnExits : 'NONE',
    lastError: input.lastError ?? null,
    updatedAt: input.now,
  };
}

/** Entries are blocked when any contract that blocks entries is not HEALTHY (§21.2). */
export function entriesBlocked(health: readonly FeedHealth[]): { blocked: boolean; reasons: string[] } {
  const reasons = health.filter((h) => h.effectOnEntries === 'BLOCK').map((h) => `${h.provider}:${h.state}`);
  return { blocked: reasons.length > 0, reasons };
}

/**
 * Contracts from the freshness requirements of the strategy speed tier in force (ADR-0011). The
 * purchased provider tier sizes rate and compute-unit budgets, never these limits: a tier that
 * cannot meet a requirement reports DEGRADED/FAILED and blocks entries, which Live Readiness shows
 * as a capability failure. Every Birdeye class gets a contract; the Jupiter secondary price feed
 * carries the same freshness as the primary position price.
 */
export function defaultFreshnessContracts(requirements: FreshnessRequirements = DEFAULT_FRESHNESS_REQUIREMENTS): FreshnessContract[] {
  const out: FreshnessContract[] = requirements.requirements.map((r) => ({ provider: 'BIRDEYE' as const, ...r }));
  const price = requirements.requirements.find((r) => r.dataClass === 'ACTIVE_POSITION_PRICE');
  if (price) out.splice(1, 0, { provider: 'JUPITER_PRICE_V3', dataClass: 'ACTIVE_POSITION_PRICE', freshMaxAgeMs: price.freshMaxAgeMs, degradedMaxAgeMs: price.degradedMaxAgeMs, effectOnEntries: 'NONE', effectOnExits: 'BLOCK_IF_NO_ALTERNATIVE' });
  return out;
}

/** Newest of several observations, or null when none. */
export function latestInstant(instants: readonly (Instant | null)[]): Instant | null {
  let best: Instant | null = null;
  for (const i of instants) if (i !== null && (best === null || compareInstants(i, best) > 0)) best = i;
  return best;
}
