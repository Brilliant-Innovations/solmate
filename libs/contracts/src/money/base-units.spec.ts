import fc from 'fast-check';
import type { Amount } from '../primitives.js';
import { addAmounts, allocate, applyBps, ArithmeticError, baseUnitsForUsd, compareAmounts, fromDecimal, mulDiv, signedDelta, subAmounts, toDecimalString, usdValue } from './base-units.js';

const small = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((v) => v.toString() as Amount);

describe('canonical base-unit arithmetic (ADR-0009 P6)', () => {
  it('decimal ↔ base units round-trips exactly, never through floating point', () => {
    expect(fromDecimal('1.5', 6)).toBe('1500000');
    expect(fromDecimal('0.1', 6)).toBe('100000');
    expect(fromDecimal('0.30000000000000004', 6)).toBe('300000');
    expect(fromDecimal(0.1 + 0.2, 6)).toBe('300000');
    expect(fromDecimal('1.2345678', 6)).toBe('1234567');
    expect(fromDecimal('1.2345678', 6, 'CEIL')).toBe('1234568');
    expect(fromDecimal('1.2345675', 6, 'HALF_UP')).toBe('1234568');
    expect(fromDecimal('1.2345674', 6, 'HALF_UP')).toBe('1234567');
    expect(toDecimalString('1500000' as Amount, 6)).toBe('1.500000');
    expect(toDecimalString('5' as Amount, 9)).toBe('0.000000005');
    expect(toDecimalString('42' as Amount, 0)).toBe('42');
    fc.assert(
      fc.property(small, fc.integer({ min: 0, max: 18 }), (a, d) => {
        expect(fromDecimal(toDecimalString(a, d), d)).toBe(a);
      }),
    );
    for (const bad of ['-1', '1e5', 'abc', '', '1.'] as const) expect(() => fromDecimal(bad, 6)).toThrow(ArithmeticError);
  });

  it('rounding is explicit: FLOOR ≤ exact ≤ CEIL, and fees round against us while sizes never oversize', () => {
    fc.assert(
      fc.property(small, fc.integer({ min: 0, max: 10_000 }), (a, bps) => {
        const floor = BigInt(applyBps(a, bps, 'FLOOR'));
        const ceil = BigInt(applyBps(a, bps, 'CEIL'));
        const half = BigInt(applyBps(a, bps, 'HALF_UP'));
        const exact = (BigInt(a) * BigInt(bps)) / 10_000n;
        expect(floor).toBe(exact);
        expect(ceil - floor <= 1n).toBe(true);
        expect(half >= floor && half <= ceil).toBe(true);
      }),
    );
    expect(mulDiv('100' as Amount, 1n, 3n, 'FLOOR')).toBe('33');
    expect(mulDiv('100' as Amount, 1n, 3n, 'CEIL')).toBe('34');
    expect(mulDiv('100' as Amount, 1n, 3n, 'HALF_UP')).toBe('33');
    expect(mulDiv('100' as Amount, 1n, 2n, 'HALF_UP')).toBe('50');
    expect(mulDiv('101' as Amount, 1n, 2n, 'HALF_UP')).toBe('51');
    expect(() => mulDiv('1' as Amount, 1n, 0n, 'FLOOR')).toThrow(ArithmeticError);
  });

  it('conservation: allocation parts always sum to the total; balances never go negative silently; u64 is a hard ceiling', () => {
    fc.assert(
      fc.property(small, fc.array(fc.bigInt({ min: 1n, max: 1000n }), { minLength: 1, maxLength: 8 }), (total, weights) => {
        const parts = allocate(total, weights);
        expect(parts.length).toBe(weights.length);
        expect(addAmounts(...parts)).toBe(total);
      }),
    );
    expect(() => subAmounts('1' as Amount, '2' as Amount)).toThrow(/negative/);
    expect(signedDelta('1' as Amount, '2' as Amount)).toBe('-1');
    expect(() => addAmounts('18446744073709551615' as Amount, '1' as Amount)).toThrow(/u64/);
    expect(compareAmounts('9' as Amount, '10' as Amount)).toBe(-1);
  });

  it('USD sizing floors and refuses prices that cannot size a probe', () => {
    expect(baseUnitsForUsd(100, 2, 6)).toBe('50000000');
    expect(baseUnitsForUsd(100, 3, 6)).toBe('33333333');
    expect(baseUnitsForUsd(100, 0, 6)).toBeNull();
    expect(baseUnitsForUsd(100, Number.NaN, 6)).toBeNull();
    expect(baseUnitsForUsd(100, 1e-30, 6)).toBeNull();
    expect(usdValue('1500000' as Amount, 6, 2)).toBe(3);
  });
});
