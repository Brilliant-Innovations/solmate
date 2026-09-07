import { z } from 'zod';

/**
 * Raw Birdeye response shapes, as documented on data.birdeye.so on 2026-09-06. Loose objects:
 * extra fields are tolerated, the fields we consume are typed. Numbers may be null or absent;
 * normalisers decide what that means (never zero).
 */

const num = z.number().nullable().optional();
const int = z.number().int().nullable().optional();
const str = z.string().nullable().optional();

export const BirdeyeEnvelope = <T extends z.ZodType>(data: T) =>
  z.looseObject({
    success: z.boolean(),
    data: data.nullable().optional(),
    message: z.string().optional(),
  });

/** GET /defi/v3/ohlcv */
export const OhlcvV3Item = z.looseObject({
  o: num,
  h: num,
  l: num,
  c: num,
  v: num,
  v_usd: num,
  unix_time: z.number().int(),
  address: str,
  type: str,
  currency: str,
});
export type OhlcvV3Item = z.infer<typeof OhlcvV3Item>;

export const OhlcvV3Response = BirdeyeEnvelope(
  z.looseObject({
    is_scaled_ui_token: z.boolean().optional(),
    multiplier: num,
    items: z.array(OhlcvV3Item),
  }),
);

/** GET /defi/multi_price */
export const MultiPriceEntry = z.looseObject({
  value: num,
  updateUnixTime: int,
  updateHumanTime: str,
  priceChange24h: num,
  priceInNative: num,
  liquidity: num,
});
export const MultiPriceResponse = BirdeyeEnvelope(z.record(z.string(), MultiPriceEntry.nullable()));

/** GET /defi/token_trending */
export const TrendingItem = z.looseObject({
  address: z.string(),
  symbol: str,
  name: str,
  decimals: int,
  liquidity: num,
  price: num,
  volume24hUSD: num,
  volume24hChangePercent: num,
  rank: int,
  price24hChangePercent: num,
  fdv: num,
  marketcap: num,
});
export type TrendingItem = z.infer<typeof TrendingItem>;
export const TrendingResponse = BirdeyeEnvelope(
  z.looseObject({
    updateUnixTime: int,
    updateTime: str,
    total: int,
    tokens: z.array(TrendingItem),
  }),
);

/** GET /defi/v2/tokens/new_listing */
export const NewListingItem = z.looseObject({
  address: z.string(),
  symbol: str,
  name: str,
  decimals: int,
  source: str,
  liquidityAddedAt: str,
  liquidity: num,
});
export type NewListingItem = z.infer<typeof NewListingItem>;
export const NewListingResponse = BirdeyeEnvelope(z.looseObject({ items: z.array(NewListingItem) }));

/** GET /defi/v3/token/list */
export const TokenListItem = z.looseObject({
  address: z.string(),
  symbol: str,
  name: str,
  decimals: int,
  price: num,
  market_cap: num,
  fdv: num,
  liquidity: num,
  holder: int,
  volume_24h_usd: num,
  last_trade_unix_time: int,
  recent_listing_time: int,
});
export type TokenListItem = z.infer<typeof TokenListItem>;
export const TokenListResponse = BirdeyeEnvelope(z.looseObject({ items: z.array(TokenListItem), hasNext: z.boolean().optional() }));

/** GET /defi/token_overview */
export const TokenOverviewResponse = BirdeyeEnvelope(
  z
    .looseObject({
      address: z.string(),
      symbol: str,
      name: str,
      decimals: int,
      price: num,
      liquidity: num,
      marketCap: num,
      fdv: num,
      holder: int,
      numberMarkets: int,
      lastTradeUnixTime: int,
    })
    .catchall(z.unknown()),
);
