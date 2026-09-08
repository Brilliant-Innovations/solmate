import { amountToBigInt, instantToMs, verifySignedEnvelope, type Amount, type Instant, type MintAddress, type RiskStateProjection, type Sequence, type Sha256Hex, type SignedRiskStateProjection, type Slot, type Uuid, type VerificationKey, type VersionId } from '@sol-agent-trader/contracts';

/**
 * Signed risk-state projection verification (blueprint D21, D52, §15.5; INV-07). The projection
 * is an input, never authority: its signature must come from a pinned projector key, its
 * sequence must advance, it must be fresh, it must name the Release and policy being authorized,
 * and where chain truth exists the authorizer's own allowlisted reads must agree. A projection
 * may claim less than chain (conservative); it may never claim more.
 */

export interface IndependentChainReads {
  slot: Slot;
  settlementBaseUnits: Amount;
  gasLamports: Amount;
  custody: { custodyAccountId: Uuid; mint: MintAddress; amount: Amount }[];
}

export interface ProjectionVerifyInput {
  envelope: SignedRiskStateProjection;
  acceptedKeys: readonly VerificationKey[];
  /** Highest sequence this authorizer has already accepted; null on first use. */
  lastSequence: Sequence | null;
  now: Instant;
  maxAgeMs: number;
  expected: { releaseId: Uuid; releaseDigest: Sha256Hex; policyVersion: VersionId };
  /** Null only when the authority needs no chain truth (OBSERVE/PAPER); every live entry supplies reads. */
  chain: IndependentChainReads | null;
  tolerance: { balanceBps: number; maxSlotLag: number };
}

export type ProjectionRejection =
  | 'PROJECTION_SIGNATURE_INVALID'
  | 'PROJECTION_SEQUENCE_ROLLBACK'
  | 'PROJECTION_STALE'
  | 'PROJECTION_FUTURE_DATED'
  | 'PROJECTION_RELEASE_MISMATCH'
  | 'PROJECTION_POLICY_MISMATCH'
  | 'CHAIN_SETTLEMENT_DISAGREES'
  | 'CHAIN_GAS_DISAGREES'
  | 'CHAIN_CUSTODY_DISAGREES'
  | 'CHAIN_SLOT_BEHIND';

export type ProjectionVerdict = { ok: true; projection: RiskStateProjection; sequence: Sequence; payloadHash: Sha256Hex } | { ok: false; reasons: ProjectionRejection[]; detail: string[] };

/** True when the projected amount does not exceed the chain amount by more than the tolerance. Claiming less is fine. */
function withinAbove(projected: Amount, chain: Amount, bps: number): boolean {
  const p = amountToBigInt(projected);
  const c = amountToBigInt(chain);
  return p <= c + (c * BigInt(Math.round(bps))) / 10_000n;
}

export async function verifyProjection(input: ProjectionVerifyInput): Promise<ProjectionVerdict> {
  const reasons: ProjectionRejection[] = [];
  const detail: string[] = [];
  const sig = await verifySignedEnvelope(input.envelope, input.acceptedKeys);
  if (!sig.ok) {
    reasons.push('PROJECTION_SIGNATURE_INVALID');
    detail.push(sig.reason);
    return { ok: false, reasons, detail };
  }
  const p = input.envelope.payload;
  if (input.lastSequence !== null && p.sequence <= input.lastSequence) {
    reasons.push('PROJECTION_SEQUENCE_ROLLBACK');
    detail.push(`sequence ${p.sequence} <= ${input.lastSequence}`);
  }
  const age = instantToMs(input.now) - instantToMs(p.asOf);
  if (age > input.maxAgeMs) {
    reasons.push('PROJECTION_STALE');
    detail.push(`age ${age}ms > ${input.maxAgeMs}ms`);
  }
  if (age < -input.tolerance.maxSlotLag * 400) {
    reasons.push('PROJECTION_FUTURE_DATED');
    detail.push(`asOf ${p.asOf} is ahead of now ${input.now}`);
  }
  if (p.releaseId !== input.expected.releaseId || p.releaseDigest !== input.expected.releaseDigest) reasons.push('PROJECTION_RELEASE_MISMATCH');
  if (p.policyVersion !== input.expected.policyVersion) reasons.push('PROJECTION_POLICY_MISMATCH');

  if (input.chain) {
    const c = input.chain;
    if (!withinAbove(p.settlementAvailableBaseUnits, c.settlementBaseUnits, input.tolerance.balanceBps)) {
      reasons.push('CHAIN_SETTLEMENT_DISAGREES');
      detail.push(`projected settlement ${p.settlementAvailableBaseUnits} > chain ${c.settlementBaseUnits}`);
    }
    if (!withinAbove(p.gasReserveLamports, c.gasLamports, input.tolerance.balanceBps)) {
      reasons.push('CHAIN_GAS_DISAGREES');
      detail.push(`projected gas ${p.gasReserveLamports} > chain ${c.gasLamports}`);
    }
    const chainCustody = new Map(c.custody.map((x) => [`${x.custodyAccountId}|${x.mint}`, x.amount]));
    for (const x of p.custody) {
      const onChain = chainCustody.get(`${x.custodyAccountId}|${x.mint}`);
      if (onChain === undefined || !withinAbove(x.amount, onChain, input.tolerance.balanceBps)) {
        reasons.push('CHAIN_CUSTODY_DISAGREES');
        detail.push(`custody ${x.custodyAccountId} ${x.mint}: projected ${x.amount}, chain ${onChain ?? 'absent'}`);
        break;
      }
    }
    if (c.slot - p.chainSlot > input.tolerance.maxSlotLag) {
      reasons.push('CHAIN_SLOT_BEHIND');
      detail.push(`projection slot ${p.chainSlot} lags chain ${c.slot} by more than ${input.tolerance.maxSlotLag}`);
    }
  }
  return reasons.length ? { ok: false, reasons, detail } : { ok: true, projection: p, sequence: p.sequence, payloadHash: input.envelope.payloadHash };
}
