import fc from 'fast-check';
import { fixtures, type ActionCycleTerminalState, type Instant, type UnresolvedReason } from '@sol-agent-trader/contracts';
import { discretionaryActionsAllowed, initialPositionReview, reviewTransition, type PositionReview } from './position-review.js';

const T0 = fixtures.T0 as Instant;
const REASONS: UnresolvedReason[] = ['DISAGREEMENT', 'ADVERSARY_UNAVAILABLE', 'TIMEOUT', 'BUDGET', 'MALFORMED_OUTPUT', 'REVISION_EXHAUSTED'];

describe('position review state (D39, INV-20)', () => {
  it('only CLEARED yields REVIEWED; every other terminal removes discretionary permission', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ActionCycleTerminalState>('CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED'),
        fc.constantFrom(...REASONS),
        fc.constantFrom<PositionReview['reviewState']>('REVIEWED', 'PROTECTION_ONLY', 'BUDGET_PAUSED'),
        (terminal, reason, startState) => {
          const start: PositionReview = { ...initialPositionReview(T0, null), reviewState: startState };
          const r = reviewTransition(start, {
            type: 'CYCLE_TERMINATED', at: T0, cycleId: 'c1', terminal, action: 'HOLD',
            unresolvedReason: terminal === 'UNRESOLVED' ? reason : null,
          });
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.review.reviewState === 'REVIEWED').toBe(terminal === 'CLEARED');
          expect(discretionaryActionsAllowed(r.review)).toBe(terminal === 'CLEARED');
          if (terminal === 'UNRESOLVED') expect(r.review.reason).toBe(reason);
          if (terminal === 'UNRESOLVED' && reason === 'BUDGET') expect(r.review.reviewState).toBe('BUDGET_PAUSED');
        },
      ),
    );
  });

  it('a CLEARED cycle whose action is not an open-position decision does not review the position', () => {
    for (const action of ['IGNORE', 'ENTER', 'ADD', null] as const) {
      const r = reviewTransition(
        { ...initialPositionReview(T0, null), reviewState: 'PROTECTION_ONLY' },
        { type: 'CYCLE_TERMINATED', at: T0, cycleId: 'c9', terminal: 'CLEARED', action, unresolvedReason: null },
      );
      expect(r.ok, String(action)).toBe(false);
    }
  });

  it('an UNRESOLVED terminal without a reason is rejected', () => {
    const r = reviewTransition(initialPositionReview(T0, null), {
      type: 'CYCLE_TERMINATED', at: T0, cycleId: 'c1', terminal: 'UNRESOLVED', action: 'HOLD', unresolvedReason: null,
    });
    expect(r.ok).toBe(false);
  });

  it('the unreviewed stop can only tighten; NaN, infinities and negatives are rejected and cannot poison the guard', () => {
    const levelArb = fc.oneof(
      { weight: 8, arbitrary: fc.double({ min: 0, max: 1000, noNaN: true }) },
      { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5) },
    );
    fc.assert(
      fc.property(fc.array(levelArb, { minLength: 1, maxLength: 20 }), (levels) => {
        let review = initialPositionReview(T0, null);
        let current: number | null = null;
        for (const level of levels) {
          const r = reviewTransition(review, { type: 'TIGHTEN_UNREVIEWED_STOP', at: T0, level });
          if (!Number.isFinite(level) || level < 0) {
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.rejection.code).toBe('INVALID_STOP_LEVEL');
          } else if (current === null || level >= current) {
            expect(r.ok).toBe(true);
            if (r.ok) { review = r.review; current = level; }
          } else {
            expect(r.ok).toBe(false);
          }
        }
        expect(review.unreviewedStop).toBe(current);
      }),
    );
  });

  it('budget exhaustion pauses discretionary actions until a newly cleared cycle', () => {
    const paused = reviewTransition(initialPositionReview(T0, null), { type: 'BUDGET_EXHAUSTED', at: T0 });
    expect(paused.ok && paused.review.reviewState).toBe('BUDGET_PAUSED');
    if (!paused.ok) return;
    const cleared = reviewTransition(paused.review, { type: 'CYCLE_TERMINATED', at: T0, cycleId: 'c2', terminal: 'CLEARED', action: 'HOLD', unresolvedReason: null });
    expect(cleared.ok && cleared.review.reviewState).toBe('REVIEWED');
  });
});
