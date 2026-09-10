import { instantToMs, toInstant, type AssetEligibility, type Candle, type DataProvenance, type FeatureEngineSpec, type FeatureName, type FeatureSnapshot, type Instant, type MarketSession, type TokenOverview, type Uuid } from '@sol-agent-trader/contracts';
import { acceleration, atrPct, averageTradeSize, bollinger, breakout, breakoutRetest, candleAnatomy, drawdownFromHigh, ema, macdHistogramPct, realizedVolatility, relativeVolume, rsi, simpleReturn, trendPersistence, volumePriceDivergence, vwapDistance, type Bar } from './indicators.js';

/**
 * Feature engine (blueprint §6.8, §8.1–8.3, D63). Pure and point-in-time: only 1-minute candles
 * whose bucket closed at or before `asOf` are used, gaps break the series (a missing bucket means
 * the indicators that span it are null), and every indicator whose declared lookback is not
 * present yields null. `warmup` tells the caller which required indicators are still cold so the
 * runtime stays in STARTING and no candidate is scored (D63). Feature values are never coerced to
 * zero; the vector records absence as null.
 */

const MINUTE = 60_000;

export interface FeatureInputs {
  id: Uuid;
  assetId: Uuid;
  asOf: Instant;
  provenance: DataProvenance;
  /** 1m candles, any order; other resolutions are ignored. */
  candles1m: readonly Candle[];
  overview: TokenOverview | null;
  /** The latest eligibility record: liquidity, route probes and sell-route confirmation (§8.3). */
  eligibility: Pick<AssetEligibility, 'liquidityUsd' | 'priceImpactProbes' | 'settlementRouteConfirmed'> | null;
  marketSnapshotId: Uuid | null;
  marketSessions: MarketSession[];
  selfInfluenceSuppressed: boolean;
  spec: FeatureEngineSpec;
}

export interface WarmupStatus {
  ready: boolean;
  /** Required indicators whose lookback is not yet available. */
  cold: FeatureName[];
  /** Closed, contiguous 1m buckets available ending at the last closed bucket before asOf. */
  contiguousBuckets: number;
}

export interface FeatureResult {
  snapshot: FeatureSnapshot;
  warmup: WarmupStatus;
}

/**
 * The newest closed 1m bucket that feeds this snapshot, or null when none does (WP1b, ADR-0011).
 *
 * This is the age that matters for a decision and the one nothing recorded: `asOf` is when the
 * feature was computed, and the engine runs every 60s regardless of whether its inputs moved. Measured
 * 2026-09-09, it ran about 200x more often than the candles beneath it changed, so `asOf` was fresh
 * on inputs five hours old.
 */
export function newestClosedBar(candles: readonly Candle[], asOf: Instant): Instant | null {
  const cutoff = instantToMs(asOf);
  let newest: number | null = null;
  for (const c of candles) {
    if (c.resolution !== "1m") continue;
    const t = instantToMs(c.bucketTime);
    if (t + MINUTE <= cutoff && (newest === null || t > newest)) newest = t;
  }
  return newest === null ? null : toInstant(newest);
}

/** Closed 1m bars before asOf as a contiguous run ending at the last closed bucket; a gap truncates the run. */
export function contiguousClosedBars(candles: readonly Candle[], asOf: Instant): Bar[] {
  const cutoff = instantToMs(asOf);
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (c.resolution !== '1m') continue;
    const t = instantToMs(c.bucketTime);
    if (t + MINUTE <= cutoff) byTime.set(t, c);
  }
  if (byTime.size === 0) return [];
  let t = Math.max(...byTime.keys());
  const run: Bar[] = [];
  while (byTime.has(t)) {
    const c = byTime.get(t) as Candle;
    run.push({ open: c.open, high: c.high, low: c.low, close: c.close, volumeUsd: c.volumeUsd, tradeCount: c.tradeCount });
    t -= MINUTE;
  }
  return run.reverse();
}

export function warmupStatus(bars: readonly Bar[], spec: FeatureEngineSpec): WarmupStatus {
  const cold = spec.requiredForScoring.filter((f) => (spec.lookbackBuckets[f] ?? 0) > bars.length);
  return { ready: cold.length === 0, cold, contiguousBuckets: bars.length };
}

