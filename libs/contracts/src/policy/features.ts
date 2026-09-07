import { z } from 'zod';
import { VersionId } from '../primitives.js';

/**
 * Feature engine specification (blueprint §6.8, §8.1–8.3, D63). Versioned: a feature snapshot
 * records the engine version that produced it, and every indicator declares the closed 1-minute
 * candles it needs before it may emit a value. `STARTING` cannot leave warm-up until every enabled
 * indicator's lookback exists; an indicator without its lookback yields null, never zero.
 */
export const FeatureName = z.enum([
  // §8.1 price/momentum
  'ret_1m',
  'ret_3m',
  'ret_5m',
  'ret_15m',
  'ret_30m',
  'ret_1h',
  'ret_4h',
  'ret_accel_5m',
  'atr_14_pct',
  'realized_vol_30',
  'rsi_14',
  'ema_9_over_21',
  'ema_21_over_50',
  'macd_hist_pct',
  'bb_location_20',
  'bb_width_20',
  'vwap_distance_60',
  'breakout_20',
  'breakout_retest_20',
  'trend_persistence_20',
  'drawdown_from_high_60',
  'body_ratio_1',
  'upper_wick_ratio_1',
  // §8.2 volume/flow
  'rel_volume_60',
  'volume_accel_15',
  'trade_count_accel_15',
  'avg_trade_size_15',
  'volume_price_divergence_15',
  // §8.3 liquidity/executability (from the latest eligibility probes and overview)
  'liquidity_usd',
  'impact_bps_small',
  'impact_bps_large',
  'route_found_share',
  'sell_route_confirmed',
]);
export type FeatureName = z.infer<typeof FeatureName>;

export const FeatureEngineSpec = z.strictObject({
  version: VersionId,
  /** Closed 1m candles each indicator needs before it emits a value (D63 warm-up). */
  lookbackBuckets: z.record(FeatureName, z.number().int().nonnegative()),
  /** Indicators that must be warm before any candidate may be scored. */
  requiredForScoring: z.array(FeatureName).min(1),
});
export type FeatureEngineSpec = z.infer<typeof FeatureEngineSpec>;

export const FEATURE_ENGINE_V1: FeatureEngineSpec = {
  version: 'features-v1' as VersionId,
  lookbackBuckets: {
    ret_1m: 2,
    ret_3m: 4,
    ret_5m: 6,
    ret_15m: 16,
    ret_30m: 31,
    ret_1h: 61,
    ret_4h: 241,
    ret_accel_5m: 11,
    atr_14_pct: 15,
    realized_vol_30: 31,
    rsi_14: 15,
    ema_9_over_21: 21,
    ema_21_over_50: 50,
    macd_hist_pct: 35,
    bb_location_20: 20,
    bb_width_20: 20,
    vwap_distance_60: 60,
    breakout_20: 21,
    breakout_retest_20: 21,
    trend_persistence_20: 21,
    drawdown_from_high_60: 60,
    body_ratio_1: 1,
    upper_wick_ratio_1: 1,
    rel_volume_60: 61,
    volume_accel_15: 30,
    trade_count_accel_15: 30,
    avg_trade_size_15: 15,
    volume_price_divergence_15: 16,
    liquidity_usd: 0,
    impact_bps_small: 0,
    impact_bps_large: 0,
    route_found_share: 0,
    sell_route_confirmed: 0,
  },
  requiredForScoring: ['ret_5m', 'ret_15m', 'ret_1h', 'atr_14_pct', 'rsi_14', 'ema_9_over_21', 'rel_volume_60', 'breakout_20', 'liquidity_usd', 'impact_bps_small', 'sell_route_confirmed'],
};
