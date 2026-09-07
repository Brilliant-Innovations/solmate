import type { Amount, Bps } from '../primitives.js';
import type { SignedAmount } from '../entities/common.js';

/**
 * Canonical financial arithmetic (ADR-0009 P6; blueprint §13.3, §17.4). Every quantity of money
 * or tokens is a base-unit `bigint`; decimals are a presentation concern. Each operation names its
 * rounding rule, so paper accounting, live accounting and reconciliation can never disagree by a
 * rounding choice. Nothing here touches floating point except at the explicit boundary
 * `fromDecimal`/`toDecimalString`, and that boundary is string-based, not `Number`-based.
 */

export type Rounding = 'FLOOR' | 'CEIL' | 'HALF_UP';

const U64_MAX = 18446744073709551615n;

export class ArithmeticError extends Error {
  constructor(
    readonly code: 'NEGATIVE_RESULT' | 'EXCEEDS_U64' | 'MALFORMED_DECIMAL' | 'DIVISION_BY_ZERO' | 'DECIMALS_OUT_OF_RANGE',
    message: string,
  ) {
    super(message);
    this.name = 'ArithmeticError';
  }
}

export function amountToBigInt(a: Amount): bigint {
  return BigInt(a);
}

export function bigIntToAmount(v: bigint): Amount {
  if (v < 0n) throw new ArithmeticError('NEGATIVE_RESULT', `amount cannot be negative: ${v}`);
  if (v > U64_MAX) throw new ArithmeticError('EXCEEDS_U64', `amount exceeds u64: ${v}`);
  return v.toString() as Amount;
}

export function bigIntToSigned(v: bigint): SignedAmount {
  return v.toString() as SignedAmount;
}

function divide(num: bigint, den: bigint, rounding: Rounding): bigint {
  if (den === 0n) throw new ArithmeticError('DIVISION_BY_ZERO', 'division by zero');
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  let q = n / d;
  const r = n % d;
  if (r !== 0n) {
    if (rounding === 'CEIL') q += 1n;
    else if (rounding === 'HALF_UP' && r * 2n >= d) q += 1n;
  }
  return negative ? -q : q;
}

/** `amount × num / den` with the named rounding; the workhorse for sizing, fees and pro-rata splits. */
export function mulDiv(amount: Amount, num: bigint, den: bigint, rounding: Rounding): Amount {
  return bigIntToAmount(divide(amountToBigInt(amount) * num, den, rounding));
}

/** Basis-point application. Fees and haircuts round CEIL (against us); sizes round FLOOR (never oversize). */
export function applyBps(amount: Amount, bps: Bps | number, rounding: Rounding): Amount {
  return mulDiv(amount, BigInt(Math.round(bps)), 10_000n, rounding);
}

export function addAmounts(...amounts: readonly Amount[]): Amount {
  return bigIntToAmount(amounts.reduce((s, a) => s + amountToBigInt(a), 0n));
}

/** Throws rather than going negative: a balance that would go below zero is an accounting error, not a number. */
export function subAmounts(a: Amount, b: Amount): Amount {
  return bigIntToAmount(amountToBigInt(a) - amountToBigInt(b));
}

export function signedDelta(after: Amount, before: Amount): SignedAmount {
  return bigIntToSigned(amountToBigInt(after) - amountToBigInt(before));
}

export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const x = amountToBigInt(a);
  const y = amountToBigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function minAmount(a: Amount, b: Amount): Amount {
  return compareAmounts(a, b) <= 0 ? a : b;
}

/**
 * Decimal string (or a finite number rendered without exponent) → base units. String arithmetic
 * only: "1.5" with 6 decimals is exactly 1500000, never 1499999.9999. Excess fraction digits are
 * rounded per `rounding`.
 */
export function fromDecimal(value: string | number, decimals: number, rounding: Rounding = 'FLOOR'): Amount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new ArithmeticError('DECIMALS_OUT_OF_RANGE', `decimals ${decimals}`);
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new ArithmeticError('MALFORMED_DECIMAL', `not a finite non-negative number: ${value}`);
    text = value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  } else text = value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new ArithmeticError('MALFORMED_DECIMAL', `not a non-negative decimal: ${JSON.stringify(value)}`);
  const int = m[1] ?? '0';
  const frac = m[2] ?? '';
  const kept = frac.slice(0, decimals).padEnd(decimals, '0');
  const dropped = frac.slice(decimals);
  let units = BigInt(int + kept);
  if (dropped.length > 0 && /[1-9]/.test(dropped)) {
    if (rounding === 'CEIL') units += 1n;
    else if (rounding === 'HALF_UP' && Number(dropped[0]) >= 5) units += 1n;
  }
  return bigIntToAmount(units);
}

/** Base units → decimal string with exactly `decimals` fraction digits (no exponent, no float). */
export function toDecimalString(amount: Amount, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new ArithmeticError('DECIMALS_OUT_OF_RANGE', `decimals ${decimals}`);
  const s = amountToBigInt(amount).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return s;
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** USD value of `amount` at `priceUsd` per whole token; float only at this reporting boundary. */
export function usdValue(amount: Amount, decimals: number, priceUsd: number): number {
  return Number(toDecimalString(amount, decimals)) * priceUsd;
}

/** Whole-token count for a USD size at a price, floored to base units; null when the price cannot size it. */
export function baseUnitsForUsd(sizeUsd: number, priceUsd: number, decimals: number): Amount | null {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd) || !(sizeUsd >= 0) || !Number.isFinite(sizeUsd)) return null;
  const tokens = sizeUsd / priceUsd;
  if (!Number.isFinite(tokens) || tokens * 10 ** decimals > Number.MAX_SAFE_INTEGER) return null;
  return fromDecimal(tokens.toFixed(Math.min(18, decimals + 6)), decimals, 'FLOOR');
}

/**
 * Splits `total` across weights pro rata with FLOOR, assigning the remainder to the largest weight
 * so the parts always sum exactly to the total (lot allocation, partial fills).
 */
export function allocate(total: Amount, weights: readonly bigint[]): Amount[] {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum <= 0n) throw new ArithmeticError('DIVISION_BY_ZERO', 'weights sum to zero');
  const t = amountToBigInt(total);
  const parts = weights.map((w) => (t * w) / sum);
  const remainder = t - parts.reduce((s, p) => s + p, 0n);
  let largest = 0;
  weights.forEach((w, i) => {
    if (w > (weights[largest] ?? 0n)) largest = i;
  });
  parts[largest] = (parts[largest] ?? 0n) + remainder;
  return parts.map(bigIntToAmount);
}
