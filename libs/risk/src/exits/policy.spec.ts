import fc from 'fast-check';
import { addMs, DEFAULT_RISK_POLICY, toInstant } from '@sol-agent-trader/contracts';
import { evaluateExitPolicy, stopLevel } from './policy.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const OPENED = addMs(NOW, -60_000);

describe('stops and exit policies (§13.4, §13.5, D39)', () => {
  it('stop models compute a level that is never wider than the percentage cap and never at or above entry', () => {
    const atr = stopLevel({ model: 'ATR', atrMultiple: 2, maxStopFraction: 0.08 }, { entryPrice: 100, atrPct: 0.02, structureLowPrice: null });
    expect(atr).toEqual({ level: 96, distanceFraction: 0.04 });
    const capped = stopLevel({ model: 'ATR', atrMultiple: 2, maxStopFraction: 0.08 }, { entryPrice: 100, atrPct: 0.1, structureLowPrice: null });
    expect(capped?.level).toBeCloseTo(92);
    expect(stopLevel({ model: 'STRUCTURE_LOW', atrMultiple: 2, maxStopFraction: 0.08 }, { entryPrice: 100, atrPct: null, structureLowPrice: 97 })?.level).toBe(97);
    expect(stopLevel({ model: 'STRUCTURE_LOW', atrMultiple: 2, maxStopFraction: 0.08 }, { entryPrice: 100, atrPct: null, structureLowPrice: 101 })).toBeNull();
    expect(stopLevel({ model: 'PERCENTAGE', atrMultiple: 2, maxStopFraction: 0.05 }, { entryPrice: 100, atrPct: null, structureLowPrice: null })?.level).toBe(95);
    expect(stopLevel({ model: 'ATR', atrMultiple: 2, maxStopFraction: 0.08 }, { entryPrice: 100, atrPct: null, structureLowPrice: null })).toBeNull();
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1000, noNaN: true }), fc.double({ min: 0.0001, max: 0.5, noNaN: true }), fc.double({ min: 0.01, max: 0.5, noNaN: true }), (e, atr, cap) => {
        const s = stopLevel({ model: 'ATR', atrMultiple: 2, maxStopFraction: cap }, { entryPrice: e, atrPct: atr, structureLowPrice: null });
        expect(s).not.toBeNull();
        expect(s!.level).toBeLessThan(e);
        expect(s!.distanceFraction).toBeLessThanOrEqual(cap + 1e-9);
      }),
    );
  });

  it('a hard stop breach exits whatever the policy; the time stop exits; fixed-R and partial tiers act at their multiples', () => {
    const base = { entryPrice: 100, currentPrice: 95, highSinceEntry: 100, currentStop: 96, initialStopDistanceFraction: 0.04, openedAt: OPENED, now: NOW };
    expect(evaluateExitPolicy(DEFAULT_RISK_POLICY.takeProfit, base)).toMatchObject({ action: 'EXIT', reasons: ['HARD_STOP'] });
    expect(evaluateExitPolicy(DEFAULT_RISK_POLICY.takeProfit, { ...base, currentPrice: 101, now: addMs(OPENED, DEFAULT_RISK_POLICY.takeProfit.maxHoldMs) })).toMatchObject({ action: 'EXIT', reasons: ['TIME_STOP'] });
    const fixed = { ...DEFAULT_RISK_POLICY.takeProfit, policy: 'FIXED_R' as const, targetRMultiple: 2 };
    expect(evaluateExitPolicy(fixed, { ...base, currentPrice: 108, highSinceEntry: 108 })).toMatchObject({ action: 'EXIT', reasons: ['TARGET_REACHED'] });
    expect(evaluateExitPolicy(fixed, { ...base, currentPrice: 103, highSinceEntry: 103 })).toMatchObject({ action: 'HOLD' });
    const tiers = { ...fixed, policy: 'PARTIAL_TIERS' as const };
    expect(evaluateExitPolicy(tiers, { ...base, currentPrice: 104.5, highSinceEntry: 104.5 })).toMatchObject({ action: 'REDUCE', fraction: 0.5 });
  });

  it('trailing after the threshold only ever tightens the stop and exits when price falls to the trail (D39)', () => {
    const tp = DEFAULT_RISK_POLICY.takeProfit; // trail after 1R, trail 4 %
    const base = { entryPrice: 100, currentPrice: 105, highSinceEntry: 105, currentStop: 96, initialStopDistanceFraction: 0.04, openedAt: OPENED, now: NOW };
    const tightened = evaluateExitPolicy(tp, base);
    expect(tightened).toMatchObject({ action: 'TIGHTEN_STOP', reasons: ['TRAIL_TIGHTENED'] });
    expect(tightened.stop).toBeCloseTo(100.8);
    // A lower high later cannot loosen the stop.
    const later = evaluateExitPolicy(tp, { ...base, currentStop: tightened.stop, currentPrice: 102, highSinceEntry: 105 });
    expect(later.stop).toBeGreaterThanOrEqual(tightened.stop);
    // Price at a new high then falling to the trail in the same cycle: trail tightens and exits together.
    expect(evaluateExitPolicy(tp, { ...base, currentStop: 96, currentPrice: 103, highSinceEntry: 110 })).toMatchObject({ action: 'EXIT', reasons: ['TRAIL_TIGHTENED', 'TRAIL_STOP'] });
    // A stop already tightened by an earlier cycle is a hard stop on the next one.
    expect(evaluateExitPolicy(tp, { ...base, currentStop: tightened.stop, currentPrice: 100.5, highSinceEntry: 105 })).toMatchObject({ action: 'EXIT', reasons: ['HARD_STOP'] });
    fc.assert(
      fc.property(fc.double({ min: 90, max: 130, noNaN: true }), fc.double({ min: 90, max: 130, noNaN: true }), fc.double({ min: 90, max: 99.9, noNaN: true }), (p, h, stop) => {
        const d = evaluateExitPolicy(tp, { ...base, currentPrice: p, highSinceEntry: Math.max(h, p), currentStop: stop });
        expect(d.stop).toBeGreaterThanOrEqual(stop);
      }),
    );
  });
});
