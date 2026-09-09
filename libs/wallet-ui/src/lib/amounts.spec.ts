import { formatBaseUnits, shortAddress, toBaseUnits } from './amounts';

describe('funding review amount helpers (§20.18)', () => {
  it('parses operator text into base units without float error and refuses zero or malformed input', () => {
    expect(toBaseUnits('0.1', 9)).toBe(100_000_000n);
    expect(toBaseUnits('250', 6)).toBe(250_000_000n);
    expect(toBaseUnits('1.2345678', 6)).toBe(1_234_567n);
    expect(toBaseUnits('0', 6)).toBeNull();
    expect(toBaseUnits('', 6)).toBeNull();
    expect(toBaseUnits('1e3', 6)).toBeNull();
    expect(toBaseUnits('-5', 6)).toBeNull();
  });

  it('formats base units for display and never renders a missing balance as zero', () => {
    expect(formatBaseUnits(null, 9)).toBe('unobserved');
    expect(formatBaseUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(formatBaseUnits(250_000_000n, 6, 2)).toBe('250');
    expect(shortAddress('So11111111111111111111111111111111111111112')).toBe('So11…1112');
  });
});
