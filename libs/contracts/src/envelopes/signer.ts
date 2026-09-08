import { z } from 'zod';
import { Instant, Milliseconds, Sha256Hex, SolanaAddress, TxSignature, Uuid } from '../primitives.js';

// §15.7, §15.7A, D47, D51, D55 — the production trading-wallet signer boundary ---------------------

export const SignerBackend = z.enum(['SOFTWARE_DEV', 'TURNKEY']);
export type SignerBackend = z.infer<typeof SignerBackend>;

export const SignerHealth = z.strictObject({
  backend: SignerBackend,
  state: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE']),
  checkedAt: Instant,
  latencyMs: Milliseconds.nullable(),
  /** Digest of the signer-side policy in force (D55); null for the software dev signer, which has none. */
  policyDigest: Sha256Hex.nullable(),
  detail: z.string().max(512).nullable(),
});
export type SignerHealth = z.infer<typeof SignerHealth>;

export const SigningRequest = z.strictObject({
  intentId: Uuid,
  attemptId: Uuid,
  /** Hash of the exact message bytes; a retry after a timeout must present the same hash (§15.4). */
  messageHash: Sha256Hex,
});
export type SigningRequest = z.infer<typeof SigningRequest>;

export const SignatureResult = z.strictObject({
  signature: TxSignature,
  signer: SolanaAddress,
  signedAt: Instant,
  /** True when the backend reported this as a repeat of an earlier identical request. */
  deduplicated: z.boolean(),
});
export type SignatureResult = z.infer<typeof SignatureResult>;

/**
 * The only way the executor obtains a signature (D10, D47). Backends never expose key material:
 * the software dev signer holds a throwaway key for non-live clusters; the Turnkey adapter holds a
 * non-exportable identity behind the D55 policy. Ed25519 is deterministic, so signing the same
 * message bytes twice yields the same signature and a timed-out request may be retried safely.
 */
export interface TradingWalletSigner {
  readonly backend: SignerBackend;
  readonly publicKey: SolanaAddress;
  signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult>;
  health(): Promise<SignerHealth>;
}
