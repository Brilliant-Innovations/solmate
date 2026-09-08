import { addMs, compareInstants, instantToMs, type ActivityState, type AutomationRule, type AutomationSet, type AutomationTriggerType, type CapitalAuthority, type Instant, type PositionReviewState, type SpeedTier, type Uuid } from '@sol-agent-trader/contracts';
import type { SpendGateResult } from '../budget/spend-gate.js';

/**
 * Automation engine (blueprint §11.7, D39, D43). Deterministic: given the versioned automation
 * set, a trigger event and the target's firing history, it decides whether the Trading Skill is
 * invoked now, and records why not otherwise. It never bypasses eligibility, adversarial review,
 * risk authorization or mode gates; it only decides *whether to ask*.
 */

export type AutomationRunDispositionValue = 'INVOKED' | 'SKIPPED_COOLDOWN' | 'SKIPPED_BUDGET' | 'SKIPPED_MODE' | 'SKIPPED_ACTIVITY_STATE' | 'ERROR';

export interface TriggerEvent {
  type: AutomationTriggerType;
  /** Candidate, position or strategy id the trigger is about. */
  targetId: Uuid;
  at: Instant;
  details: Record<string, unknown>;
}

export interface TargetHistory {
  /** Last time any automation fired for this target. */
  lastFiredAt: Instant | null;
  /** Last firing per trigger type for this target. */
  lastFiredByType: Partial<Record<AutomationTriggerType, Instant>>;
  /** A cycle for this target is still running (one at a time per target). */
  cycleInFlight: boolean;
  /** Open-position review state, for the D39 retry backoff; null for candidates and system targets. */
  reviewState: PositionReviewState | null;
  consecutiveUnresolved: number;
}

export interface RuntimeFacts {
  capitalAuthority: CapitalAuthority;
  activityState: ActivityState;
  spendGate: SpendGateResult;
}

export type AutomationDecision =
  | { disposition: 'INVOKED'; rule: AutomationRule; nextEligibleAt: Instant }
  | { disposition: Exclude<AutomationRunDispositionValue, 'INVOKED' | 'ERROR'>; rule: AutomationRule | null; reason: string; nextEligibleAt: Instant | null };

const ACTIVE_STATES: ReadonlySet<ActivityState> = new Set(['ACTIVE', 'EVENT_WINDOW']);

export function ruleFor(set: AutomationSet, type: AutomationTriggerType): AutomationRule | null {
  return set.rules.find((r) => r.triggerType === type) ?? null;
}

/** D39: while a position is unreviewed, retries back off exponentially from the base to the ceiling. */
export function protectionOnlyBackoffMs(set: AutomationSet, consecutiveUnresolved: number): number {
  const n = Math.max(0, consecutiveUnresolved - 1);
  return Math.min(set.protectionOnlyRetryMaxMs, set.protectionOnlyRetryBaseMs * 2 ** n);
}

export function decideAutomation(set: AutomationSet, event: TriggerEvent, history: TargetHistory, facts: RuntimeFacts): AutomationDecision {
  const rule = ruleFor(set, event.type);
  if (!rule || !rule.enabled) return { disposition: 'SKIPPED_MODE', rule, reason: rule ? `automation ${rule.name} is disabled` : `no automation for trigger ${event.type} in ${set.version}`, nextEligibleAt: null };
  if (!rule.enabledModes.includes(facts.capitalAuthority)) return { disposition: 'SKIPPED_MODE', rule, reason: `${rule.name} not enabled in ${facts.capitalAuthority}`, nextEligibleAt: null };
  if (!ACTIVE_STATES.has(facts.activityState)) return { disposition: 'SKIPPED_ACTIVITY_STATE', rule, reason: `runtime is ${facts.activityState}`, nextEligibleAt: null };
  if (history.cycleInFlight) return { disposition: 'SKIPPED_COOLDOWN', rule, reason: 'a cycle for this target is in flight', nextEligibleAt: null };

  const now = instantToMs(event.at);
  // Mandatory-safety triggers keep their own short interval but still respect one-cycle-at-a-time.
  if (history.lastFiredAt !== null) {
    const cooldownUntil = instantToMs(history.lastFiredAt) + rule.cooldownMs;
    if (now < cooldownUntil) return { disposition: 'SKIPPED_COOLDOWN', rule, reason: `target cooldown until ${addMs(history.lastFiredAt, rule.cooldownMs)}`, nextEligibleAt: addMs(history.lastFiredAt, rule.cooldownMs) };
  }
  const lastOfType = history.lastFiredByType[event.type];
  if (lastOfType) {
    const intervalUntil = instantToMs(lastOfType) + rule.minIntervalMs;
    if (now < intervalUntil) return { disposition: 'SKIPPED_COOLDOWN', rule, reason: `${event.type} interval until ${addMs(lastOfType, rule.minIntervalMs)}`, nextEligibleAt: addMs(lastOfType, rule.minIntervalMs) };
  }
  if (history.reviewState !== null && history.reviewState !== 'REVIEWED' && history.lastFiredAt !== null) {
    const backoff = protectionOnlyBackoffMs(set, history.consecutiveUnresolved);
    const until = instantToMs(history.lastFiredAt) + backoff;
    if (now < until) return { disposition: 'SKIPPED_COOLDOWN', rule, reason: `PROTECTION_ONLY retry backoff (${history.consecutiveUnresolved} unresolved)`, nextEligibleAt: addMs(history.lastFiredAt, backoff) };
  }
  if (!facts.spendGate.ok) return { disposition: 'SKIPPED_BUDGET', rule, reason: `spend gate ${facts.spendGate.block.code}`, nextEligibleAt: null };
  return { disposition: 'INVOKED', rule, nextEligibleAt: addMs(event.at, Math.max(rule.cooldownMs, rule.minIntervalMs)) };
}

