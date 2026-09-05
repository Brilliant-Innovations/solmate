import fc from 'fast-check';
import { fixtures, type ActionCycle, type Instant, type TradingActionType, type Uuid } from '@sol-agent-trader/contracts';
import { canAuthorize, isTerminal, latestCutoff, newActionCycle, transition, type ActionCycleEvent } from './machine.js';

const T0 = fixtures.T0 as Instant;
const RUN = fixtures.IDS.message as Uuid;
const PROPOSAL = fixtures.IDS.candidate as Uuid;

function fresh(): ActionCycle {
  return newActionCycle({
    id: fixtures.IDS.cycle as Uuid,
    triggerId: fixtures.IDS.trigger as Uuid,
    strategyVersionId: 'S1@1.0.0' as ActionCycle['strategyVersionId'],
    speedTier: 'T2_CONTEXTUAL',
    decisionBudgetMs: 120_000,
    startedAt: T0,
    candidateId: fixtures.IDS.candidate as Uuid,
  });
}

function apply(cycle: ActionCycle, events: ActionCycleEvent[]): ActionCycle {
  let c = cycle;
  for (const e of events) {
    const r = transition(c, e);
    if (!r.ok) throw new Error(`unexpected rejection ${JSON.stringify(r.rejection)} on ${e.type}`);
    c = r.cycle;
  }
  return c;
}

const cutoffOf = (c: ActionCycle) => latestCutoff(c).version;
const propose = (c: ActionCycle, action: TradingActionType = 'ENTER', v = cutoffOf(c)): ActionCycleEvent => ({
  type: 'PROPOSED', at: T0, runId: RUN, proposalId: PROPOSAL, action, cutoffVersion: v,
});
const review = (c: ActionCycle, verdict: 'CONFIRM' | 'CHALLENGE' | 'REJECT', v = cutoffOf(c)): ActionCycleEvent => ({
  type: 'ADVERSARY_REVIEWED', at: T0, runId: RUN, verdict, cutoffVersion: v, reasonCodes: [],
});

describe('action cycle: evidence cutoffs (INV-19)', () => {
  it('a proposal under cutoff v1 cannot be cleared under cutoff v2 without proposer revision', () => {
    let c = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    c = apply(c, [propose(c)]);
    expect(c.state).toBe('PROPOSED');
    c = apply(c, [{ type: 'EVIDENCE_REFRESHED', at: T0 }]);
    expect(cutoffOf(c)).toBe(2);
    expect(c.state).toBe('CONTEXT_BUILT'); // the v1 proposal is invalidated
    // a review against v1 or v2 without a new proposal is rejected either way
    expect(transition(c, review(c, 'CONFIRM', 1)).ok).toBe(false);
    expect(transition(c, review(c, 'CONFIRM', 2)).ok).toBe(false);
    // re-propose at v2, review at v1 is a cutoff mismatch, review at v2 clears
    c = apply(c, [propose(c, 'ENTER', 2)]);
    const stale = transition(c, review(c, 'CONFIRM', 1));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.rejection).toEqual({ code: 'CUTOFF_MISMATCH', expected: 2, got: 1 });
    c = apply(c, [review(c, 'CONFIRM', 2)]);
    expect(c.state).toBe('CLEARED');
    expect(c.clearedCutoffVersion).toBe(2);
    expect(canAuthorize(c)).toBe(true);
  });

  it('a refresh during a requested revision keeps the revision pending but retargets the cutoff', () => {
    let c = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    c = apply(c, [propose(c), review(c, 'CHALLENGE')]);
    expect(c.state).toBe('REVISION_REQUESTED');
    c = apply(c, [{ type: 'EVIDENCE_REFRESHED', at: T0 }]);
    expect(c.state).toBe('REVISION_REQUESTED');
    expect(transition(c, propose(c, 'ENTER', 1)).ok).toBe(false);
    expect(transition(c, propose(c, 'ENTER', 2)).ok).toBe(true);
  });
});

