import { instantToMs, type Instant, type RiskPolicy } from '@sol-agent-trader/contracts';

/**
 * Deterministic stop and exit policies (blueprint §13.4, §13.5; D39 "unreviewed stop may only
 * tighten"; §31 "mandatory risk-reduction actions cannot be blocked or delayed by an LLM"). The
 * strategy declares the policy type; these functions compute and enforce it. Prices are settlement
 * per token as numbers because they describe levels, never money owed; money stays in base units.
 */

export interface StopInputs {
  entryPrice: number;
  atrPct: number | null;
  structureLowPrice: number | null;
  /** Strategy-specific invalidation translated into a price, when the model is STRATEGY_INVALIDATION. */
  invalidationPrice?: number | null;
}

export interface StopLevel {
  level: number;
  distanceFraction: number;
}

/** Stop from the model, then capped by the percentage cap: never wider than `maxStopFraction` below entry. Null when the model lacks its input. */
export function stopLevel(policy: RiskPolicy['stop'], input: StopInputs): StopLevel | null {
  const e = input.entryPrice;
  if (!(e > 0) || !Number.isFinite(e)) return null;
  let model: number | null = null;
  switch (policy.model) {
    case 'ATR':
      model = input.atrPct !== null && input.atrPct > 0 ? e * (1 - policy.atrMultiple * input.atrPct) : null;
      break;
    case 'STRUCTURE_LOW':
      model = input.structureLowPrice !== null && input.structureLowPrice > 0 && input.structureLowPrice < e ? input.structureLowPrice : null;
      break;
    case 'PERCENTAGE':
      model = e * (1 - policy.maxStopFraction);
      break;
    case 'STRATEGY_INVALIDATION':
      model = input.invalidationPrice !== undefined && input.invalidationPrice !== null && input.invalidationPrice > 0 && input.invalidationPrice < e ? input.invalidationPrice : null;
      break;
  }
  if (model === null) return null;
  const cap = e * (1 - policy.maxStopFraction);
  const level = Math.max(model, cap);
  if (!(level > 0) || level >= e) return null;
  // Round to 1e-9 so a derived distance does not carry floating-point noise into stored records.
  return { level, distanceFraction: Math.round(((e - level) / e) * 1e9) / 1e9 };
}

export interface ExitInputs {
  entryPrice: number;
  currentPrice: number;
  /** Highest price observed since entry (for trailing). */
  highSinceEntry: number;
  currentStop: number;
  initialStopDistanceFraction: number;
  openedAt: Instant;
  now: Instant;
  /** Momentum-decay signal from the feature engine when the policy is MOMENTUM_DECAY. */
  momentumDecayed?: boolean;
}

export type ExitDecision =
  | { action: 'HOLD'; stop: number; reasons: string[] }
  | { action: 'TIGHTEN_STOP'; stop: number; reasons: string[] }
  | { action: 'REDUCE'; stop: number; fraction: number; reasons: string[] }
  | { action: 'EXIT'; stop: number; reasons: string[] };

/**
 * Evaluates the declared take-profit/trailing/time policy against the current price. The stop
 * returned is never below the current stop (D39): trailing only tightens. A hard stop breach is
 * an EXIT regardless of the policy.
 */
export function evaluateExitPolicy(policy: RiskPolicy['takeProfit'], input: ExitInputs): ExitDecision {
  const reasons: string[] = [];
  const { entryPrice: e, currentPrice: p, highSinceEntry: h } = input;
  let stop = input.currentStop;
  if (p <= stop) return { action: 'EXIT', stop, reasons: ['HARD_STOP'] };
  const rNow = input.initialStopDistanceFraction > 0 ? (p / e - 1) / input.initialStopDistanceFraction : 0;
  const rHigh = input.initialStopDistanceFraction > 0 ? (h / e - 1) / input.initialStopDistanceFraction : 0;

  if (instantToMs(input.now) - instantToMs(input.openedAt) >= policy.maxHoldMs) return { action: 'EXIT', stop, reasons: ['TIME_STOP'] };

  switch (policy.policy) {
    case 'FIXED_R':
      if (rNow >= policy.targetRMultiple) return { action: 'EXIT', stop, reasons: ['TARGET_REACHED'] };
      break;
    case 'PARTIAL_TIERS':
      if (rNow >= policy.targetRMultiple) return { action: 'EXIT', stop, reasons: ['TARGET_REACHED'] };
      if (rNow >= policy.targetRMultiple / 2) return { action: 'REDUCE', stop, fraction: 0.5, reasons: ['PARTIAL_TIER'] };
      break;
    case 'TRAILING_AFTER_THRESHOLD':
    case 'VOLATILITY_TRAIL': {
      if (rHigh >= policy.trailAfterRMultiple) {
        const trailed = h * (1 - policy.trailFraction);
        if (trailed > stop) {
          stop = trailed;
          reasons.push('TRAIL_TIGHTENED');
        }
        if (p <= stop) return { action: 'EXIT', stop, reasons: [...reasons, 'TRAIL_STOP'] };
      }
      if (rNow >= policy.targetRMultiple) return { action: 'EXIT', stop, reasons: [...reasons, 'TARGET_REACHED'] };
      break;
    }
    case 'MOMENTUM_DECAY':
      if (input.momentumDecayed) return { action: 'EXIT', stop, reasons: ['MOMENTUM_DECAY'] };
      break;
    case 'TIME_STOP':
      break;
  }
  return reasons.length ? { action: 'TIGHTEN_STOP', stop, reasons } : { action: 'HOLD', stop, reasons };
}
