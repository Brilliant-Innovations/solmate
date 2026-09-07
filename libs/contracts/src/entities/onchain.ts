import { z } from 'zod';
import { Amount, Instant, MintAddress, Slot, SolanaAddress, SolanaCluster, TxSignature, Uuid, VersionId } from '../primitives.js';
import { ReasonCode, SignedAmount } from './common.js';

// Owned-address registry (D26, §8.6) -----------------------------------------------------------

export const OwnedAddressPurpose = z.enum(['TRADING_WALLET', 'ASSOCIATED_TOKEN_ACCOUNT', 'JUPITER_TRIGGER_VAULT', 'COLD_RECOVERY', 'FUNDING_SOURCE', 'OTHER']);
export type OwnedAddressPurpose = z.infer<typeof OwnedAddressPurpose>;

/**
 * An application-controlled address. Flows touching any owned address are excluded from
 * smart-money, whale-flow and holder-behaviour features, and our own transactions can never
 * serve as candidate evidence (D26, INV-11). A retired address stays owned for history.
 */
export const OwnedAddress = z.object({
  address: SolanaAddress,
  purpose: OwnedAddressPurpose,
  cluster: SolanaCluster,
  accountId: Uuid.nullable(),
  registeredAt: Instant,
  retiredAt: Instant.nullable(),
});
export type OwnedAddress = z.infer<typeof OwnedAddress>;

// Chain movements (D9, §3.2) ---------------------------------------------------------------------

/** One SOL or token transfer parsed from a landed transaction, provider-neutral. */
export const ChainMovement = z.object({
  signature: TxSignature,
  /** Position of the transfer inside the transaction's parsed transfer list. */
  index: z.number().int().nonnegative(),
  slot: Slot,
  blockTime: Instant.nullable(),
  kind: z.enum(['SOL', 'TOKEN']),
  /** Null for native SOL. */
  mint: MintAddress.nullable(),
  fromOwner: SolanaAddress.nullable(),
  toOwner: SolanaAddress.nullable(),
  fromTokenAccount: SolanaAddress.nullable(),
  toTokenAccount: SolanaAddress.nullable(),
  amount: Amount,
  decimals: z.number().int().min(0).max(18),
  /** Provider's summary type ("swap", "transfer") for the whole transaction; evidence, not authority. */
  summaryType: z.string().max(64).nullable(),
  /** Transaction failed on chain: balances did not move, the fee did. */
  failed: z.boolean(),
});
export type ChainMovement = z.infer<typeof ChainMovement>;

/** Per-transaction facts needed for SOL accounting: fee and who paid it. */
export const ChainTransactionFacts = z.object({
  signature: TxSignature,
  slot: Slot,
  blockTime: Instant.nullable(),
  feeLamports: Amount,
  feePayer: SolanaAddress.nullable(),
  failed: z.boolean(),
  /** Net lamport change of the given account when the provider reports it; null when unavailable. */
  nativeBalanceChanges: z.array(z.object({ account: SolanaAddress, lamports: SignedAmount })),
  movements: z.array(ChainMovement),
});
export type ChainTransactionFacts = z.infer<typeof ChainTransactionFacts>;

export const MovementClassificationKind = z.enum(['EXPECTED', 'UNKNOWN']);
export type MovementClassificationKind = z.infer<typeof MovementClassificationKind>;

/** A movement after the custody classifier (libs/execution custody.ts) has judged it. */
export const ClassifiedMovement = ChainMovement.extend({
  classification: MovementClassificationKind,
  reason: z.string().max(64).nullable(),
  lifecycleId: Uuid.nullable(),
});
export type ClassifiedMovement = z.infer<typeof ClassifiedMovement>;

// Custody observations and reconciliation (D9, §6.17, §13.6) -------------------------------------

export const CustodyBalanceObservation = z.object({
  /** Token account address, or the wallet itself for SOL. */
  address: SolanaAddress,
  owner: SolanaAddress,
  /** Null for native SOL. */
  mint: MintAddress.nullable(),
  amount: Amount,
  decimals: z.number().int().min(0).max(18),
  tokenProgram: z.enum(['TOKEN', 'TOKEN_2022']).nullable(),
  slot: Slot,
});
export type CustodyBalanceObservation = z.infer<typeof CustodyBalanceObservation>;

export const CustodyReconciliationStatus = z.enum(['CLEAN', 'MISMATCH', 'UNAVAILABLE']);
export type CustodyReconciliationStatus = z.infer<typeof CustodyReconciliationStatus>;

export const RECONCILIATION_REASONS = [
  'BALANCE_MISMATCH',
  'SOL_BALANCE_MISMATCH',
  'UNEXPECTED_TOKEN_ACCOUNT',
  'UNREGISTERED_CUSTODY_LOCATION',
  'UNKNOWN_MOVEMENT',
  'MOVEMENT_UNPARSEABLE',
  'SIGNATURE_BACKLOG',
  'CHAIN_READ_FAILED',
] as const;
export const ReconciliationReason = z.enum(RECONCILIATION_REASONS);
export type ReconciliationReason = z.infer<typeof ReconciliationReason>;

export const BalanceLine = z.object({
  custodyAccountId: Uuid.nullable(),
  address: SolanaAddress,
  mint: MintAddress.nullable(),
  /** Null when the ledger has no expectation for this balance (settlement cash before M5a, SOL on first sighting). */
  expected: Amount.nullable(),
  observed: Amount.nullable(),
  delta: SignedAmount.nullable(),
  ok: z.boolean(),
});
export type BalanceLine = z.infer<typeof BalanceLine>;

export const CustodyReconciliation = z.object({
  id: Uuid,
  accountId: Uuid,
  evaluatedAt: Instant,
  policyVersion: VersionId,
  chainSlot: Slot.nullable(),
  status: CustodyReconciliationStatus,
  reasons: z.array(ReasonCode),
  balances: z.array(BalanceLine),
  unexpectedTokenAccounts: z.array(z.object({ tokenAccount: SolanaAddress, mint: MintAddress, amount: Amount, registered: z.boolean() })),
  movements: z.array(ClassifiedMovement),
  /** Signatures seen this cycle that could not be parsed into movements (provider absent or failed). */
  unparsedSignatures: z.array(TxSignature),
  movementSource: z.enum(['HELIUS', 'NONE']),
  cursor: z.object({ lastSignature: TxSignature.nullable(), lastSlot: Slot.nullable(), solLamports: Amount.nullable() }),
  /** True when this report paused new entries (D9, §13.6 "wallet/custody mismatch"). */
  pauseTriggered: z.boolean(),
});
export type CustodyReconciliation = z.infer<typeof CustodyReconciliation>;
