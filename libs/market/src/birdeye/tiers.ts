import type { ProviderTier } from '@sol-agent-trader/contracts';

/**
 * Birdeye Data Services packages as published on 2026-09-06 (data.birdeye.so/docs/guides/payment/pricing).
 * The operator picks the purchased tier in configuration; adapters size their budgets from it and
 * docs/costs.md records the run-rate. WebSocket streaming exists from Premium upward, so P1's
 * "REST first, WebSocket when the tier allows" is a configuration fact, not a code branch.
 */
export const BIRDEYE_TIERS = {
  STANDARD: { provider: 'BIRDEYE', tier: 'STANDARD', requestsPerSecond: 1, computeUnitsPerMonth: 30_000, websocket: false },
  LITE: { provider: 'BIRDEYE', tier: 'LITE', requestsPerSecond: 15, computeUnitsPerMonth: 2_500_000, websocket: false },
  STARTER: { provider: 'BIRDEYE', tier: 'STARTER', requestsPerSecond: 15, computeUnitsPerMonth: 8_000_000, websocket: false },
  PREMIUM: { provider: 'BIRDEYE', tier: 'PREMIUM', requestsPerSecond: 50, computeUnitsPerMonth: 20_000_000, websocket: true },
  BUSINESS: { provider: 'BIRDEYE', tier: 'BUSINESS', requestsPerSecond: 100, computeUnitsPerMonth: 60_000_000, websocket: true },
} as const satisfies Record<string, ProviderTier>;

export type BirdeyeTierName = keyof typeof BIRDEYE_TIERS;

/** Compute-unit cost per endpoint (data.birdeye.so/docs/guides/what-is-compute-unit-cost). */
export const BIRDEYE_CU = {
  /** GET /defi/v3/ohlcv: 45 CU up to 1000 items, 75 up to 2000, 100 up to 5000. */
  ohlcvV3: (items: number): number => (items <= 1000 ? 45 : items <= 2000 ? 75 : 100),
  /** GET /defi/multi_price: ceil(3 * n^0.8). */
  multiPrice: (addresses: number): number => Math.ceil(3 * Math.pow(addresses, 0.8)),
  tokenTrending: 25,
  newListing: 20,
  tokenListV3: 50,
  tokenOverview: 15,
  tokenSecurity: 25,
  holderDistribution: 30,
} as const;

/** Per-endpoint ceilings the provider enforces regardless of tier. */
export const BIRDEYE_ENDPOINT_LIMITS = {
  ohlcvMaxItems: 5000,
  multiPriceMaxAddresses: 100,
  trendingMaxLimit: 50,
  newListingMaxLimit: 20,
  tokenListMaxLimit: 100,
  tokenListMaxOffset: 10_000,
} as const;
