import fc from 'fast-check';
import { addMs, compareInstants, fixedClock, instantToMs, systemClock, toInstant } from './clock.js';
import { Instant } from './primitives.js';

describe('clock', () => {
  it('systemClock produces a valid UTC instant consistent with nowMs', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(Instant.safeParse(now).success).toBe(true);
    expect(instantToMs(now)).toBeGreaterThanOrEqual(before);
    expect(instantToMs(now)).toBeLessThanOrEqual(after);
  });

  it('fixedClock never advances', () => {
    const at = Instant.parse('2026-09-05T00:00:00.000Z');
    const c = fixedClock(at);
    expect(c.now()).toBe(at);
    expect(c.nowMs()).toBe(Date.parse(at));
  });

  it('toInstant/instantToMs round-trip and comparisons agree with epoch order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        (a, b, delta) => {
          const ia = toInstant(a);
          const ib = toInstant(b);
          expect(instantToMs(ia)).toBe(a);
          expect(Math.sign(compareInstants(ia, ib))).toBe(Math.sign(a - b));
          expect(instantToMs(addMs(ia, delta))).toBe(a + delta);
        },
      ),
    );
  });

  it('rejects invalid dates', () => {
    expect(() => toInstant(Number.NaN)).toThrow(RangeError);
  });
});
