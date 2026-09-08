import { instantToMs, type CatalystTriggerPolicy, type FeatureSnapshot, type Instant, type SourceQualityClass, type SourceTimeConfidence, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Catalyst-response trigger (blueprint §9.4, §10.3, D64): a fresh, trustworthy-timed, novel event
 * for an eligible asset followed by market confirmation. Pure over the visible events and the
 * feature snapshot; a recycled or syndicated story is not fresh, an untrusted source time cannot
 * open a fast window, and social-only evidence never qualifies (§9.5).
 */

export interface CatalystEvidence {
  id: Uuid;
  kind: string;
  sourceQuality: SourceQualityClass;
  sourceTimeConfidence: SourceTimeConfidence;
  sourcePublishedAt: Instant | null;
  firstSeenAt: Instant;
  noveltyScore: number | null;
  clusterId: Uuid | null;
  corroboratesEventId: Uuid | null;
}

export type CatalystCondition = 'FRESH_CATALYST' | 'SOURCE_QUALITY' | 'SOURCE_TIME_TRUSTED' | 'NOVEL' | 'MARKET_CONFIRMS_RETURN' | 'MARKET_CONFIRMS_VOLUME' | 'LIQUIDITY';

export interface CatalystEvaluation {
  fires: boolean;
  score: number;
  passed: CatalystCondition[];
  failed: { condition: CatalystCondition; reason: 'ABSENT' | 'BELOW_MIN' | 'ABOVE_MAX' | 'UNTRUSTED' | 'FEATURE_COLD'; value: number | string | null; threshold: number | string }[];
  inputs: Record<string, number | string | null>;
  catalystEvidenceId: Uuid | null;
}

const QUALITY_RANK: Record<SourceQualityClass, number> = { PRIMARY_GOVERNMENT_REGULATORY: 6, OFFICIAL_EXCHANGE_PROTOCOL: 5, OFFICIAL_PROJECT: 5, REPUTABLE_PUBLICATION: 4, ANALYTICS_PROVIDER: 3, IDENTIFIED_CREATOR: 2, UNKNOWN_SOCIAL: 1 };
const TIME_RANK: Record<SourceTimeConfidence, number> = { ABSENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function evaluateCatalystTrigger(events: readonly CatalystEvidence[], snapshot: Pick<FeatureSnapshot, 'features'>, policy: CatalystTriggerPolicy, now: Instant): CatalystEvaluation {
  const passed: CatalystCondition[] = [];
  const failed: CatalystEvaluation['failed'] = [];
  const f = snapshot.features;
  const g = (name: string): number | null => (typeof f[name] === 'number' && Number.isFinite(f[name]) ? (f[name] as number) : null);
  // The best fresh catalyst: NEW relation (no cluster parent), trusted time inside the age limit, quality at or above the floor, not social-only.
  const fresh = events
    .filter((e) => e.corroboratesEventId === null && e.kind !== 'SOCIAL')
    .filter((e) => e.sourcePublishedAt !== null && instantToMs(now) - instantToMs(e.sourcePublishedAt) <= policy.maxCatalystAgeMs && instantToMs(e.firstSeenAt) <= instantToMs(now))
    .sort((a, b) => instantToMs(b.sourcePublishedAt as Instant) - instantToMs(a.sourcePublishedAt as Instant));
  const best = fresh[0] ?? null;
  const inputs: CatalystEvaluation['inputs'] = { events: events.length, freshEvents: fresh.length, catalystAgeMs: best?.sourcePublishedAt ? instantToMs(now) - instantToMs(best.sourcePublishedAt) : null, sourceQuality: best?.sourceQuality ?? null, sourceTimeConfidence: best?.sourceTimeConfidence ?? null, noveltyScore: best?.noveltyScore ?? null, ret_15m: g('ret_15m'), rel_volume_60: g('rel_volume_60'), liquidity_usd: g('liquidity_usd') };
  if (!best) failed.push({ condition: 'FRESH_CATALYST', reason: 'ABSENT', value: null, threshold: policy.maxCatalystAgeMs });
  else {
    passed.push('FRESH_CATALYST');
    if (QUALITY_RANK[best.sourceQuality] >= QUALITY_RANK[policy.minSourceQuality]) passed.push('SOURCE_QUALITY');
    else failed.push({ condition: 'SOURCE_QUALITY', reason: 'BELOW_MIN', value: best.sourceQuality, threshold: policy.minSourceQuality });
    if (TIME_RANK[best.sourceTimeConfidence] >= TIME_RANK[policy.minSourceTimeConfidence]) passed.push('SOURCE_TIME_TRUSTED');
    else failed.push({ condition: 'SOURCE_TIME_TRUSTED', reason: 'UNTRUSTED', value: best.sourceTimeConfidence, threshold: policy.minSourceTimeConfidence });
    if ((best.noveltyScore ?? 1) >= policy.minNoveltyScore) passed.push('NOVEL');
    else failed.push({ condition: 'NOVEL', reason: 'BELOW_MIN', value: best.noveltyScore, threshold: policy.minNoveltyScore });
  }
  const check = (condition: CatalystCondition, name: string, min: number) => {
    const v = g(name);
    if (v === null) failed.push({ condition, reason: 'FEATURE_COLD', value: null, threshold: min });
    else if (v >= min) passed.push(condition);
    else failed.push({ condition, reason: 'BELOW_MIN', value: v, threshold: min });
  };
  check('MARKET_CONFIRMS_RETURN', 'ret_15m', policy.minReturn15m);
  check('MARKET_CONFIRMS_VOLUME', 'rel_volume_60', policy.minRelativeVolume60);
  check('LIQUIDITY', 'liquidity_usd', policy.minLiquidityUsd);
  const total = passed.length + failed.length;
  const qualityBonus = best ? (QUALITY_RANK[best.sourceQuality] - 1) * 5 : 0;
  const score = Math.max(0, Math.min(100, Math.round((passed.length / total) * 80 + qualityBonus)));
  return { fires: failed.length === 0 && score >= policy.minScannerScore, score, passed, failed, inputs, catalystEvidenceId: best?.id ?? null };
}
