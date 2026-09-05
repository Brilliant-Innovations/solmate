import { z } from 'zod';
import { DataProvenance } from '../enums.js';
import { Amount, Bps, Instant, UsdValue, Uuid } from '../primitives.js';

// §6.4 market.candles ---------------------------------------------------------------------------

export const CandleResolution = z.enum(['15s', '1m', '5m', '15m', '1h', '4h']);
export type CandleResolution = z.infer<typeof CandleResolution>;

/** Provider prices are floats and analytics-only; sizing and accounting use base-unit Amounts. */
export const Candle = z.object({
  assetId: Uuid,
  provider: z.string(),
  resolution: CandleResolution,
  bucketTime: Instant,
  observedAt: Instant,
  provenance: DataProvenance,
  open: z.number().nonnegative(),
  high: z.number().nonnegative(),
  low: z.number().nonnegative(),
  close: z.number().nonnegative(),
  volumeUsd: UsdValue,
  tradeCount: z.number().int().nonnegative().nullable(),
});
export type Candle = z.infer<typeof Candle>;

// §6.5 market.snapshots -------------------------------------------------------------------------

const Windows = z.object({
  m5: z.number().nullable(),
  m15: z.number().nullable(),
  h1: z.number().nullable(),
  h4: z.number().nullable(),
  h24: z.number().nullable(),
});

export const MarketSnapshot = z.object({
  id: Uuid,
  assetId: Uuid,
  asOf: Instant,
  observedAt: Instant,
  provenance: DataProvenance,
  priceUsd: z.number().nonnegative().nullable(),
  liquidityUsd: UsdValue.nullable(),
  volumeUsd: Windows,
  buyVolumeUsd: Windows,
  sellVolumeUsd: Windows,
  buyCount: Windows,
  sellCount: Windows,
  relativeVolume: z.number().nonnegative().nullable(),
  atr: z.number().nonnegative().nullable(),
  realizedVolatility: z.number().nonnegative().nullable(),
  returns: z.object({
    s15: z.number().nullable(),
    m1: z.number().nullable(),
    m3: z.number().nullable(),
    m5: z.number().nullable(),
    m15: z.number().nullable(),
    m30: z.number().nullable(),
    h1: z.number().nullable(),
    h4: z.number().nullable(),
  }),
  marketCapUsd: UsdValue.nullable(),
  fdvUsd: UsdValue.nullable(),
  solRelativeReturn: z.number().nullable(),
  universeRelativeStrength: z.number().nullable(),
  routeProbes: z.array(
    z.object({
      sizeUsd: UsdValue,
      inputAmount: Amount,
      impactBps: Bps.nullable(),
      routeFound: z.boolean(),
    }),
  ),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;
