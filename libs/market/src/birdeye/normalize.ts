import {
  Candle,
  DiscoveredToken,
  MintAddress,
  PriceQuote,
  TokenOverview,
  toInstant,
  type CandleResolution,
  type DataProvenance,
  type Instant,
  type OverviewWindow,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { isAligned } from '../candles/resolution.js';
import type { z } from 'zod';
import type { MultiPriceResponse, NewListingItem, OhlcvV3Item, TokenListItem, TokenOverviewResponse, TrendingItem } from './schemas.js';

/**
 * Birdeye → canonical contracts. Every rejection is explicit and reasoned so ingestion can count
 * what it dropped. A candle with a zero or inconsistent price is not a price; it is skipped
 * (§32 "provider zeros/nulls mistaken for real market values").
 */

export const BIRDEYE_INTERVAL: Readonly<Record<CandleResolution, string>> = {
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
};

export type CandleRejectReason = 'NON_FINITE' | 'NON_POSITIVE_CLOSE' | 'INCONSISTENT_OHLC' | 'MISALIGNED_BUCKET' | 'WRONG_INTERVAL' | 'MISSING_VOLUME';

export interface NormalizedCandles {
  candles: Candle[];
  rejected: { unixTime: number; reason: CandleRejectReason }[];
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function normalizeCandles(
  items: readonly OhlcvV3Item[],
  ctx: { assetId: Uuid; resolution: CandleResolution; provenance: DataProvenance; observedAt: Instant },
): NormalizedCandles {
  const out: NormalizedCandles = { candles: [], rejected: [] };
  for (const it of items) {
    const reject = (reason: CandleRejectReason) => out.rejected.push({ unixTime: it.unix_time, reason });
    if (it.type && it.type !== BIRDEYE_INTERVAL[ctx.resolution]) {
      reject('WRONG_INTERVAL');
      continue;
    }
    if (!finite(it.o) || !finite(it.h) || !finite(it.l) || !finite(it.c)) {
      reject('NON_FINITE');
      continue;
    }
    if (!(it.c > 0) || !(it.o > 0) || !(it.h > 0) || !(it.l > 0)) {
      reject('NON_POSITIVE_CLOSE');
      continue;
    }
    if (it.l > Math.min(it.o, it.c) || it.h < Math.max(it.o, it.c)) {
      reject('INCONSISTENT_OHLC');
      continue;
    }
    if (!finite(it.v_usd) || it.v_usd < 0) {
      reject('MISSING_VOLUME');
      continue;
    }
    const bucketTime = toInstant(it.unix_time * 1000);
    if (!isAligned(bucketTime, ctx.resolution)) {
      reject('MISALIGNED_BUCKET');
      continue;
    }
    const candle = Candle.safeParse({
      assetId: ctx.assetId,
      provider: 'BIRDEYE',
      resolution: ctx.resolution,
      bucketTime,
      observedAt: ctx.observedAt,
      provenance: ctx.provenance,
      open: it.o,
      high: it.h,
      low: it.l,
      close: it.c,
      volumeUsd: it.v_usd,
      tradeCount: null,
    });
    if (candle.success) out.candles.push(candle.data);
    else reject('NON_FINITE');
  }
  return out;
}

export function normalizePrices(data: z.infer<typeof MultiPriceResponse>['data'], observedAt: Instant): PriceQuote[] {
  const out: PriceQuote[] = [];
  if (!data) return out;
  for (const [address, entry] of Object.entries(data)) {
    if (!entry || !finite(entry.value) || !(entry.value > 0)) continue;
    const mint = MintAddress.safeParse(address);
    if (!mint.success) continue;
    const q = PriceQuote.safeParse({
      mintAddress: mint.data,
      provider: 'BIRDEYE',
      priceUsd: entry.value,
      providerUpdatedAt: finite(entry.updateUnixTime) ? toInstant(entry.updateUnixTime * 1000) : null,
      blockId: null,
      liquidityUsd: finite(entry.liquidity) && entry.liquidity >= 0 ? entry.liquidity : null,
      observedAt,
    });
    if (q.success) out.push(q.data);
  }
  return out;
}

const usd = (v: number | null | undefined): number | null => (finite(v) && v >= 0 ? v : null);
const pos = (v: number | null | undefined): number | null => (finite(v) && v > 0 ? v : null);
const decimalsOf = (v: number | null | undefined): number | null => (finite(v) && Number.isInteger(v) && v >= 0 && v <= 18 ? v : null);

function discovered(base: Omit<z.input<typeof DiscoveredToken>, 'observedAt'>, observedAt: Instant): DiscoveredToken | null {
  const r = DiscoveredToken.safeParse({ ...base, observedAt });
  return r.success ? r.data : null;
}

export function normalizeTrending(tokens: readonly TrendingItem[], providerUpdatedAt: Instant | null, observedAt: Instant): DiscoveredToken[] {
  const out: DiscoveredToken[] = [];
  for (const t of tokens) {
    const d = decimalsOf(t.decimals);
    if (d === null) continue;
    const item = discovered(
      {
        mintAddress: t.address,
        symbol: t.symbol || '?',
        name: t.name || t.symbol || '?',
        decimals: d,
        source: 'BIRDEYE_TRENDING',
        rank: finite(t.rank) && t.rank > 0 ? t.rank : null,
        liquidityUsd: usd(t.liquidity),
        volume24hUsd: usd(t.volume24hUSD),
        priceUsd: pos(t.price),
        marketCapUsd: usd(t.marketcap),
        listedAt: null,
        providerUpdatedAt,
      },
      observedAt,
    );
    if (item) out.push(item);
  }
  return out;
}

export function normalizeNewListings(items: readonly NewListingItem[], observedAt: Instant): DiscoveredToken[] {
  const out: DiscoveredToken[] = [];
  for (const t of items) {
    const d = decimalsOf(t.decimals);
    if (d === null) continue;
    let listedAt: Instant | null = null;
    if (t.liquidityAddedAt) {
      const ms = Date.parse(t.liquidityAddedAt);
      if (Number.isFinite(ms)) listedAt = toInstant(ms);
    }
    const item = discovered(
      {
        mintAddress: t.address,
        symbol: t.symbol || '?',
        name: t.name || t.symbol || '?',
        decimals: d,
        source: 'BIRDEYE_NEW_LISTING',
        rank: null,
        liquidityUsd: usd(t.liquidity),
        volume24hUsd: null,
        priceUsd: null,
        marketCapUsd: null,
        listedAt,
        providerUpdatedAt: null,
      },
      observedAt,
    );
    if (item) out.push(item);
  }
  return out;
}

export function normalizeTokenList(items: readonly TokenListItem[], observedAt: Instant): DiscoveredToken[] {
  const out: DiscoveredToken[] = [];
  for (const t of items) {
    const d = decimalsOf(t.decimals);
    if (d === null) continue;
    const item = discovered(
      {
        mintAddress: t.address,
        symbol: t.symbol || '?',
        name: t.name || t.symbol || '?',
        decimals: d,
        source: 'BIRDEYE_TOKEN_LIST',
        rank: null,
        liquidityUsd: usd(t.liquidity),
        volume24hUsd: usd(t.volume_24h_usd),
        priceUsd: pos(t.price),
        marketCapUsd: usd(t.market_cap),
        listedAt: finite(t.recent_listing_time) && t.recent_listing_time > 0 ? toInstant(t.recent_listing_time * 1000) : null,
        providerUpdatedAt: finite(t.last_trade_unix_time) && t.last_trade_unix_time > 0 ? toInstant(t.last_trade_unix_time * 1000) : null,
      },
      observedAt,
    );
    if (item) out.push(item);
  }
  return out;
}

const OVERVIEW_WINDOWS: Readonly<Record<OverviewWindow, string>> = { m30: '30m', h1: '1h', h2: '2h', h4: '4h', h8: '8h', h24: '24h' };

export function normalizeOverview(data: NonNullable<z.infer<typeof TokenOverviewResponse>['data']>, observedAt: Instant): TokenOverview | null {
  const rec = data as Record<string, unknown>;
  const n = (k: string): number | null => {
    const v = rec[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const i = (k: string): number | null => {
    const v = n(k);
    return v !== null && Number.isInteger(v) && v >= 0 ? v : null;
  };
  const windows = Object.fromEntries(
    (Object.keys(OVERVIEW_WINDOWS) as OverviewWindow[]).map((w) => {
      const s = OVERVIEW_WINDOWS[w];
      return [
        w,
        {
          volumeUsd: usd(n(`v${s}USD`)),
          buyVolumeUsd: usd(n(`vBuy${s}USD`)),
          sellVolumeUsd: usd(n(`vSell${s}USD`)),
          tradeCount: i(`trade${s}`),
          buyCount: i(`buy${s}`),
          sellCount: i(`sell${s}`),
          uniqueWallets: i(`uniqueWallet${s}`),
          priceChangePct: n(`priceChange${s}Percent`),
        },
      ];
    }),
  );
  const r = TokenOverview.safeParse({
    mintAddress: data.address,
    symbol: data.symbol ?? null,
    name: data.name ?? null,
    decimals: decimalsOf(data.decimals),
    priceUsd: pos(data.price),
    liquidityUsd: usd(data.liquidity),
    marketCapUsd: usd(data.marketCap),
    fdvUsd: usd(data.fdv),
    holderCount: i('holder'),
    numberMarkets: i('numberMarkets'),
    lastTradeAt: finite(data.lastTradeUnixTime) && data.lastTradeUnixTime > 0 ? toInstant(data.lastTradeUnixTime * 1000) : null,
    windows,
    providerUpdatedAt: finite(data.lastTradeUnixTime) && data.lastTradeUnixTime > 0 ? toInstant(data.lastTradeUnixTime * 1000) : null,
    observedAt,
  });
  return r.success ? r.data : null;
}
