import type { ReplayDecision, VersionId } from '@sol-agent-trader/contracts';
import { coreMetrics, netOf, type ClosedTrade, type CoreMetrics } from './core.js';

/**
 * Attribution beyond the core table: AI incremental value (blueprint §19.3), proposer/adversary
 * disagreement (§11.14, §30 Q8/Q16), latency cost (§14.2, §30 Q17) and confidence calibration
 * (§11.14 with the run's defined prediction target). Every comparison pairs decisions by
 * candidate, so the baseline and the AI strategy are judged on the same opportunity set (§32
 * research validity: "does the baseline get the same candidate opportunity set?").
 */

const num = (s: string | null | undefined) => (s === null || s === undefined ? 0 : Number(s));

export type IncrementalCategory =
  | 'BOTH_TRADED'
  | 'AI_FILTERED_LOSER'
  | 'AI_REJECTED_WINNER'
  | 'AI_ADMITTED_NOT_BASELINE'
  | 'BOTH_PASSED';

export interface IncrementalValue {
  baselineStrategyVersionId: VersionId;
  aiStrategyVersionId: VersionId;
  candidates: number;
  byCategory: Record<IncrementalCategory, { count: number; baselineNet: number; aiNet: number }>;
  baselineNetTotal: number;
  aiNetTotal: number;
  modelCost: number;
  /** AI net − baseline net − model cost, per candidate opportunity. */
  incrementalNetExpectancy: number | null;
}

function traded(d: ReplayDecision | undefined): boolean {
  return !!d && d.cycleState === 'CLEARED' && d.fill !== null && d.rejection === null;
}
function realized(d: ReplayDecision | undefined): number {
  return d?.outcome ? num(d.outcome.realizedPnlBaseUnits) : 0;
}

/**
 * Pairs the baseline's and the AI strategy's decision on every candidate either saw (FULL variant)
 * and classifies the pair. Realized P&L is read in base units of the settlement asset and scaled
 * by `settlementScale` (10^decimals) so the report is decimal.
 */
export function incrementalValue(decisions: readonly ReplayDecision[], baseline: VersionId, ai: VersionId, modelCost: number, settlementScale: number): IncrementalValue {
  const byCandidate = new Map<string, { b?: ReplayDecision; a?: ReplayDecision }>();
  for (const d of decisions) {
    if (d.variant !== 'FULL') continue;
    const slot = byCandidate.get(d.candidateId) ?? {};
    if (d.strategyVersionId === baseline) slot.b = d;
    else if (d.strategyVersionId === ai) slot.a = d;
    byCandidate.set(d.candidateId, slot);
  }
  const empty = () => ({ count: 0, baselineNet: 0, aiNet: 0 });
  const byCategory: IncrementalValue['byCategory'] = { BOTH_TRADED: empty(), AI_FILTERED_LOSER: empty(), AI_REJECTED_WINNER: empty(), AI_ADMITTED_NOT_BASELINE: empty(), BOTH_PASSED: empty() };
  let baselineNetTotal = 0;
  let aiNetTotal = 0;
  let candidates = 0;
  for (const { b, a } of byCandidate.values()) {
    if (!b && !a) continue;
    candidates++;
    const bT = traded(b);
    const aT = traded(a);
    const bNet = bT ? realized(b) / settlementScale : 0;
    const aNet = aT ? realized(a) / settlementScale : 0;
    const cat: IncrementalCategory = bT && aT ? 'BOTH_TRADED' : bT && !aT ? (bNet <= 0 ? 'AI_FILTERED_LOSER' : 'AI_REJECTED_WINNER') : !bT && aT ? 'AI_ADMITTED_NOT_BASELINE' : 'BOTH_PASSED';
    const c = byCategory[cat];
    c.count++;
    c.baselineNet += bNet;
    c.aiNet += aNet;
    baselineNetTotal += bNet;
    aiNetTotal += aNet;
  }
  return {
    baselineStrategyVersionId: baseline,
    aiStrategyVersionId: ai,
    candidates,
    byCategory,
    baselineNetTotal,
    aiNetTotal,
    modelCost,
    incrementalNetExpectancy: candidates ? (aiNetTotal - baselineNetTotal - modelCost) / candidates : null,
  };
}

// --- proposer/adversary disagreement -------------------------------------------------------------

