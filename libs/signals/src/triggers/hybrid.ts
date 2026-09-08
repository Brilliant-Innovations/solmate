import { instantToMs, type HybridTriggerPolicy, type Instant, type TriggerFamily } from '@sol-agent-trader/contracts';

/**
 * Hybrid ensemble trigger (blueprint §12.1 S4): aligned evidence across at least two independent
 * families inside a short window. Pure over the other families' recent verdicts on the same asset;
 * it introduces no new evidence of its own and never counts one family twice.
 */

export interface FamilySignal {
  family: Exclude<TriggerFamily, 'MANUAL_WATCH'>;
  firedAt: Instant;
  score: number;
}

export type HybridCondition = 'MIN_FAMILIES' | 'ALIGNED_IN_WINDOW' | 'INDEPENDENT_FAMILIES' | 'MIN_FAMILY_SCORE';

export interface HybridEvaluation {
  fires: boolean;
  score: number;
  passed: HybridCondition[];
  failed: { condition: HybridCondition; reason: 'BELOW_MIN' | 'ABOVE_MAX'; value: number; threshold: number }[];
  inputs: Record<string, number | string | null>;
  families: FamilySignal['family'][];
}

/** Families that share a data source are not independent of each other for S4. */
const INDEPENDENCE_GROUP: Record<FamilySignal['family'], string> = {
  MOMENTUM_CONTINUATION: 'MARKET',
  EARLY_ACCELERATION: 'MARKET',
  HOLDER_LIQUIDITY_EXPANSION: 'MARKET',
  SMART_MONEY_ACCUMULATION: 'ONCHAIN',
  CATALYST_RESPONSE: 'INTEL',
  SOCIAL_ACCELERATION: 'INTEL',
};

export function evaluateHybridTrigger(signals: readonly FamilySignal[], policy: HybridTriggerPolicy, now: Instant): HybridEvaluation {
  const passed: HybridCondition[] = [];
  const failed: HybridEvaluation['failed'] = [];
  const inWindow = signals.filter((s) => instantToMs(now) - instantToMs(s.firedAt) <= policy.alignmentWindowMs && instantToMs(s.firedAt) <= instantToMs(now) && s.score >= policy.minFamilyScore);
  // one signal per family (the strongest), then one family per independence group
  const byFamily = new Map<FamilySignal['family'], FamilySignal>();
  for (const s of inWindow) {
    const cur = byFamily.get(s.family);
    if (!cur || s.score > cur.score) byFamily.set(s.family, s);
  }
  const byGroup = new Map<string, FamilySignal>();
  for (const s of byFamily.values()) {
    const group = INDEPENDENCE_GROUP[s.family];
    const cur = byGroup.get(group);
    if (!cur || s.score > cur.score) byGroup.set(group, s);
  }
  const independent = [...byGroup.values()];
  const inputs: HybridEvaluation['inputs'] = { signals: signals.length, inWindow: inWindow.length, families: byFamily.size, independentFamilies: independent.length, families_list: [...byFamily.keys()].join(',') };
  if (byFamily.size >= policy.minFamilies) passed.push('MIN_FAMILIES');
  else failed.push({ condition: 'MIN_FAMILIES', reason: 'BELOW_MIN', value: byFamily.size, threshold: policy.minFamilies });
  if (independent.length >= policy.minFamilies) passed.push('INDEPENDENT_FAMILIES');
  else failed.push({ condition: 'INDEPENDENT_FAMILIES', reason: 'BELOW_MIN', value: independent.length, threshold: policy.minFamilies });
  if (inWindow.length > 0) passed.push('ALIGNED_IN_WINDOW');
  else failed.push({ condition: 'ALIGNED_IN_WINDOW', reason: 'BELOW_MIN', value: 0, threshold: 1 });
  const minScore = independent.length > 0 ? Math.min(...independent.map((s) => s.score)) : 0;
  if (independent.length > 0 && minScore >= policy.minFamilyScore) passed.push('MIN_FAMILY_SCORE');
  else failed.push({ condition: 'MIN_FAMILY_SCORE', reason: 'BELOW_MIN', value: minScore, threshold: policy.minFamilyScore });
  const mean = independent.length > 0 ? independent.reduce((a, s) => a + s.score, 0) / independent.length : 0;
  const score = Math.max(0, Math.min(100, Math.round(mean * (failed.length === 0 ? 1 : 0.5))));
  return { fires: failed.length === 0 && score >= policy.minScannerScore, score, passed, failed, inputs, families: independent.map((s) => s.family).sort() };
}
