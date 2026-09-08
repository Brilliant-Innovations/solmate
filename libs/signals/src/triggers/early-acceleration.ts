import type { EarlyAccelerationTriggerPolicy, FeatureSnapshot } from '@sol-agent-trader/contracts';

/**
 * Early-acceleration trigger (blueprint §9.2): increasing slope and flow before an obvious
 * breakout, rather than buying after a large move. Pure function of the feature snapshot and the
 * versioned policy; a null feature fails its condition as FEATURE_COLD (D63) except the two
 * optional evidence conditions (trade-count acceleration, relative strength) that neither pass nor
 * fail when absent. Explainable: every condition, value and threshold is in the record.
 */

export type EarlyAccelerationCondition =
  | 'RETURN_ACCELERATING'
  | 'VOLUME_ACCELERATING'
  | 'TRADE_COUNT_ACCELERATING'
  | 'TREND_TURNING'
  | 'PERSISTENCE'
  | 'PRE_BREAKOUT'
  | 'NOT_AT_UPPER_BAND'
  | 'NOT_EXTENDED'
  | 'RSI_ROOM'
  | 'LIQUIDITY'
  | 'EXECUTABLE'
  | 'RELATIVE_STRENGTH';

export interface EarlyAccelerationEvaluation {
  fires: boolean;
  score: number;
  passed: EarlyAccelerationCondition[];
  failed: { condition: EarlyAccelerationCondition; reason: 'FEATURE_COLD' | 'BELOW_MIN' | 'ABOVE_MAX'; value: number | null; threshold: number }[];
  inputs: Record<string, number | null>;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export function evaluateEarlyAccelerationTrigger(snapshot: Pick<FeatureSnapshot, 'features'>, policy: EarlyAccelerationTriggerPolicy, solRelativeReturn1h: number | null = null): EarlyAccelerationEvaluation {
  const f = snapshot.features;
  const g = (name: string): number | null => {
    const v = f[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const inputs: Record<string, number | null> = {
    ret_accel_5m: g('ret_accel_5m'),
    ret_15m: g('ret_15m'),
    volume_accel_15: g('volume_accel_15'),
    trade_count_accel_15: g('trade_count_accel_15'),
    ema_9_over_21: g('ema_9_over_21'),
    trend_persistence_20: g('trend_persistence_20'),
    breakout_20: g('breakout_20'),
    bb_location_20: g('bb_location_20'),
    atr_14_pct: g('atr_14_pct'),
    rsi_14: g('rsi_14'),
    liquidity_usd: g('liquidity_usd'),
    impact_bps_small: g('impact_bps_small'),
    sol_relative_return_1h: solRelativeReturn1h,
  };
  const passed: EarlyAccelerationCondition[] = [];
  const failed: EarlyAccelerationEvaluation['failed'] = [];
  const atLeast = (condition: EarlyAccelerationCondition, value: number | null, threshold: number) => {
    if (value === null) failed.push({ condition, reason: 'FEATURE_COLD', value, threshold });
    else if (value >= threshold) passed.push(condition);
    else failed.push({ condition, reason: 'BELOW_MIN', value, threshold });
  };
  const atMost = (condition: EarlyAccelerationCondition, value: number | null, threshold: number) => {
    if (value === null) failed.push({ condition, reason: 'FEATURE_COLD', value, threshold });
    else if (value <= threshold) passed.push(condition);
    else failed.push({ condition, reason: 'ABOVE_MAX', value, threshold });
  };

  atLeast('RETURN_ACCELERATING', inputs['ret_accel_5m'] ?? null, policy.minReturnAccel5m);
  atLeast('VOLUME_ACCELERATING', inputs['volume_accel_15'] ?? null, policy.minVolumeAccel15);
  if (inputs['trade_count_accel_15'] !== null) atLeast('TRADE_COUNT_ACCELERATING', inputs['trade_count_accel_15'] ?? null, policy.minTradeCountAccel15);
  atLeast('TREND_TURNING', inputs['ema_9_over_21'] ?? null, policy.minEma9Over21);
  atLeast('PERSISTENCE', inputs['trend_persistence_20'] ?? null, policy.minTrendPersistence20);
  atMost('PRE_BREAKOUT', inputs['breakout_20'] ?? null, policy.maxBreakout20);
  atMost('NOT_AT_UPPER_BAND', inputs['bb_location_20'] ?? null, policy.maxBbLocation20);
  const atr = inputs['atr_14_pct'] ?? null;
  const ret15 = inputs['ret_15m'] ?? null;
  const extension = atr !== null && ret15 !== null && atr > 0 ? ret15 / atr : null;
  atMost('NOT_EXTENDED', extension, policy.maxExtensionAtrMultiple);
  atMost('RSI_ROOM', inputs['rsi_14'] ?? null, policy.maxRsi14);
  atLeast('LIQUIDITY', inputs['liquidity_usd'] ?? null, policy.minLiquidityUsd);
  atMost('EXECUTABLE', inputs['impact_bps_small'] ?? null, policy.maxImpactBpsSmall);
  if (solRelativeReturn1h !== null) atLeast('RELATIVE_STRENGTH', solRelativeReturn1h, policy.minSolRelativeReturn1h);

  if (failed.length > 0) return { fires: false, score: 0, passed, failed, inputs };

  // Score: floor 50 for every gate; acceleration strength (20), flow expansion (15), persistence (10), room below the band (5).
  const accelScore = 20 * clamp01(((inputs['ret_accel_5m'] as number) - policy.minReturnAccel5m) / (2 * policy.minReturnAccel5m));
  const flowScore = 15 * clamp01(((inputs['volume_accel_15'] as number) - policy.minVolumeAccel15) / (2 * policy.minVolumeAccel15));
  const persistScore = 10 * clamp01(((inputs['trend_persistence_20'] as number) - policy.minTrendPersistence20) / (1 - policy.minTrendPersistence20));
  const roomScore = 5 * clamp01((policy.maxBbLocation20 - (inputs['bb_location_20'] as number)) / policy.maxBbLocation20);
  const score = Math.round(50 + accelScore + flowScore + persistScore + roomScore);
  return { fires: score >= policy.minScannerScore, score, passed, failed, inputs };
}
