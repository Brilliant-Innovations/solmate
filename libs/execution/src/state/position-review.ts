import type { ActionCycleTerminalState, Instant, PositionReviewState, TradingActionType, UnresolvedReason } from '@sol-agent-trader/contracts';

/**
 * Position review state machine (blueprint D39, §11.11A, §20.9, ADR-0001).
 *
 * A `trading.positions` concern: how an open position reacts to the terminal state of its latest
 * reassessment cycle and to budget events. Independent of the action-cycle machine, which owns
 * no position behavior. Deterministic protection (stops, trails, circuit breakers, provider orders)
 * is unaffected by this state; it only gates *discretionary* agent actions.
 *
 * A position becomes REVIEWED only through a CLEARED cycle whose action is an affirmative
 * open-position decision (HOLD, REDUCE, EXIT, ADJUST_PROTECTION). A cleared IGNORE, ENTER or
 * missing action is not a review of the position and is rejected (review #0 F1).
 */

export interface PositionReview {
  reviewState: PositionReviewState;
  reason: UnresolvedReason | null;
  since: Instant;
  lastReviewedCycleId: string | null;
  /** D39: may only tighten. For a long position a higher stop is tighter. */
  unreviewedStop: number | null;
  consecutiveUnresolved: number;
}

export type PositionReviewEvent =
  | {
      type: 'CYCLE_TERMINATED';
      at: Instant;
      cycleId: string;
      terminal: ActionCycleTerminalState;
      action: TradingActionType | null;
      unresolvedReason: UnresolvedReason | null;
    }
  | { type: 'BUDGET_EXHAUSTED'; at: Instant }
  | { type: 'TIGHTEN_UNREVIEWED_STOP'; at: Instant; level: number };

export type PositionReviewRejection =
  | { code: 'STOP_WOULD_LOOSEN'; current: number; requested: number }
  | { code: 'INVALID_STOP_LEVEL'; requested: number }
  | { code: 'MISSING_UNRESOLVED_REASON' }
  | { code: 'NOT_A_POSITION_REVIEW_ACTION'; action: TradingActionType | null };

export type PositionReviewResult = { ok: true; review: PositionReview } | { ok: false; rejection: PositionReviewRejection };

const POSITION_REVIEW_ACTIONS: ReadonlySet<TradingActionType> = new Set(['HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION']);

export function initialPositionReview(openedAt: Instant, openingCycleId: string | null): PositionReview {
  return { reviewState: 'REVIEWED', reason: null, since: openedAt, lastReviewedCycleId: openingCycleId, unreviewedStop: null, consecutiveUnresolved: 0 };
}

export function reviewTransition(review: PositionReview, event: PositionReviewEvent): PositionReviewResult {
  switch (event.type) {
    case 'BUDGET_EXHAUSTED':
      return {
        ok: true,
        review: { ...review, reviewState: 'BUDGET_PAUSED', reason: 'BUDGET', since: event.at, consecutiveUnresolved: review.consecutiveUnresolved + 1 },
      };

    case 'TIGHTEN_UNREVIEWED_STOP': {
      if (!Number.isFinite(event.level) || event.level < 0) return { ok: false, rejection: { code: 'INVALID_STOP_LEVEL', requested: event.level } };
      if (review.unreviewedStop !== null && event.level < review.unreviewedStop) {
        return { ok: false, rejection: { code: 'STOP_WOULD_LOOSEN', current: review.unreviewedStop, requested: event.level } };
      }
      return { ok: true, review: { ...review, unreviewedStop: event.level } };
    }

    case 'CYCLE_TERMINATED': {
      if (event.terminal === 'CLEARED') {
        if (event.action === null || !POSITION_REVIEW_ACTIONS.has(event.action)) {
          return { ok: false, rejection: { code: 'NOT_A_POSITION_REVIEW_ACTION', action: event.action } };
        }
        // A cleared HOLD/REDUCE/EXIT/ADJUST_PROTECTION is an affirmative, reviewed decision (§11.11).
        return {
          ok: true,
          review: { ...review, reviewState: 'REVIEWED', reason: null, since: event.at, lastReviewedCycleId: event.cycleId, consecutiveUnresolved: 0 },
        };
      }
      if (event.terminal === 'UNRESOLVED' && event.unresolvedReason === null) {
        return { ok: false, rejection: { code: 'MISSING_UNRESOLVED_REASON' } };
      }
      // UNRESOLVED, EXPIRED and REJECTED all mean the runtime may not guess HOLD or EXIT (D39).
      const reason: UnresolvedReason =
        event.terminal === 'UNRESOLVED' ? (event.unresolvedReason as UnresolvedReason) : event.terminal === 'EXPIRED' ? 'TIMEOUT' : 'DISAGREEMENT';
      const reviewState: PositionReviewState = reason === 'BUDGET' ? 'BUDGET_PAUSED' : 'PROTECTION_ONLY';
      return {
        ok: true,
        review: { ...review, reviewState, reason, since: event.at, consecutiveUnresolved: review.consecutiveUnresolved + 1 },
      };
    }
  }
}

/** Only a REVIEWED position may execute a discretionary agent action (INV-20). */
export function discretionaryActionsAllowed(review: Pick<PositionReview, 'reviewState'>): boolean {
  return review.reviewState === 'REVIEWED';
}
