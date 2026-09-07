import type { FeatureSnapshot, MomentumTriggerPolicy } from '@sol-agent-trader/contracts';

/**
 * Momentum-continuation trigger (blueprint §9.1). Pure function of a feature snapshot and the
 * versioned policy. Every condition is checked against a named feature; a null feature fails its
 * condition with reason FEATURE_COLD, so nothing cold can ever fire (D63). The scanner score is
 * a fixed, explainable formula so the trigger record can show why a candidate scored what it did.
 */

export type MomentumCondition =
  | 'RETURN_15M'
  | 'RELATIVE_VOLUME'
  | 'EMA_TREND'
  | 'NOT_EXTENDED'
  | 'RSI_NOT_EXHAUSTED'
  | 'LIQUIDITY'
  | 'EXECUTABLE'
  | 'RELATIVE_STRENGTH';

export interface MomentumEvaluation {
  fires: boolean;
  /** 0–100 when it fires; 0 otherwise. */
  score: number;
  passed: MomentumCondition[];
  failed: { condition: MomentumCondition; reason: 'FEATURE_COLD' | 'BELOW_MIN' | 'ABOVE_MAX'; value: number | null; threshold: number }[];
  /** Feature values the decision used, for the trigger record (§9 "explainable trigger records"). */
  inputs: Record<string, number | null>;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export function evaluateMomentumTrigger(snapshot: Pick<FeatureSnapshot, 'features'>, policy: MomentumTriggerPolicy, solRelativeReturn1h: number | null = null): MomentumEvaluation {
  const f = snapshot.features;
  const g = (name: string): number | null => {
    const v = f[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const inputs: Record<string, number | null> = {
    ret_15m: g('ret_15m'),
    rel_volume_60: g('rel_volume_60'),
    ema_9_over_21: g('ema_9_over_21'),
    atr_14_pct: g('atr_14_pct'),
    rsi_14: g('rsi_14'),
    liquidity_usd: g('liquidity_usd'),
    impact_bps_small: g('impact_bps_small'),
    breakout_20: g('breakout_20'),
    sol_relative_return_1h: solRelativeReturn1h,
  };
  const passed: MomentumCondition[] = [];
  const failed: MomentumEvaluation['failed'] = [];
  const atLeast = (condition: MomentumCondition, value: number | null, threshold: number) => {
    if (value === null) failed.push({ condition, reason: 'FEATURE_COLD', value, threshold });
    else if (value >= threshold) passed.push(condition);
    else failed.push({ condition, reason: 'BELOW_MIN', value, threshold });
  };
  const atMost = (condition: MomentumCondition, value: number | null, threshold: number) => {
    if (value === null) failed.push({ condition, reason: 'FEATURE_COLD', value, threshold });
    else if (value <= threshold) passed.push(condition);
    else failed.push({ condition, reason: 'ABOVE_MAX', value, threshold });
  };

  atLeast('RETURN_15M', inputs['ret_15m'] ?? null, policy.minReturn15m);
  atLeast('RELATIVE_VOLUME', inputs['rel_volume_60'] ?? null, policy.minRelativeVolume60);
  atLeast('EMA_TREND', inputs['ema_9_over_21'] ?? null, policy.minEma9Over21);
  const atr = inputs['atr_14_pct'] ?? null;
  const ret15 = inputs['ret_15m'] ?? null;
  const extension = atr !== null && ret15 !== null && atr > 0 ? ret15 / atr : null;
  atMost('NOT_EXTENDED', extension, policy.maxExtensionAtrMultiple);
  atMost('RSI_NOT_EXHAUSTED', inputs['rsi_14'] ?? null, policy.maxRsi14);
  atLeast('LIQUIDITY', inputs['liquidity_usd'] ?? null, policy.minLiquidityUsd);
  atMost('EXECUTABLE', inputs['impact_bps_small'] ?? null, policy.maxImpactBpsSmall);
  // Relative strength is optional evidence: when SOL data is absent it neither passes nor fails.
  if (solRelativeReturn1h !== null) atLeast('RELATIVE_STRENGTH', solRelativeReturn1h, policy.minSolRelativeReturn1h);

  if (failed.length > 0) return { fires: false, score: 0, passed, failed, inputs };

  // Score: every gate passed earns the policy floor (50); strength above the thresholds earns up to 50 more —
  // return strength (20), volume expansion (15), trend and breakout (10), room to run before extension (5).
  const retScore = 20 * clamp01(((ret15 as number) - policy.minReturn15m) / (2 * policy.minReturn15m));
  const volScore = 15 * clamp01(((inputs['rel_volume_60'] as number) - policy.minRelativeVolume60) / (2 * policy.minRelativeVolume60));
  const trendScore = 5 * clamp01((inputs['ema_9_over_21'] as number) / 0.02) + (inputs['breakout_20'] === 1 ? 5 : 0);
  const roomScore = 5 * clamp01(1 - (extension as number) / policy.maxExtensionAtrMultiple);
  const score = Math.round(50 + retScore + volScore + trendScore + roomScore);
  return { fires: score >= policy.minScannerScore, score, passed, failed, inputs };
}
