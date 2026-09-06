import fc from 'fast-check';
import { QueueName } from '@sol-agent-trader/contracts';
import { DEFAULT_DRAIN_CONFIG, initialDrainState, planDrainCycle, type DrainState } from './scheduler.js';

describe('drain scheduler (§5.4)', () => {
  it('polls every queue in risk-first order when nothing is backlogged', () => {
    const { plan } = planDrainCycle(initialDrainState(), new Set());
    expect(plan.queues.map((q) => q.queue)).toEqual(['trade-critical', 'reconciliation', 'trading-actions', 'research']);
  });

  it('skips lower queues while a higher queue has backlog, until the starvation bound', () => {
    let state: DrainState = initialDrainState();
    const backlog = new Set<QueueName>(['trade-critical']);
    for (let i = 1; i < DEFAULT_DRAIN_CONFIG.starvationBound; i++) {
      const r = planDrainCycle(state, backlog);
      state = r.state;
      expect(r.plan.queues.map((q) => q.queue)).toEqual(['trade-critical']);
    }
    const r = planDrainCycle(state, backlog);
    expect(r.plan.queues.map((q) => q.queue)).toEqual(['trade-critical', 'reconciliation', 'trading-actions', 'research']);
  });

  it('never starves any queue for more than the bound, and always polls trade-critical first', () => {
    const backlogArb = fc.array(fc.constantFrom(...QueueName.options), { maxLength: 4 }).map((qs) => new Set<QueueName>(qs));
    fc.assert(
      fc.property(fc.array(backlogArb, { minLength: 1, maxLength: 60 }), (backlogs) => {
        let state = initialDrainState();
        for (const backlog of backlogs) {
          const r = planDrainCycle(state, backlog);
          expect(r.plan.queues[0]?.queue).toBe('trade-critical');
          state = r.state;
          for (const q of QueueName.options) {
            expect(state.cycle - state.lastPolled[q]).toBeLessThan(DEFAULT_DRAIN_CONFIG.starvationBound);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
