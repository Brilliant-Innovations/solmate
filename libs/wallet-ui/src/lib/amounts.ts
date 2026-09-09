/** Amount helpers for the funding review (§20.18): operator text to base units, base units to display. Pure. */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1]!;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return v > 0n ? v : null;
}

export function formatBaseUnits(base: bigint | null, decimals: number, digits = 4): string {
  if (base === null) return 'unobserved';
  const n = Number(base) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
