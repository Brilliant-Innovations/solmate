import type { Amount, MintAddress, SolanaAddress, TransactionClass, Uuid } from '@sol-agent-trader/contracts';

/**
 * Custody registry and movement classification (blueprint D9, §6.17, §16.2).
 *
 * A balance movement is EXPECTED only when both endpoints are registered custody accounts, the
 * movement type is allowed for those accounts, and it is tied to an authorized execution or
 * protective-order lifecycle. Everything else is UNKNOWN and triggers a trading pause.
 */

export interface RegisteredCustody {
  id: Uuid;
  address: SolanaAddress;
  /** Set for token accounts and vaults bound to one mint; null for the wallet itself. */
  mint: MintAddress | null;
  allowedMovementTypes: readonly TransactionClass[];
  active: boolean;
}

export interface ObservedMovement {
  from: SolanaAddress;
  to: SolanaAddress;
  mint: MintAddress;
  amount: Amount;
  /** The lifecycle (intent, protective order, emergency command) the movement is attributed to, if any. */
  lifecycleId: Uuid | null;
  movementType: TransactionClass | null;
}

export type MovementClassification =
  | { kind: 'EXPECTED'; fromId: Uuid; toId: Uuid; lifecycleId: Uuid }
  | { kind: 'UNKNOWN'; reason: 'UNREGISTERED_ENDPOINT' | 'INACTIVE_ACCOUNT' | 'MINT_MISMATCH' | 'NO_LIFECYCLE' | 'MOVEMENT_TYPE_NOT_ALLOWED' | 'UNTYPED_MOVEMENT' };

export function classifyMovement(registry: readonly RegisteredCustody[], m: ObservedMovement, authorizedLifecycles: ReadonlySet<Uuid>): MovementClassification {
  const from = registry.find((c) => c.address === m.from);
  const to = registry.find((c) => c.address === m.to);
  if (!from || !to) return { kind: 'UNKNOWN', reason: 'UNREGISTERED_ENDPOINT' };
  if (!from.active || !to.active) return { kind: 'UNKNOWN', reason: 'INACTIVE_ACCOUNT' };
  if ((from.mint !== null && from.mint !== m.mint) || (to.mint !== null && to.mint !== m.mint)) return { kind: 'UNKNOWN', reason: 'MINT_MISMATCH' };
  if (m.movementType === null) return { kind: 'UNKNOWN', reason: 'UNTYPED_MOVEMENT' };
  if (!from.allowedMovementTypes.includes(m.movementType) || !to.allowedMovementTypes.includes(m.movementType)) {
    return { kind: 'UNKNOWN', reason: 'MOVEMENT_TYPE_NOT_ALLOWED' };
  }
  if (m.lifecycleId === null || !authorizedLifecycles.has(m.lifecycleId)) return { kind: 'UNKNOWN', reason: 'NO_LIFECYCLE' };
  return { kind: 'EXPECTED', fromId: from.id, toId: to.id, lifecycleId: m.lifecycleId };
}
