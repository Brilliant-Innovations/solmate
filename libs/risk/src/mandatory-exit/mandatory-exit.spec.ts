import fc from 'fast-check';
import type { AdversaryVerdict, PositionReviewState, PositionSafetyState } from '@sol-agent-trader/contracts';
import { classifyMandatoryExit, type DiscretionaryContext, type MandatoryExitTriggers } from './classifier.js';

const triggersArb: fc.Arbitrary<MandatoryExitTriggers> = fc.record({
  hardStopReached: fc.boolean(),
  providerProtectiveFill: fc.boolean(),
  circuitBreakerRequiresReduction: fc.boolean(),
  safetyState: fc.constantFrom<PositionSafetyState>('NORMAL', 'DEGRADED', 'EXIT_RECOMMENDED', 'CRITICAL_EXIT'),
  operatorEmergencyClose: fc.boolean(),
  dbIndependentEmergencyClose: fc.boolean(),
});

const contextArb: fc.Arbitrary<DiscretionaryContext> = fc.record({
  adversaryVerdict: fc.option(fc.constantFrom<AdversaryVerdict>('CONFIRM', 'CHALLENGE', 'REJECT'), { nil: null }),
  adversaryAvailable: fc.boolean(),
  budgetExhausted: fc.boolean(),
  reviewState: fc.constantFrom<PositionReviewState>('REVIEWED', 'PROTECTION_ONLY', 'BUDGET_PAUSED'),
});

describe('mandatory exit classifier (D31; INV-15, INV-21)', () => {
  it('the decision is a pure function of deterministic triggers: adversary and budget context cannot change it', () => {
    fc.assert(
      fc.property(triggersArb, contextArb, contextArb, (triggers, ctxA, ctxB) => {
        const a = classifyMandatoryExit(triggers, ctxA);
        const b = classifyMandatoryExit(triggers, ctxB);
        expect(a).toEqual(b);
        expect(a.adversaryBlocking).toBe(false);
        const anyTrigger =
          triggers.hardStopReached || triggers.providerProtectiveFill || triggers.circuitBreakerRequiresReduction ||
          triggers.safetyState === 'CRITICAL_EXIT' || triggers.operatorEmergencyClose || triggers.dbIndependentEmergencyClose;
        expect(a.mandatory).toBe(anyTrigger);
        expect(a.reasons.length > 0).toBe(anyTrigger);
      }),
      { numRuns: 300 },
    );
  });

  it('a hard stop with an adversary REJECT, an unavailable adversary and an exhausted budget is still mandatory', () => {
    const d = classifyMandatoryExit(
      { hardStopReached: true, providerProtectiveFill: false, circuitBreakerRequiresReduction: false, safetyState: 'NORMAL', operatorEmergencyClose: false, dbIndependentEmergencyClose: false },
      { adversaryVerdict: 'REJECT', adversaryAvailable: false, budgetExhausted: true, reviewState: 'BUDGET_PAUSED' },
    );
    expect(d).toEqual({ mandatory: true, reasons: ['HARD_STOP'], adversaryBlocking: false });
  });
});
