import {
  compareInstants,
  instantToMs,
  type DataClass,
  type FeedHealth,
  type FreshnessContract,
  type Instant,
  type MarketDataProviderName,
  type ProviderHealth,
  type ProviderTier,
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
 * Default contracts sized to the purchased Birdeye tier. Without WebSocket (Standard/Lite/Starter)
 * prices are polled, so the promise is looser than with streaming (Premium+). Standard's 1 rps
 * cannot keep a candidate price fresh for more than a handful of assets; its numbers exist so the
 * system degrades honestly rather than pretending.
 */
export function defaultFreshnessContracts(birdeye: ProviderTier): FreshnessContract[] {
  const streaming = birdeye.websocket;
  const slow = birdeye.requestsPerSecond <= 1;
  const pricePoll = streaming ? 5_000 : slow ? 60_000 : 15_000;
  return [
    { provider: 'BIRDEYE', dataClass: 'ACTIVE_POSITION_PRICE', freshMaxAgeMs: pricePoll, degradedMaxAgeMs: pricePoll * 3, effectOnEntries: 'BLOCK', effectOnExits: 'BLOCK_IF_NO_ALTERNATIVE' },
    { provider: 'JUPITER_PRICE_V3', dataClass: 'ACTIVE_POSITION_PRICE', freshMaxAgeMs: 15_000, degradedMaxAgeMs: 45_000, effectOnEntries: 'NONE', effectOnExits: 'BLOCK_IF_NO_ALTERNATIVE' },
    { provider: 'BIRDEYE', dataClass: 'CANDIDATE_PRICE', freshMaxAgeMs: pricePoll * 2, degradedMaxAgeMs: pricePoll * 6, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'TOKEN_OVERVIEW', freshMaxAgeMs: 120_000, degradedMaxAgeMs: 600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'DISCOVERY_LIST', freshMaxAgeMs: 300_000, degradedMaxAgeMs: 1_800_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'TOKEN_SECURITY', freshMaxAgeMs: 3_600_000, degradedMaxAgeMs: 21_600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'HOLDER_DISTRIBUTION', freshMaxAgeMs: 3_600_000, degradedMaxAgeMs: 21_600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'SOCIAL_TRENDS', freshMaxAgeMs: 900_000, degradedMaxAgeMs: 3_600_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
    { provider: 'BIRDEYE', dataClass: 'PROJECT_METADATA', freshMaxAgeMs: 86_400_000, degradedMaxAgeMs: 604_800_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
  ];
}

/** Newest of several observations, or null when none. */
export function latestInstant(instants: readonly (Instant | null)[]): Instant | null {
  let best: Instant | null = null;
  for (const i of instants) if (i !== null && (best === null || compareInstants(i, best) > 0)) best = i;
  return best;
}
