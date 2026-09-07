import fc from 'fast-check';
import { Amount } from './primitives.js';
describe('Amount is a boundary validator (review R4-10)', () => {
  it('safeParse never throws, whatever string arrives', () => {
    fc.assert(
      fc.property(fc.string(), (v) => {
        const r = Amount.safeParse(v);
        expect(typeof r.success).toBe('boolean');
        if (r.success) expect(/^(0|[1-9][0-9]*)$/.test(v)).toBe(true);
      }),
    );
    for (const v of ['5e+24', 'abc', '1.5', '-1', '', '18446744073709551616']) expect(Amount.safeParse(v).success).toBe(false);
    expect(Amount.safeParse('18446744073709551615').success).toBe(true);
  });
});
