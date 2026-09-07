import { z } from 'zod';
import { ProviderHealth } from '../enums.js';
import { Instant, Milliseconds, MintAddress, NonEmptyString, UsdValue } from '../primitives.js';
import { CandleResolution } from './market.js';

/**
 * Market-data provider contracts (blueprint §3.1, §3.3, §21.1, §25, D63; execution plan M4).
 *
 * Providers are adapters behind these normalised shapes. Every value that a provider may leave
 * out is nullable, never defaulted to zero: a missing price is not a price of 0 (§32 "provider
 * zeros/nulls mistaken for real market values"). Every record carries `observedAt` (our clock) and,
 * where the provider states one, `providerUpdatedAt` (their clock), so freshness is measured, not
 * assumed.
 */

export const MarketDataProviderName = z.enum(['BIRDEYE', 'JUPITER_PRICE_V3']);
export type MarketDataProviderName = z.infer<typeof MarketDataProviderName>;

/** Data classes with their own freshness requirements (§21.1). */
export const DataClass = z.enum([
  'ACTIVE_POSITION_PRICE',
  'CANDIDATE_PRICE',
  'CANDLES',
  'TOKEN_OVERVIEW',
  'DISCOVERY_LIST',
  'TOKEN_SECURITY',
  'HOLDER_DISTRIBUTION',
  'SOCIAL_TRENDS',
  'PROJECT_METADATA',
]);
export type DataClass = z.infer<typeof DataClass>;

export const FreshnessEffectOnEntries = z.enum(['NONE', 'BLOCK']);
export const FreshnessEffectOnExits = z.enum(['NONE', 'BLOCK_IF_NO_ALTERNATIVE']);

/** One provider's promise for one data class; the risk engine consumes the resulting health, not guesses. */
export const FreshnessContract = z
  .strictObject({
    provider: MarketDataProviderName,
    dataClass: DataClass,
    /** Age at or below which the feed is HEALTHY. */
    freshMaxAgeMs: Milliseconds,
    /** Age at or below which the feed is DEGRADED; older is FAILED. */
    degradedMaxAgeMs: Milliseconds,
    effectOnEntries: FreshnessEffectOnEntries,
    effectOnExits: FreshnessEffectOnExits,
  })
  .refine((c) => c.degradedMaxAgeMs >= c.freshMaxAgeMs, { message: 'degradedMaxAgeMs must be >= freshMaxAgeMs', path: ['degradedMaxAgeMs'] });
export type FreshnessContract = z.infer<typeof FreshnessContract>;

export const RateLimitState = z.enum(['OK', 'THROTTLED', 'EXHAUSTED']);
export type RateLimitState = z.infer<typeof RateLimitState>;

/** Row shape of ops.provider_health, keyed `provider:dataClass`. */
export const FeedHealth = z.object({
  provider: z.string().min(1).max(64),
  state: ProviderHealth,
  lastSuccessAt: Instant.nullable(),
  freshnessAgeMs: Milliseconds.nullable(),
  latencyMs: Milliseconds.nullable(),
  rateLimitState: RateLimitState.nullable(),
  effectOnEntries: FreshnessEffectOnEntries,
  effectOnExits: FreshnessEffectOnExits,
  lastError: z.string().max(512).nullable(),
  updatedAt: Instant,
});
export type FeedHealth = z.infer<typeof FeedHealth>;

// Discovery universe (§7.1) --------------------------------------------------------------------

export const DiscoverySource = z.enum(['BIRDEYE_TRENDING', 'BIRDEYE_NEW_LISTING', 'BIRDEYE_TOKEN_LIST', 'MANUAL']);
export type DiscoverySource = z.infer<typeof DiscoverySource>;

/** A token as a discovery source reported it. Identity is the mint, never the symbol (§6.1). */
export const DiscoveredToken = z.object({
  mintAddress: MintAddress,
  symbol: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  decimals: z.number().int().min(0).max(18),
  source: DiscoverySource,
  rank: z.number().int().positive().nullable(),
  liquidityUsd: UsdValue.nullable(),
  volume24hUsd: UsdValue.nullable(),
  priceUsd: z.number().positive().nullable(),
  marketCapUsd: UsdValue.nullable(),
  /** When liquidity was first added, as the provider states it (new listings). */
  listedAt: Instant.nullable(),
  providerUpdatedAt: Instant.nullable(),
  observedAt: Instant,
});
export type DiscoveredToken = z.infer<typeof DiscoveredToken>;

