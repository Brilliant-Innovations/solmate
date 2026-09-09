import { addMs, fixtures, type Instant } from '@sol-agent-trader/contracts';
import fc from 'fast-check';
import { ReplayClockError, SimulatedClock, ticks } from './simulated.js';

const T0 = fixtures.T0 as Instant;

describe('simulated replay clock (§18.2)', () => {
  it('only moves forward; equal is fine, backwards is an error', () => {
    const c = new SimulatedClock(T0);
    expect(c.now()).toBe(T0);
    c.advanceTo(addMs(T0, 1_000));
    c.advanceTo(addMs(T0, 1_000));
    expect(c.nowMs()).toBe(Date.parse(T0) + 1_000);
    expect(() => c.advanceTo(T0)).toThrow(ReplayClockError);
    expect(() => c.advanceBy(-1)).toThrow(ReplayClockError);
    c.advanceBy(500);
    expect(c.now()).toBe(addMs(T0, 1_500));
  });

  it('is monotonic under any sequence of non-negative advances (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 50 }), (steps) => {
        const c = new SimulatedClock(T0);
        let last = c.nowMs();
        for (const s of steps) {
          c.advanceBy(s);
          if (c.nowMs() < last) return false;
          last = c.nowMs();
        }
        return c.nowMs() === Date.parse(T0) + steps.reduce((a, b) => a + b, 0);
      }),
    );
  });

  it('ticks cover the window inclusively at the step', () => {
    expect([...ticks(T0, addMs(T0, 120_000), 60_000)]).toEqual([T0, addMs(T0, 60_000), addMs(T0, 120_000)]);
    expect(() => [...ticks(T0, T0, 0)]).toThrow(ReplayClockError);
  });
});