describe('action cycle: revision bound and unresolved outcomes', () => {
  it('allows one revision; a second CHALLENGE exhausts the revision budget', () => {
    let c = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    c = apply(c, [propose(c), review(c, 'CHALLENGE')]);
    expect(c.revisionRound).toBe(1);
    c = apply(c, [propose(c), review(c, 'CHALLENGE')]);
    expect(c.state).toBe('UNRESOLVED');
    expect(c.unresolvedReason).toBe('REVISION_EXHAUSTED');
    expect(canAuthorize(c)).toBe(false);
  });

  it('gates the proposed action by target: candidates may ENTER or IGNORE, positions may HOLD/REDUCE/EXIT/ADJUST_PROTECTION, ADD only when enabled', () => {
    const candidate = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    for (const action of ['HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION', 'ADD'] as TradingActionType[]) {
      const r = transition(candidate, propose(candidate, action));
      expect(r.ok, action).toBe(false);
      if (!r.ok) expect(r.rejection).toEqual({ code: 'ACTION_NOT_ALLOWED', action, target: 'CANDIDATE' });
    }
    expect(transition(candidate, propose(candidate, 'ADD'), { allowAdd: true }).ok).toBe(true);

    const position = apply(
      newActionCycle({ ...fresh(), id: fixtures.IDS.cycle as Uuid, triggerId: fixtures.IDS.trigger as Uuid, strategyVersionId: fresh().strategyVersionId, speedTier: 'T2_CONTEXTUAL', decisionBudgetMs: 1000, startedAt: T0, candidateId: null, positionId: fixtures.IDS.position as Uuid }),
      [{ type: 'CONTEXT_BUILT', at: T0 }],
    );
    for (const action of ['ENTER', 'IGNORE'] as TradingActionType[]) {
      const r = transition(position, propose(position, action));
      expect(r.ok, action).toBe(false);
      if (!r.ok) expect(r.rejection).toEqual({ code: 'ACTION_NOT_ALLOWED', action, target: 'POSITION' });
    }
    // an open position can never be "cleared" without an adversary run: HOLD must go through review
    const held = apply(position, [propose(position, 'HOLD')]);
    expect(held.state).toBe('PROPOSED');
    expect(canAuthorize(held)).toBe(false);
  });

  it.each([
    ['ADVERSARY_UNAVAILABLE', 'ADVERSARY_UNAVAILABLE'],
    ['TIMEOUT', 'TIMEOUT'],
    ['BUDGET_EXHAUSTED', 'BUDGET'],
    ['MALFORMED_OUTPUT', 'MALFORMED_OUTPUT'],
  ] as const)('%s terminates UNRESOLVED with reason %s and never authorizes', (type, reason) => {
    let c = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    c = apply(c, [propose(c)]);
    c = apply(c, [{ type, at: T0 }]);
    expect(c.state).toBe('UNRESOLVED');
    expect(c.unresolvedReason).toBe(reason);
    expect(canAuthorize(c)).toBe(false);
  });

  it('REJECT rejects; IGNORE clears without review but can never authorize', () => {
    let c = apply(fresh(), [{ type: 'CONTEXT_BUILT', at: T0 }]);
    const rejected = apply(c, [propose(c), review(c, 'REJECT')]);
    expect(rejected.state).toBe('REJECTED');
    c = apply(c, [propose(c, 'IGNORE')]);
    expect(c.state).toBe('CLEARED');
    expect(canAuthorize(c)).toBe(false);
  });
});

describe('action cycle: invariants over arbitrary event sequences (INV-14, INV-19)', () => {
  const eventArb = fc.oneof(
    fc.constant<{ kind: 'CONTEXT_BUILT' }>({ kind: 'CONTEXT_BUILT' }),
    fc.record({ kind: fc.constant('PROPOSED' as const), action: fc.constantFrom<TradingActionType>('ENTER', 'HOLD', 'EXIT', 'IGNORE', 'REDUCE'), offset: fc.constantFrom(0, -1, 1) }),
    fc.record({ kind: fc.constant('REVIEWED' as const), verdict: fc.constantFrom('CONFIRM', 'CHALLENGE', 'REJECT'), offset: fc.constantFrom(0, -1, 1) }),
    fc.constant<{ kind: 'REFRESH' }>({ kind: 'REFRESH' }),
    fc.constantFrom<{ kind: 'ADVERSARY_UNAVAILABLE' | 'TIMEOUT' | 'BUDGET_EXHAUSTED' | 'MALFORMED_OUTPUT' | 'EXPIRED' }>(
      { kind: 'ADVERSARY_UNAVAILABLE' }, { kind: 'TIMEOUT' }, { kind: 'BUDGET_EXHAUSTED' }, { kind: 'MALFORMED_OUTPUT' }, { kind: 'EXPIRED' },
    ),
  );

  it('holds: revision ≤ 1, cleared implies latest cutoff, terminal is absorbing, authorization only from CLEARED', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 25 }), (templates) => {
        let c = fresh();
        let sawTerminal = false;
        for (const t of templates) {
          const v = cutoffOf(c);
          const event: ActionCycleEvent =
            t.kind === 'CONTEXT_BUILT' ? { type: 'CONTEXT_BUILT', at: T0 }
            : t.kind === 'PROPOSED' ? propose(c, t.action, v + t.offset)
            : t.kind === 'REVIEWED' ? review(c, t.verdict as 'CONFIRM', v + t.offset)
            : t.kind === 'REFRESH' ? { type: 'EVIDENCE_REFRESHED', at: T0 }
            : { type: t.kind, at: T0 };
          const r = transition(c, event);
          if (sawTerminal) {
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.rejection.code).toBe('TERMINAL_STATE');
            continue;
          }
          if (!r.ok) continue;
          c = r.cycle;
          expect(c.revisionRound).toBeLessThanOrEqual(1);
          if (c.state === 'CLEARED') expect(c.clearedCutoffVersion).toBe(cutoffOf(c));
          if (c.state === 'UNRESOLVED') expect(c.unresolvedReason).not.toBeNull();
          if (canAuthorize(c)) {
            expect(c.state).toBe('CLEARED');
            expect(c.proposedAction).not.toBe('IGNORE');
            expect(c.verdict).toBe('CONFIRM');
          }
          if (isTerminal(c)) sawTerminal = true;
        }
      }),
      { numRuns: 500 },
    );
  });
});