export interface DisagreementAttribution {
  strategyVersionId: VersionId;
  reviewed: number;
  confirmed: number;
  challenged: number;
  rejected: number;
  disagreementRate: number | null;
  /** Realized expectancy of trades the adversary confirmed outright versus trades that cleared after a challenge. */
  expectancyAfterConfirm: number | null;
  expectancyAfterChallenge: number | null;
  /** Counterfactual for adversary rejections: what the baseline realized on the same candidate (null when the baseline did not trade it). */
  rejectedCounterfactualNet: number | null;
  rejectedWithCounterfactual: number;
  /** Proposer-only shadow beside proposer+adversary (plan M10 addition), when the run produced it. */
  proposerOnlyNet: number | null;
  fullNet: number | null;
  topObjections: { code: string; count: number }[];
}

export function disagreementAttribution(decisions: readonly ReplayDecision[], ai: VersionId, baseline: VersionId, settlementScale: number): DisagreementAttribution {
  const full = decisions.filter((d) => d.strategyVersionId === ai && d.variant === 'FULL');
  const reviewed = full.filter((d) => d.adversaryVerdict !== null);
  const confirmed = reviewed.filter((d) => d.adversaryVerdict === 'CONFIRM');
  const challenged = reviewed.filter((d) => d.adversaryVerdict === 'CHALLENGE');
  const rejected = reviewed.filter((d) => d.adversaryVerdict === 'REJECT');
  const expectancy = (ds: ReplayDecision[]) => {
    const t = ds.filter(traded);
    return t.length ? t.reduce((a, d) => a + realized(d) / settlementScale, 0) / t.length : null;
  };
  const baselineByCandidate = new Map(decisions.filter((d) => d.strategyVersionId === baseline && d.variant === 'FULL').map((d) => [d.candidateId, d]));
  let cfNet = 0;
  let cfCount = 0;
  for (const d of rejected) {
    const b = baselineByCandidate.get(d.candidateId);
    if (traded(b)) {
      cfNet += realized(b) / settlementScale;
      cfCount++;
    }
  }
  const objections = new Map<string, number>();
  for (const d of [...challenged, ...rejected]) for (const c of d.reasonCodes) objections.set(c, (objections.get(c) ?? 0) + 1);
  const proposerOnly = decisions.filter((d) => d.strategyVersionId === ai && d.variant === 'PROPOSER_ONLY');
  const sum = (ds: ReplayDecision[]) => ds.filter(traded).reduce((a, d) => a + realized(d) / settlementScale, 0);
  return {
    strategyVersionId: ai,
    reviewed: reviewed.length,
    confirmed: confirmed.length,
    challenged: challenged.length,
    rejected: rejected.length,
    disagreementRate: reviewed.length ? (challenged.length + rejected.length) / reviewed.length : null,
    expectancyAfterConfirm: expectancy(confirmed),
    expectancyAfterChallenge: expectancy(challenged),
    rejectedCounterfactualNet: cfCount ? cfNet : null,
    rejectedWithCounterfactual: cfCount,
    proposerOnlyNet: proposerOnly.length ? sum(proposerOnly) : null,
    fullNet: full.length ? sum(full) : null,
    topObjections: [...objections.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)).slice(0, 10),
  };
}

// --- latency cost ---------------------------------------------------------------------------------

/** Rejections that are latency, not thesis (§14.2: recorded separately so reasoning latency cost is measurable). */
export const LATENCY_REJECTIONS: readonly string[] = ['INTENT_EXPIRED', 'QUOTE_STALE', 'CHASE_EXCEEDED', 'EXPIRED'];

export interface LatencyCost {
  strategyVersionId: VersionId;
  decisions: number;
  expiredByLatency: number;
  chaseRejected: number;
  staleQuoteRejected: number;
  /** Realized P&L the baseline made on candidates this strategy lost to latency (what was missed). */
  missedBaselineNet: number | null;
  averageDecisionLatencyMs: number | null;
  /** FULL net minus LATENCY_MATCHED net for the same strategy: edge attributable to speed alone (plan M10 latency-matched baseline). */
  edgeLostToLatency: number | null;
}

