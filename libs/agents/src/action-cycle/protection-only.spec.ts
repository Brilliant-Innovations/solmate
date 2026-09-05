import fc from 'fast-check';
import { fixtures, type ActionCycle, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { discretionaryActionsAllowed, initialPositionReview, reviewTransition } from '@sol-agent-trader/execution';
import { newActionCycle, transition, type ActionCycleEvent } from './machine.js';

/**
 * INV-20 across both machines (ADR-0001): an open-position reassessment cycle that does not end
 * CLEARED can never leave the position REVIEWED, and a HOLD counts as reviewed only when cleared.
 */

const T0 = fixtures.T0 as Instant;
const RUN = fixtures.IDS.message as Uuid;

function openPositionCycle(): ActionCycle {
  return newActionCycle({
    id: fixtures.IDS.cycle as Uuid,
    triggerId: fixtures.IDS.trigger as Uuid,
    strategyVersionId: 'S1@1.0.0' as ActionCycle['strategyVersionId'],
    speedTier: 'T2_CONTEXTUAL',
    decisionBudgetMs: 60_000,
    startedAt: T0,
    positionId: fixtures.IDS.position as Uuid,
  });
}

type Ending = 'CONFIRM' | 'REJECT' | 'DOUBLE_CHALLENGE' | 'ADVERSARY_UNAVAILABLE' | 'TIMEOUT' | 'BUDGET_EXHAUSTED' | 'MALFORMED_OUTPUT' | 'EXPIRED';

function runHoldCycle(ending: Ending): ActionCycle {
  let c = openPositionCycle();
  const step = (e: ActionCycleEvent) => {
    const r = transition(c, e);
    if (!r.ok) throw new Error(JSON.stringify(r.rejection));
    c = r.cycle;
  };
  step({ type: 'CONTEXT_BUILT', at: T0 });
  step({ type: 'PROPOSED', at: T0, runId: RUN, proposalId: null, action: 'HOLD', cutoffVersion: 1 });
  switch (ending) {
    case 'CONFIRM':
    case 'REJECT':
      step({ type: 'ADVERSARY_REVIEWED', at: T0, runId: RUN, verdict: ending, cutoffVersion: 1, reasonCodes: [] });
      break;
    case 'DOUBLE_CHALLENGE':
      step({ type: 'ADVERSARY_REVIEWED', at: T0, runId: RUN, verdict: 'CHALLENGE', cutoffVersion: 1, reasonCodes: [] });
      step({ type: 'PROPOSED', at: T0, runId: RUN, proposalId: null, action: 'HOLD', cutoffVersion: 1 });
      step({ type: 'ADVERSARY_REVIEWED', at: T0, runId: RUN, verdict: 'CHALLENGE', cutoffVersion: 1, reasonCodes: [] });
      break;
    default:
      step({ type: ending, at: T0 });
  }
  return c;
}

describe('PROTECTION_ONLY handoff (INV-20)', () => {
  it('every non-cleared ending of a HOLD reassessment puts the position out of REVIEWED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Ending>('REJECT', 'DOUBLE_CHALLENGE', 'ADVERSARY_UNAVAILABLE', 'TIMEOUT', 'BUDGET_EXHAUSTED', 'MALFORMED_OUTPUT', 'EXPIRED'),
        (ending) => {
          const cycle = runHoldCycle(ending);
          expect(cycle.state).not.toBe('CLEARED');
          const r = reviewTransition(initialPositionReview(T0, null), {
            type: 'CYCLE_TERMINATED',
            at: T0,
            cycleId: cycle.id,
            terminal: cycle.state as 'REJECTED' | 'EXPIRED' | 'UNRESOLVED',
            action: cycle.proposedAction,
            unresolvedReason: cycle.unresolvedReason,
          });
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.review.reviewState).not.toBe('REVIEWED');
            expect(['PROTECTION_ONLY', 'BUDGET_PAUSED']).toContain(r.review.reviewState);
            expect(discretionaryActionsAllowed(r.review)).toBe(false);
            if (ending === 'BUDGET_EXHAUSTED') expect(r.review.reviewState).toBe('BUDGET_PAUSED');
          }
        },
      ),
    );
  });

  it('a cleared HOLD is an affirmative reviewed decision', () => {
    const cycle = runHoldCycle('CONFIRM');
    expect(cycle.state).toBe('CLEARED');
    const r = reviewTransition(initialPositionReview(T0, null), {
      type: 'CYCLE_TERMINATED', at: T0, cycleId: cycle.id, terminal: 'CLEARED', action: 'HOLD', unresolvedReason: null,
    });
    expect(r.ok && r.review.reviewState).toBe('REVIEWED');
    expect(r.ok && r.review.lastReviewedCycleId).toBe(cycle.id);
  });
});
