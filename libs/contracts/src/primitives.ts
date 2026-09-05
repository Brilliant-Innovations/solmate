import { z } from 'zod';

/**
 * Scalar primitives shared by every contract.
 *
 * Rules (blueprint D8, D17, §6, §15.4):
 * - Money and token quantities are integer base units carried as decimal strings, never floats.
 *   USD figures are analytics only and never feed sizing or accounting.
 * - Every timestamp is an ISO 8601 UTC instant ending in `Z`.
 * - Solana addresses and signatures are base58 as the chain renders them.
 * - Hashes and Ed25519 signatures produced by this codebase are lowercase hex.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Lowercase only, so one id has exactly one canonical byte form. */
export const Uuid = z
  .uuid()
  .refine((v) => v === v.toLowerCase(), 'uuid must be lowercase')
  .brand<'Uuid'>();
export type Uuid = z.infer<typeof Uuid>;

/** ISO 8601 UTC instant, e.g. `2026-09-05T14:02:11.123Z`. */
export const Instant = z.iso.datetime({ offset: false }).brand<'Instant'>();
export type Instant = z.infer<typeof Instant>;

export const Slot = z.number().int().nonnegative().brand<'Slot'>();
export type Slot = z.infer<typeof Slot>;

export const SolanaAddress = z.string().regex(BASE58).min(32).max(44).brand<'SolanaAddress'>();
export type SolanaAddress = z.infer<typeof SolanaAddress>;

export const MintAddress = z.string().regex(BASE58).min(32).max(44).brand<'MintAddress'>();
export type MintAddress = z.infer<typeof MintAddress>;

export const TxSignature = z.string().regex(BASE58).min(86).max(88).brand<'TxSignature'>();
export type TxSignature = z.infer<typeof TxSignature>;

const U64_MAX = 18_446_744_073_709_551_615n;

/** Non-negative integer token quantity in base units (lamports, token atoms) as a decimal string, bounded to u64 like SPL. */
export const Amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'base-unit amount must be a non-negative integer decimal string')
  .max(20)
  .refine((v) => BigInt(v) <= U64_MAX, 'base-unit amount exceeds u64')
  .brand<'Amount'>();
export type Amount = z.infer<typeof Amount>;

/** Basis points, 0..10000 inclusive. */
export const Bps = z.number().int().min(0).max(10_000).brand<'Bps'>();
export type Bps = z.infer<typeof Bps>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/).brand<'Sha256Hex'>();
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Ed25519 signature as 128 lowercase hex characters (64 bytes). */
export const Ed25519SignatureHex = z.string().regex(/^[0-9a-f]{128}$/).brand<'Ed25519SignatureHex'>();
export type Ed25519SignatureHex = z.infer<typeof Ed25519SignatureHex>;

/** Ed25519 raw public key as 64 lowercase hex characters (32 bytes). */
export const Ed25519PublicKeyHex = z.string().regex(/^[0-9a-f]{64}$/).brand<'Ed25519PublicKeyHex'>();
export type Ed25519PublicKeyHex = z.infer<typeof Ed25519PublicKeyHex>;

/** Stable identifier of a verification key, e.g. `ed25519:3f9a…` (see signing/ed25519.ts). */
export const KeyId = z.string().regex(/^ed25519:[0-9a-f]{32}$/).brand<'KeyId'>();
export type KeyId = z.infer<typeof KeyId>;

/** Immutable version identifier for strategies, skills, policies, releases (D7, D38). */
export const VersionId = z.string().min(1).max(64).brand<'VersionId'>();
export type VersionId = z.infer<typeof VersionId>;

export const GitSha = z.string().regex(/^[0-9a-f]{7,40}$/).brand<'GitSha'>();
export type GitSha = z.infer<typeof GitSha>;

/** Idempotency key for exact-once intent semantics (D12). */
export const IdempotencyKey = z.string().min(8).max(128).brand<'IdempotencyKey'>();
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/** Monotonic sequence number (projections, journals, shadows). */
export const Sequence = z.number().int().nonnegative().brand<'Sequence'>();
export type Sequence = z.infer<typeof Sequence>;

export const Nonce = z.string().regex(/^[0-9a-f]{32}$/).brand<'Nonce'>();
export type Nonce = z.infer<typeof Nonce>;

/** Analytics-only USD figure. Never an input to sizing or accounting. */
export const UsdValue = z.number().nonnegative();
export type UsdValue = z.infer<typeof UsdValue>;

/** Fraction in [0, 1]. */
export const Fraction = z.number().min(0).max(1);
export type Fraction = z.infer<typeof Fraction>;

export const NonEmptyString = z.string().trim().min(1);

export const Milliseconds = z.number().int().nonnegative();

export const SolanaCluster = z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
export type SolanaCluster = z.infer<typeof SolanaCluster>;