/** When several triggers fire for one target in the same tick, the highest priority wins; ties by rule name. */
export function pickTrigger(set: AutomationSet, events: readonly TriggerEvent[]): TriggerEvent | null {
  let best: { e: TriggerEvent; p: number; name: string } | null = null;
  for (const e of events) {
    const r = ruleFor(set, e.type);
    if (!r || !r.enabled) continue;
    if (!best || r.priority > best.p || (r.priority === best.p && r.name < best.name)) best = { e, p: r.priority, name: r.name };
  }
  return best?.e ?? null;
}

// Open-position trigger evaluation ------------------------------------------------------------

export interface PositionTriggerFacts {
  positionId: Uuid;
  speedTier: SpeedTier;
  openedAt: Instant;
  lastReassessedAt: Instant | null;
  nextReassessmentAt: Instant | null;
  averageEntryPrice: number | null;
  markPrice: number | null;
  /** Highest mark since entry, for milestone detection. */
  highWaterPrice: number | null;
  expectedHorizonEndsAt: Instant | null;
  volatilityRegimeChanged: boolean;
  liquidityDegraded: boolean;
  smartMoneyReversal: boolean;
  newSecurityEvidence: boolean;
  catalystChanged: boolean;
  protectiveOrderChanged: boolean;
  recoveredAfterRestart: boolean;
  profitMilestoneFraction: number | null;
}

/** Every open-position trigger that is due at `now` (§11.7). Ordering is by the automation set's priorities via pickTrigger. */
export function evaluatePositionTriggers(set: AutomationSet, f: PositionTriggerFacts, now: Instant): TriggerEvent[] {
  const out: TriggerEvent[] = [];
  const push = (type: AutomationTriggerType, details: Record<string, unknown> = {}) => out.push({ type, targetId: f.positionId, at: now, details });
  const heartbeat = set.heartbeatMsByTier[f.speedTier] ?? set.heartbeatMsByTier['T2_CONTEXTUAL'] ?? 1_800_000;
  const due = f.nextReassessmentAt ?? addMs(f.lastReassessedAt ?? f.openedAt, heartbeat);
  if (compareInstants(now, due) >= 0) push('REASSESSMENT_HEARTBEAT', { dueAt: due, heartbeatMs: heartbeat });
  if (f.averageEntryPrice !== null && f.averageEntryPrice > 0 && f.markPrice !== null) {
    const excursion = (f.markPrice - f.averageEntryPrice) / f.averageEntryPrice;
    if (Math.abs(excursion) >= set.priceExcursionFraction) push('PRICE_EXCURSION', { excursion });
    if (f.profitMilestoneFraction !== null && excursion >= f.profitMilestoneFraction) push('PROFIT_MILESTONE', { excursion, milestone: f.profitMilestoneFraction });
  }
  if (f.volatilityRegimeChanged) push('VOLATILITY_REGIME_SHIFT');
  if (f.liquidityDegraded) push('LIQUIDITY_ROUTE_DEGRADATION');
  if (f.smartMoneyReversal) push('SMART_MONEY_REVERSAL');
  if (f.newSecurityEvidence) push('SECURITY_EVIDENCE');
  if (f.catalystChanged) push('CATALYST_CHANGE');
  if (f.expectedHorizonEndsAt !== null && compareInstants(now, f.expectedHorizonEndsAt) >= 0) push('HORIZON_CHECKPOINT', { horizonEndsAt: f.expectedHorizonEndsAt });
  if (f.protectiveOrderChanged) push('PROTECTIVE_ORDER_STATE_CHANGE');
  if (f.recoveredAfterRestart) push('RECOVERY_AFTER_RESTART');
  return out;
}
