import type { Amount, Uuid } from '@sol-agent-trader/contracts';

/**
 * Strategy-attributed position lots (blueprint D24, D44, §6.16, §12.2).
 *
 * Quantities are base-unit integers carried as decimal strings; arithmetic uses BigInt. Exits
 * name the lots they reduce; the physical aggregate is the sum of open lots, and a reduction can
 * never take a lot below zero or touch a lot it did not name (same-mint multi-strategy isolation).
 */

export interface LotBalance {
  lotId: Uuid;
  sleeveId: Uuid;
  quantity: Amount;
}

export type LotAllocation = { lotId: Uuid; quantity: Amount };

export type AllocateResult =
  | { ok: true; lots: LotBalance[]; allocations: LotAllocation[] }
  | { ok: false; code: 'UNKNOWN_LOT' | 'INSUFFICIENT_LOT_QUANTITY' | 'ZERO_QUANTITY'; lotId?: Uuid };

const big = (a: Amount): bigint => BigInt(a);
const amt = (b: bigint): Amount => b.toString(10) as Amount;

export function aggregateQuantity(lots: readonly LotBalance[]): Amount {
  return amt(lots.reduce((acc, l) => acc + big(l.quantity), 0n));
}

/** Reduce exactly the named lots by exactly the named quantities. Unnamed lots are untouched. */
export function allocateExit(lots: readonly LotBalance[], requested: readonly LotAllocation[]): AllocateResult {
  const byId = new Map(lots.map((l) => [l.lotId, l] as const));
  const next = new Map(byId);
  for (const r of requested) {
    const q = big(r.quantity);
    if (q <= 0n) return { ok: false, code: 'ZERO_QUANTITY', lotId: r.lotId };
    const lot = next.get(r.lotId);
    if (!lot) return { ok: false, code: 'UNKNOWN_LOT', lotId: r.lotId };
    const remaining = big(lot.quantity) - q;
    if (remaining < 0n) return { ok: false, code: 'INSUFFICIENT_LOT_QUANTITY', lotId: r.lotId };
    next.set(r.lotId, { ...lot, quantity: amt(remaining) });
  }
  return { ok: true, lots: lots.map((l) => next.get(l.lotId) as LotBalance), allocations: [...requested] };
}

/** A provider fill attributed by order id reduces only its own lot (D44). */
export function applyProviderFill(lots: readonly LotBalance[], lotId: Uuid, filledQuantity: Amount): AllocateResult {
  return allocateExit(lots, [{ lotId, quantity: filledQuantity }]);
}
