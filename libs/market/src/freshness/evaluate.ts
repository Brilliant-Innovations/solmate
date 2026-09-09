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
  /**
   * The newest datum we actually hold for this class (DEFECT-4, 2026-09-09).
   *
   * Supply this for every class backed by a store. Omit it only for a class where a successful call
   * *is* the datum and nothing is persisted to age. `null` means the class is backed by a store and
   * that store is empty, which is FAILED — absence stays the unsafe direction.
   */
  newestDatumAt?: Instant | null;
  now: Instant;
  latencyMs?: number | null;
  rateLimitState?: RateLimitState | null;
  lastError?: string | null;
}

export function healthKey(provider: MarketDataProviderName, dataClass: DataClass): string {
  return `${provider}:${dataClass}`;
}

export function evaluateFreshness(contract: FreshnessContract, input: FreshnessInput): FeedHealth {
  const nowMs = instantToMs(input.now);
  const callAge = input.lastSuccessAt === null ? null : Math.max(0, nowMs - instantToMs(input.lastSuccessAt));

  /**
   * DEFECT-4 (2026-09-09): a successful call is not fresh data.
   *
   * This used to be `now - lastSuccessAt` and nothing else, which measures how recently we *spoke to*
   * the provider, never how old the newest datum is. Because the worker calls OHLCV every cycle and
   * the call succeeds even when the response adds nothing — 78% of the time, measured — `CANDLES`
   * reported HEALTHY with `freshness_age_ms: 2306` while the newest 1m candle for all 43 eligible
   * assets was 232–347 minutes old. `effectOnEntries` is only ever set when the state is not HEALTHY,
   * so ADR-0011's `BLOCK` for candles could never fire, at any staleness. The 2026-09-08 M4 entry
   * recorded this exact symptom and fixed the planner starvation beneath it; the alarm that failed to
   * announce it was left as it was, and was still reporting HEALTHY a day later.
   *
   * The feed is now only as fresh as the worse of the two: data we have not refreshed is stale even
   * if the provider is answering, and a provider that has stopped answering is stale even if the last
   * datum was recent. A class that supplies `newestDatumAt: null` has nothing stored and is FAILED.
   */
  const measuresDatum = 'newestDatumAt' in input;
  const datumAge = input.newestDatumAt == null ? null : Math.max(0, nowMs - instantToMs(input.newestDatumAt));
  const age = !measuresDatum ? callAge : datumAge === null ? null : Math.max(datumAge, callAge ?? 0);

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