export function latencyCost(decisions: readonly ReplayDecision[], strategy: VersionId, baseline: VersionId, settlementScale: number): LatencyCost {
  const mine = decisions.filter((d) => d.strategyVersionId === strategy && d.variant === 'FULL');
  const expired = mine.filter((d) => d.cycleState === 'EXPIRED');
  const chase = mine.filter((d) => d.rejection === 'CHASE_EXCEEDED');
  const stale = mine.filter((d) => d.rejection === 'QUOTE_STALE' || d.rejection === 'INTENT_EXPIRED');
  const lost = [...expired, ...chase, ...stale];
  const baselineByCandidate = new Map(decisions.filter((d) => d.strategyVersionId === baseline && d.variant === 'FULL').map((d) => [d.candidateId, d]));
  let missed = 0;
  let missedCount = 0;
  for (const d of lost) {
    const b = baselineByCandidate.get(d.candidateId);
    if (traded(b)) {
      missed += realized(b) / settlementScale;
      missedCount++;
    }
  }
  const matched = decisions.filter((d) => d.strategyVersionId === strategy && d.variant === 'LATENCY_MATCHED');
  const sum = (ds: ReplayDecision[]) => ds.filter(traded).reduce((a, d) => a + realized(d) / settlementScale, 0);
  const lat = mine.map((d) => d.decisionLatencyMs);
  return {
    strategyVersionId: strategy,
    decisions: mine.length,
    expiredByLatency: expired.length,
    chaseRejected: chase.length,
    staleQuoteRejected: stale.length,
    missedBaselineNet: missedCount ? missed : null,
    averageDecisionLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    edgeLostToLatency: matched.length ? sum(mine) - sum(matched) : null,
  };
}

// --- confidence calibration -----------------------------------------------------------------------

export interface CalibrationBin {
  label: string;
  count: number;
  meanConfidence: number | null;
  hitRate: number | null;
  realizedExpectancy: number | null;
}

export interface Calibration {
  strategyVersionId: VersionId;
  targetKind: string;
  scored: number;
  bins: CalibrationBin[];
  /** Mean squared error between confidence and the 0/1 target; lower is better, 0.25 is a coin flip at 0.5. */
  brierScore: number | null;
}

export function calibration(decisions: readonly ReplayDecision[], strategy: VersionId, targetKind: string, binOf: (c: number) => string, binLabels: readonly string[], settlementScale: number): Calibration {
  const scored = decisions.filter((d) => d.strategyVersionId === strategy && d.variant === 'FULL' && d.proposerConfidence !== null && d.outcome?.targetHit !== null && d.outcome !== null);
  const groups = new Map<string, ReplayDecision[]>();
  for (const d of scored) {
    const k = binOf(d.proposerConfidence as number);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  let brier = 0;
  for (const d of scored) brier += ((d.proposerConfidence as number) - (d.outcome!.targetHit ? 1 : 0)) ** 2;
  const bins = binLabels.map((label) => {
    const ds = groups.get(label) ?? [];
    const hits = ds.filter((d) => d.outcome!.targetHit).length;
    return {
      label,
      count: ds.length,
      meanConfidence: ds.length ? ds.reduce((a, d) => a + (d.proposerConfidence as number), 0) / ds.length : null,
      hitRate: ds.length ? hits / ds.length : null,
      realizedExpectancy: ds.length ? ds.reduce((a, d) => a + realized(d) / settlementScale, 0) / ds.length : null,
    };
  });
  return { strategyVersionId: strategy, targetKind, scored: scored.length, bins, brierScore: scored.length ? brier / scored.length : null };
}

// --- strategy comparison ------------------------------------------------------------------------

export interface StrategyComparisonRow {
  strategyVersionId: VersionId;
  sample: 'IN_SAMPLE' | 'HOLD_OUT' | 'ALL';
  metrics: CoreMetrics;
}

/** One row per strategy and sample split over the same timeline; hold-out rows exist only when the run declared a split. */
export function compareStrategies(trades: readonly (ClosedTrade & { sample: 'IN_SAMPLE' | 'HOLD_OUT' })[], failedByStrategy: Record<string, number>, startingEquity: number, window: { from: ClosedTrade['openedAt']; to: ClosedTrade['closedAt'] }, holdout: boolean): StrategyComparisonRow[] {
  const ids = [...new Set(trades.map((t) => t.strategyVersionId))].sort();
  const rows: StrategyComparisonRow[] = [];
  for (const id of ids) {
    const mine = trades.filter((t) => t.strategyVersionId === id);
    rows.push({ strategyVersionId: id, sample: 'ALL', metrics: coreMetrics({ trades: mine, failedExecutions: failedByStrategy[id] ?? 0, startingEquity, window }) });
    if (holdout) {
      for (const sample of ['IN_SAMPLE', 'HOLD_OUT'] as const) rows.push({ strategyVersionId: id, sample, metrics: coreMetrics({ trades: mine.filter((t) => t.sample === sample), failedExecutions: 0, startingEquity, window }) });
    }
  }
  return rows;
}

export { netOf };