export function computeFeatures(input: FeatureInputs): FeatureResult {
  const bars = contiguousClosedBars(input.candles1m, input.asOf);
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volumeUsd);
  const counts = bars.map((b) => b.tradeCount);
  const lb = input.spec.lookbackBuckets;
  const gate = (name: FeatureName, value: number | null): number | null => (bars.length >= (lb[name] ?? 0) && value !== null && Number.isFinite(value) ? value : null);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const bb = bollinger(closes, 20, 2);
  const anatomy = candleAnatomy(bars[bars.length - 1]);
  const ret5Series: (number | null)[] = closes.map((_, i) => simpleReturn(closes.slice(0, i + 1), 5));

  const probes = input.eligibility?.priceImpactProbes ?? [];
  const found = probes.filter((p) => p.routeFound);
  const bySize = [...found].sort((a, b) => a.sizeUsd - b.sizeUsd);
  const smallest = bySize[0];
  const largest = bySize[bySize.length - 1];

  const features: Record<string, number | null> = {
    ret_1m: gate('ret_1m', simpleReturn(closes, 1)),
    ret_3m: gate('ret_3m', simpleReturn(closes, 3)),
    ret_5m: gate('ret_5m', simpleReturn(closes, 5)),
    ret_15m: gate('ret_15m', simpleReturn(closes, 15)),
    ret_30m: gate('ret_30m', simpleReturn(closes, 30)),
    ret_1h: gate('ret_1h', simpleReturn(closes, 60)),
    ret_4h: gate('ret_4h', simpleReturn(closes, 240)),
    ret_accel_5m: gate('ret_accel_5m', ret5Series.length >= 11 && ret5Series[ret5Series.length - 1] !== null && ret5Series[ret5Series.length - 6] !== null ? (ret5Series[ret5Series.length - 1] as number) - (ret5Series[ret5Series.length - 6] as number) : null),
    atr_14_pct: gate('atr_14_pct', atrPct(bars, 14)),
    realized_vol_30: gate('realized_vol_30', realizedVolatility(closes, 30)),
    rsi_14: gate('rsi_14', rsi(closes, 14)),
    ema_9_over_21: gate('ema_9_over_21', ema9 !== null && ema21 !== null && ema21 > 0 ? ema9 / ema21 - 1 : null),
    ema_21_over_50: gate('ema_21_over_50', ema21 !== null && ema50 !== null && ema50 > 0 ? ema21 / ema50 - 1 : null),
    macd_hist_pct: gate('macd_hist_pct', macdHistogramPct(closes)),
    bb_location_20: gate('bb_location_20', bb?.location ?? null),
    bb_width_20: gate('bb_width_20', bb?.width ?? null),
    vwap_distance_60: gate('vwap_distance_60', vwapDistance(bars, 60)),
    breakout_20: gate('breakout_20', breakout(bars, 20)),
    breakout_retest_20: gate('breakout_retest_20', breakoutRetest(bars, 20)),
    trend_persistence_20: gate('trend_persistence_20', trendPersistence(closes, 20)),
    drawdown_from_high_60: gate('drawdown_from_high_60', drawdownFromHigh(bars, 60)),
    body_ratio_1: gate('body_ratio_1', anatomy?.body ?? null),
    upper_wick_ratio_1: gate('upper_wick_ratio_1', anatomy?.upperWick ?? null),
    rel_volume_60: gate('rel_volume_60', relativeVolume(bars, 60)),
    volume_accel_15: gate('volume_accel_15', acceleration(volumes, 15)),
    trade_count_accel_15: gate('trade_count_accel_15', acceleration(counts, 15)),
    avg_trade_size_15: gate('avg_trade_size_15', averageTradeSize(bars, 15)),
    volume_price_divergence_15: gate('volume_price_divergence_15', volumePriceDivergence(bars, 15)),
    liquidity_usd: input.eligibility?.liquidityUsd ?? input.overview?.liquidityUsd ?? null,
    impact_bps_small: smallest?.impactBps ?? null,
    impact_bps_large: largest?.impactBps ?? null,
    route_found_share: probes.length > 0 ? found.length / probes.length : null,
    sell_route_confirmed: input.eligibility ? (input.eligibility.settlementRouteConfirmed ? 1 : 0) : null,
  };

  return {
    snapshot: {
      id: input.id,
      assetId: input.assetId,
      asOf: input.asOf,
      newestInputAt: newestClosedBar(input.candles1m, input.asOf),
      featureEngineVersion: input.spec.version,
      provenance: input.provenance,
      marketSnapshotId: input.marketSnapshotId,
      features,
      regime: null,
      marketSessions: input.marketSessions,
      selfInfluenceSuppressed: input.selfInfluenceSuppressed,
    },
    warmup: warmupStatus(bars, input.spec),
  };
}
