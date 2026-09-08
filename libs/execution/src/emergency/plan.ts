import { addMs, instantToMs, type Amount, type Bps, type Instant, type MintAddress, type PositionRiskShadow, type Uuid } from '@sol-agent-trader/contracts';
import type { Holding } from '../chain/custody.js';
import type { ExecutionBounds } from '../validate/bounds.js';

/**
 * D22 emergency close planning (§15.10, §15.10A). Pure: chain custody in, bounded sell actions
 * out. The plan can only convert a held non-settlement asset into a deployment settlement mint,
 * for at most the chain-confirmed amount, under the deployment's protective slippage ceiling.
 * There is no path here to a buy, an exposure increase or a transfer.
 */

export interface EmergencyCloseRequest {
  type: 'EMERGENCY_CLOSE_ASSET' | 'EMERGENCY_CLOSE_ALL';
  mint: MintAddress | null;
  maxAmount: Amount | null;
}

export interface EmergencyClosePolicy {
  /** Ordered preference; the first is the sell target. */
  settlementMints: readonly MintAddress[];
  slippageBps: Bps;
  hardMaxProtectiveSlippageBps: Bps;
  maxPriceImpactBps: Bps;
  maxQuoteAgeMs: number;
  validityMs: number;
  /** Deployment cap on one emergency transaction's input amount; null = chain amount only. */
  maxTxBaseUnits: bigint | null;
}

export interface EmergencyCloseAction {
  mint: MintAddress;
  tokenAccount: string;
  amount: Amount;
  heldAmount: Amount;
  outputMint: MintAddress;
  bounds: ExecutionBounds;
}

export type EmergencyPlanRejection = 'ASSET_NOT_HELD' | 'ASSET_IS_SETTLEMENT' | 'ASSET_FROZEN' | 'NO_SETTLEMENT_MINT' | 'SLIPPAGE_ABOVE_HARD_MAX' | 'NOTHING_TO_CLOSE';

export type EmergencyPlan =
  | { ok: true; actions: EmergencyCloseAction[]; skipped: { mint: MintAddress; reason: EmergencyPlanRejection }[] }
  | { ok: false; reasons: EmergencyPlanRejection[] };

export function planEmergencyClose(request: EmergencyCloseRequest, holdings: readonly Holding[], policy: EmergencyClosePolicy, now: Instant): EmergencyPlan {
  const settlement = policy.settlementMints[0];
  if (!settlement) return { ok: false, reasons: ['NO_SETTLEMENT_MINT'] };
  if (policy.slippageBps > policy.hardMaxProtectiveSlippageBps) return { ok: false, reasons: ['SLIPPAGE_ABOVE_HARD_MAX'] };
  const isSettlement = (m: MintAddress) => policy.settlementMints.includes(m);
  const actions: EmergencyCloseAction[] = [];
  const skipped: { mint: MintAddress; reason: EmergencyPlanRejection }[] = [];
  const expiresAt = addMs(now, policy.validityMs);
  const consider = (h: Holding): EmergencyPlanRejection | null => {
    if (isSettlement(h.mint)) return 'ASSET_IS_SETTLEMENT';
    if (h.frozen) return 'ASSET_FROZEN';
    if (h.amount <= 0n) return 'ASSET_NOT_HELD';
    let amount = h.amount;
    if (request.maxAmount !== null && BigInt(request.maxAmount) < amount) amount = BigInt(request.maxAmount);
    if (policy.maxTxBaseUnits !== null && policy.maxTxBaseUnits < amount) amount = policy.maxTxBaseUnits;
    if (amount <= 0n) return 'NOTHING_TO_CLOSE';
    actions.push({
      mint: h.mint,
      tokenAccount: h.tokenAccount,
      amount: amount.toString() as Amount,
      heldAmount: h.amount.toString() as Amount,
      outputMint: settlement,
      bounds: { inputMint: h.mint, outputMint: settlement, maxInputAmount: amount.toString() as Amount, maxSlippageBps: policy.slippageBps, maxPriceImpactBps: policy.maxPriceImpactBps, chaseToleranceBps: null, maxQuoteAgeMs: policy.maxQuoteAgeMs, expiresAt, exposureEffect: 'REDUCE' },
    });
    return null;
  };
  if (request.type === 'EMERGENCY_CLOSE_ASSET') {
    if (!request.mint) return { ok: false, reasons: ['ASSET_NOT_HELD'] };
    if (isSettlement(request.mint)) return { ok: false, reasons: ['ASSET_IS_SETTLEMENT'] };
    const held = holdings.filter((h) => h.mint === request.mint && h.amount > 0n);
    if (held.length === 0) return { ok: false, reasons: ['ASSET_NOT_HELD'] };
    for (const h of held) {
      const r = consider(h);
      if (r) skipped.push({ mint: h.mint, reason: r });
    }
    return actions.length ? { ok: true, actions, skipped } : { ok: false, reasons: [skipped[0]?.reason ?? 'NOTHING_TO_CLOSE'] };
  }
  for (const h of holdings) {
    if (isSettlement(h.mint) || h.amount <= 0n) continue;
    const r = consider(h);
    if (r) skipped.push({ mint: h.mint, reason: r });
  }
  return { ok: true, actions, skipped };
}

// --- §15.10A shadow stops ----------------------------------------------------------------------

export type ShadowStopReason = 'HARD_STOP' | 'TRAIL_STOP' | 'TIME_STOP' | 'UNREVIEWED_STOP';

export interface ShadowStopHit {
  positionId: Uuid;
  mint: MintAddress;
  lastConfirmedQuantity: Amount;
  reason: ShadowStopReason;
}

/**
 * Deterministic stop evaluation over the durable shadow during a database outage. Price-based
 * stops need a fresh mark; a position with no mark is not a hit (nothing sells on missing data)
 * and is reported as unmarked so the operator sees it. Quantity here is never authority: the
 * planner caps every sale at chain custody.
 */
export function evaluateShadowStops(shadow: PositionRiskShadow, marks: ReadonlyMap<MintAddress, number>, now: Instant): { hits: ShadowStopHit[]; unmarked: MintAddress[] } {
  const hits: ShadowStopHit[] = [];
  const unmarked: MintAddress[] = [];
  const nowMs = instantToMs(now);
  for (const p of shadow.positions) {
    const price = marks.get(p.mint);
    let reason: ShadowStopReason | null = null;
    if (p.timeStopAt !== null && nowMs >= instantToMs(p.timeStopAt)) reason = 'TIME_STOP';
    if (price === undefined) {
      if (!reason) unmarked.push(p.mint);
    } else {
      if (p.stop && p.stop.level !== null && price <= p.stop.level) reason = 'HARD_STOP';
      else if (p.trailingLevel !== null && price <= p.trailingLevel) reason = 'TRAIL_STOP';
      else if (p.unreviewedStop !== null && price <= p.unreviewedStop) reason = 'UNREVIEWED_STOP';
    }
    if (reason) hits.push({ positionId: p.positionId, mint: p.mint, lastConfirmedQuantity: p.lastConfirmedQuantity, reason });
  }
  return { hits, unmarked };
}
