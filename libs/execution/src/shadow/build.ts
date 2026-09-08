import { canonicalHash, type Amount, type Instant, type MintAddress, type PositionRiskShadow, type ProtectionMode, type Sequence, type Sha256Hex, type StopModel, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Durable position risk shadow (blueprint §6.16C, §15.10A, D22). The shadow is the minimum state
 * needed to keep deterministic protection alive while Postgres is unavailable: lot references,
 * quantities, protection mode and the deterministic stop levels. It is never authority for
 * quantity (chain custody caps every emergency sell) and can only ever authorize risk reduction.
 */

export interface ShadowSourcePosition {
  positionId: Uuid;
  assetId: Uuid;
  mint: MintAddress;
  quantity: Amount;
  stop: { model: StopModel; level: number | null } | null;
  unreviewedStop: number | null;
  trailingLevel?: number | null;
  timeStopAt?: Instant | null;
  lots: { lotId: Uuid; quantity: Amount; protectionMode: ProtectionMode; providerOrderId: string | null }[];
}

export function buildPositionRiskShadow(input: { sequence: Sequence; asOf: Instant; settlementMints: readonly MintAddress[]; positions: readonly ShadowSourcePosition[] }): PositionRiskShadow {
  return {
    sequence: input.sequence,
    asOf: input.asOf,
    settlementMints: [...input.settlementMints],
    positions: [...input.positions]
      .sort((a, b) => (a.positionId < b.positionId ? -1 : 1))
      .map((p) => ({
        positionId: p.positionId,
        assetId: p.assetId,
        mint: p.mint,
        lastConfirmedQuantity: p.quantity,
        lots: [...p.lots].sort((a, b) => (a.lotId < b.lotId ? -1 : 1)).map((l) => ({ lotId: l.lotId, quantity: l.quantity, protectionMode: l.protectionMode, providerOrderId: l.providerOrderId })),
        stop: p.stop ? { model: p.stop.model, level: p.stop.level } : null,
        trailingLevel: p.trailingLevel ?? null,
        timeStopAt: p.timeStopAt ?? null,
        unreviewedStop: p.unreviewedStop,
        primaryRouteSnapshotId: null,
        emergencyRouteSnapshotId: null,
      })),
  };
}

/** Content identity of a shadow without its sequence and timestamp: the same book yields the same fingerprint. */
export async function shadowFingerprint(shadow: PositionRiskShadow): Promise<Sha256Hex> {
  return canonicalHash({ settlementMints: shadow.settlementMints, positions: shadow.positions });
}
