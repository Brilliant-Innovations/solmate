import { z } from 'zod';
import { Amount, Instant, MintAddress, Sha256Hex, Slot, SolanaAddress, TxSignature, Uuid } from '../primitives.js';

// Tracked-wallet events (blueprint §3.2, §6.7, §9.3, D8, D26) -----------------------------------

export const WalletEventKind = z.enum(['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'SOL_IN', 'SOL_OUT']);
export type WalletEventKind = z.infer<typeof WalletEventKind>;

export const WalletEventSource = z.enum(['HELIUS_POLL', 'HELIUS_WEBHOOK']);
export type WalletEventSource = z.infer<typeof WalletEventSource>;

/**
 * One thing a tracked wallet did on chain, derived deterministically from a landed transaction.
 * Two clocks (D8): `blockTime` is when the chain saw it; `firstSeenAt` is when we ingested it and
 * is the only time replay may use. A wallet that is OWNED never produces events (D26, INV-11).
 */
export const WalletEvent = z.object({
  id: Uuid,
  wallet: SolanaAddress,
  signature: TxSignature,
  /** Index of the movement the event was derived from; a swap uses its base-mint movement. */
  movementIndex: z.number().int().nonnegative(),
  slot: Slot,
  blockTime: Instant.nullable(),
  kind: WalletEventKind,
  /** The asset the event is about; null for pure SOL movements. */
  mint: MintAddress.nullable(),
  amount: Amount,
  decimals: z.number().int().min(0).max(18),
  /** The quote side of a BUY/SELL: which quote asset and how much of it (null = native SOL). */
  quoteMint: MintAddress.nullable(),
  quoteAmount: Amount.nullable(),
  counterparty: SolanaAddress.nullable(),
  source: WalletEventSource,
  firstSeenAt: Instant,
  payloadHash: Sha256Hex,
});
export type WalletEvent = z.infer<typeof WalletEvent>;