// Prices ---------------------------------------------------------------------------------------

export const PriceQuote = z.object({
  mintAddress: MintAddress,
  provider: MarketDataProviderName,
  priceUsd: z.number().positive(),
  providerUpdatedAt: Instant.nullable(),
  /** Jupiter Price V3 reports the block the price was derived from. */
  blockId: z.number().int().nonnegative().nullable(),
  liquidityUsd: UsdValue.nullable(),
  observedAt: Instant,
});
export type PriceQuote = z.infer<typeof PriceQuote>;

// Token overview (§6.5 inputs) -----------------------------------------------------------------

export const OverviewWindow = z.enum(['m30', 'h1', 'h2', 'h4', 'h8', 'h24']);
export type OverviewWindow = z.infer<typeof OverviewWindow>;

export const OverviewWindowStats = z.object({
  volumeUsd: UsdValue.nullable(),
  buyVolumeUsd: UsdValue.nullable(),
  sellVolumeUsd: UsdValue.nullable(),
  tradeCount: z.number().int().nonnegative().nullable(),
  buyCount: z.number().int().nonnegative().nullable(),
  sellCount: z.number().int().nonnegative().nullable(),
  uniqueWallets: z.number().int().nonnegative().nullable(),
  priceChangePct: z.number().nullable(),
});
export type OverviewWindowStats = z.infer<typeof OverviewWindowStats>;

export const TokenOverview = z.object({
  mintAddress: MintAddress,
  symbol: z.string().max(32).nullable(),
  name: z.string().max(128).nullable(),
  decimals: z.number().int().min(0).max(18).nullable(),
  priceUsd: z.number().positive().nullable(),
  liquidityUsd: UsdValue.nullable(),
  marketCapUsd: UsdValue.nullable(),
  fdvUsd: UsdValue.nullable(),
  holderCount: z.number().int().nonnegative().nullable(),
  numberMarkets: z.number().int().nonnegative().nullable(),
  lastTradeAt: Instant.nullable(),
  windows: z.record(OverviewWindow, OverviewWindowStats),
  providerUpdatedAt: Instant.nullable(),
  observedAt: Instant,
});
export type TokenOverview = z.infer<typeof TokenOverview>;

// Candle gaps and retention (§6.4, §25, D63) ---------------------------------------------------

export const CandleGap = z.object({
  resolution: CandleResolution,
  /** First missing bucket (inclusive). */
  from: Instant,
  /** Last missing bucket (inclusive). */
  to: Instant,
  missingBuckets: z.number().int().positive(),
});
export type CandleGap = z.infer<typeof CandleGap>;

export const RetentionRule = z.object({
  resolution: CandleResolution,
  /** Days to keep; null means permanent. */
  retentionDays: z.number().int().positive().nullable(),
});
export type RetentionRule = z.infer<typeof RetentionRule>;

export const CandleRetentionPolicy = z.array(RetentionRule).min(1);
export type CandleRetentionPolicy = z.infer<typeof CandleRetentionPolicy>;

/** §25 initial policy: 15s weeks, 1m medium/long, 5m+ long. Mirrored in ops.retention_policies. */
export const DEFAULT_CANDLE_RETENTION: CandleRetentionPolicy = [
  { resolution: '15s', retentionDays: 21 },
  { resolution: '1m', retentionDays: 730 },
  { resolution: '5m', retentionDays: 1825 },
  { resolution: '15m', retentionDays: 1825 },
  { resolution: '1h', retentionDays: null },
  { resolution: '4h', retentionDays: null },
];

// Provider tiers (purchased capacity, §3, docs/costs.md) --------------------------------------

export const ProviderTier = z.object({
  provider: MarketDataProviderName,
  tier: NonEmptyString,
  requestsPerSecond: z.number().positive(),
  /** Birdeye compute units per month; null when the provider does not meter this way. */
  computeUnitsPerMonth: z.number().int().positive().nullable(),
  websocket: z.boolean(),
});
export type ProviderTier = z.infer<typeof ProviderTier>;
