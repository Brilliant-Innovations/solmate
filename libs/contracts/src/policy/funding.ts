import { z } from 'zod';
import { Amount, MintAddress, SolanaAddress, SolanaCluster, VersionId } from '../primitives.js';

/**
 * Typed manual-funding guard (blueprint §20.18, §3.7, §32 "can funding UI/provider compromise
 * substitute a destination, mint, cluster or unrelated instruction"). Pure and shared: the browser
 * runs it on the prepared instruction list before the wallet prompt, the worker runs it again on
 * the reported transfer before recording a funding event, and reconciliation only ever confirms
 * from chain deltas. Funding is manual, operator-signed and one transfer at a time: no allowance,
 * no scheduled pull, no background debit (§31 "trading-wallet replenishment is manual").
 */

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
/** Native SOL is recorded under the wrapped-SOL mint so funding_mint is always a mint address. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112' as MintAddress;

export const FundingPolicy = z.strictObject({
  version: VersionId,
  /** At most: one optional idempotent ATA creation, one transfer, optional compute-budget instructions. */
  maxInstructions: z.number().int().positive(),
  allowComputeBudget: z.boolean(),
  /**
   * Ceiling on `SetComputeUnitPrice`. A compromised bundle used to be able to append a
   * compute-budget instruction with an arbitrary priority fee and have the guard accept it
   * wholesale, because instruction data never reached the guard at all (review 2026-09-09, M-1).
   */
  maxPriorityFeeMicroLamports: z.number().int().nonnegative(),
  /** Funding assets besides the account's settlement mint (native SOL for gas). */
  extraAllowedMints: z.array(MintAddress),
});
export type FundingPolicy = z.infer<typeof FundingPolicy>;

export const DEFAULT_FUNDING_POLICY: FundingPolicy = {
  version: 'funding-v2' as VersionId,
  maxInstructions: 4,
  allowComputeBudget: true,
  maxPriorityFeeMicroLamports: 1_000_000,
  extraAllowedMints: [NATIVE_SOL_MINT],
};

/** What the operator reviewed and the wallet was asked to sign. */
export const FundingTransfer = z.strictObject({
  sourceWallet: SolanaAddress,
  destinationTradingWallet: SolanaAddress,
  /** Canonical ATA of the destination for a token transfer; null for native SOL. */
  destinationAta: SolanaAddress.nullable(),
  fundingMint: MintAddress,
  requestedAmount: Amount,
  cluster: SolanaCluster,
});
export type FundingTransfer = z.infer<typeof FundingTransfer>;

/**
 * A prepared instruction reduced to what the guard needs: program, the accounts it names in order,
 * and the instruction data as lowercase hex.
 *
 * The data used to be dropped before validation, which left the guard checking only *which*
 * accounts a transfer named and never *how much* it moved: a compromised bundle could keep every
 * address the guard inspects and change the amount, or append a compute-budget instruction with an
 * arbitrary priority fee (review 2026-09-09, M-1). It is required, not optional, so a caller cannot
 * disable the amount check by omission.
 */
export const PreparedInstruction = z.strictObject({
  programAddress: z.string().min(32).max(44),
  accountAddresses: z.array(z.string().min(32).max(44)),
  data: z
    .string()
    .max(4096)
    .regex(/^([0-9a-f]{2})*$/, 'lowercase hex, whole bytes'),
});
export type PreparedInstruction = z.infer<typeof PreparedInstruction>;

/** Instruction data as lowercase hex, for building a `PreparedInstruction` from a wallet library's bytes. */
export function toInstructionDataHex(data: Uint8Array | undefined | null): string {
  if (!data) return '';
  let out = '';
  for (const b of data) out += b.toString(16).padStart(2, '0');
  return out;
}

function bytesOf(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Little-endian unsigned integer of `width` bytes starting at `offset`; null when the data is too short. */
function readUintLe(bytes: readonly number[], offset: number, width: number): bigint | null {
  if (bytes.length < offset + width) return null;
  let v = 0n;
  for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]!);
  return v;
}

/** The deployment facts the transfer must match; from the trading account row, never from the wallet. */
export interface FundingExpectation {
  tradingWallet: string;
  settlementMint: string;
  cluster: SolanaCluster;
  /** Canonical ATA of the trading wallet for the settlement mint, when known. */
  settlementAta: string | null;
}

export type FundingGuardReason =
  | 'DESTINATION_MISMATCH'
  | 'ATA_MISMATCH'
  | 'MINT_NOT_ALLOWED'
  | 'CLUSTER_MISMATCH'
  | 'AMOUNT_INVALID'
  | 'SOURCE_IS_TRADING_WALLET'
  | 'TOO_MANY_INSTRUCTIONS'
  | 'UNKNOWN_PROGRAM'
  | 'NO_TRANSFER'
  | 'MULTIPLE_TRANSFERS'
  | 'TRANSFER_DESTINATION_MISMATCH'
  | 'ATA_OWNER_MISMATCH'
  /** The encoded transfer amount is not the amount the operator reviewed (review 2026-09-09, M-1). */
  | 'AMOUNT_MISMATCH'
  /** The instruction data is not the shape its program requires, so nothing about it can be trusted. */
  | 'INSTRUCTION_DATA_INVALID'
  | 'PRIORITY_FEE_ABOVE_MAX';

export type FundingGuardVerdict = { ok: true } | { ok: false; reasons: FundingGuardReason[] };

export function allowedFundingMints(expected: FundingExpectation, policy: FundingPolicy = DEFAULT_FUNDING_POLICY): string[] {
  return [expected.settlementMint, ...policy.extraAllowedMints];
}

/** The transfer as reviewed, against the deployment's configured destination, mint and cluster. */
export function validateFundingTransfer(t: FundingTransfer, expected: FundingExpectation, policy: FundingPolicy = DEFAULT_FUNDING_POLICY): FundingGuardVerdict {
  const reasons: FundingGuardReason[] = [];
  if (t.destinationTradingWallet !== expected.tradingWallet) reasons.push('DESTINATION_MISMATCH');
  if (t.cluster !== expected.cluster) reasons.push('CLUSTER_MISMATCH');
  if (!allowedFundingMints(expected, policy).includes(t.fundingMint)) reasons.push('MINT_NOT_ALLOWED');
  if (t.sourceWallet === expected.tradingWallet) reasons.push('SOURCE_IS_TRADING_WALLET');
  let amount = 0n;
  try {
    amount = BigInt(t.requestedAmount);
  } catch {
    amount = 0n;
  }
  if (amount <= 0n) reasons.push('AMOUNT_INVALID');
  const native = t.fundingMint === NATIVE_SOL_MINT;
  if (native && t.destinationAta !== null) reasons.push('ATA_MISMATCH');
  if (!native) {
    if (t.destinationAta === null) reasons.push('ATA_MISMATCH');
    else if (t.fundingMint === expected.settlementMint && expected.settlementAta !== null && t.destinationAta !== expected.settlementAta) reasons.push('ATA_MISMATCH');
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * The prepared instruction list must be exactly the reviewed transfer: optional compute budget,
 * optional idempotent ATA creation for the destination owner, and one transfer whose destination
 * is the trading wallet (SOL) or its reviewed ATA (token) and whose encoded amount is the reviewed
 * amount. Anything else — a second transfer, an unknown program, a different amount, a priority
 * fee above the policy ceiling — refuses before the wallet prompt.
 */
export function validateFundingInstructions(instructions: readonly PreparedInstruction[], t: FundingTransfer, policy: FundingPolicy = DEFAULT_FUNDING_POLICY): FundingGuardVerdict {
  const reasons: FundingGuardReason[] = [];
  if (instructions.length === 0) return { ok: false, reasons: ['NO_TRANSFER'] };
  if (instructions.length > policy.maxInstructions) reasons.push('TOO_MANY_INSTRUCTIONS');
  const native = t.fundingMint === NATIVE_SOL_MINT;
  let requested: bigint;
  try {
    requested = BigInt(t.requestedAmount);
  } catch {
    return { ok: false, reasons: ['AMOUNT_INVALID'] };
  }
  let transfers = 0;
  for (const ix of instructions) {
    const data = bytesOf(ix.data);
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM: {
        if (!policy.allowComputeBudget) {
          reasons.push('UNKNOWN_PROGRAM');
          break;
        }
        // 1 RequestHeapFrame(u32) · 2 SetComputeUnitLimit(u32) · 3 SetComputeUnitPrice(u64 micro-lamports)
        const disc = data[0];
        if (disc !== 1 && disc !== 2 && disc !== 3) reasons.push('INSTRUCTION_DATA_INVALID');
        else if (disc === 3) {
          const price = readUintLe(data, 1, 8);
          if (price === null) reasons.push('INSTRUCTION_DATA_INVALID');
          else if (price > BigInt(policy.maxPriorityFeeMicroLamports)) reasons.push('PRIORITY_FEE_ABOVE_MAX');
        }
        break;
      }
      case SYSTEM_PROGRAM: {
        // system transfer: accounts [source, destination]; data = u32 discriminator 2 + u64 lamports
        transfers++;
        if (!native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[0] !== t.sourceWallet || ix.accountAddresses[1] !== t.destinationTradingWallet) reasons.push('TRANSFER_DESTINATION_MISMATCH');
        const disc = readUintLe(data, 0, 4);
        const lamports = readUintLe(data, 4, 8);
        if (disc !== 2n || lamports === null || data.length !== 12) reasons.push('INSTRUCTION_DATA_INVALID');
        else if (lamports !== requested) reasons.push('AMOUNT_MISMATCH');
        break;
      }
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM: {
        // transferChecked: accounts [source ata, mint, destination ata, authority]; data = 12 + u64 amount + u8 decimals
        transfers++;
        if (native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[1] !== t.fundingMint || ix.accountAddresses[2] !== t.destinationAta || ix.accountAddresses[3] !== t.sourceWallet) reasons.push('TRANSFER_DESTINATION_MISMATCH');
        const amount = readUintLe(data, 1, 8);
        if (data[0] !== 12 || amount === null || data.length !== 10) reasons.push('INSTRUCTION_DATA_INVALID');
        else if (amount !== requested) reasons.push('AMOUNT_MISMATCH');
        break;
      }
      case ASSOCIATED_TOKEN_PROGRAM: {
        // create idempotent: accounts [payer, ata, owner, mint, system, token]; data = single byte 1
        if (native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[1] !== t.destinationAta || ix.accountAddresses[2] !== t.destinationTradingWallet || ix.accountAddresses[3] !== t.fundingMint) reasons.push('ATA_OWNER_MISMATCH');
        if (data.length !== 1 || data[0] !== 1) reasons.push('INSTRUCTION_DATA_INVALID');
        break;
      }
      default:
        reasons.push('UNKNOWN_PROGRAM');
    }
  }
  if (transfers === 0) reasons.push('NO_TRANSFER');
  if (transfers > 1) reasons.push('MULTIPLE_TRANSFERS');
  const unique = [...new Set(reasons)];
  return unique.length ? { ok: false, reasons: unique } : { ok: true };
}


/**
 * Whether an observed chain movement is the reviewed funding transfer a recorded claim describes
 * (blueprint §20.18, §31 "wallet/chain reconciliation is authoritative"; §32 "can a wallet-reported
 * success change authoritative funding state before chain reconciliation").
 *
 * Reconciliation used to accept any inflow whose signature matched a SUBMITTED claim and whose
 * endpoints matched the claim's own fields, then `continue` past `classifyMovement` (review
 * 2026-09-09, M-2, M-3). Two things were missing: the amount the operator reviewed was never
 * compared against the amount the chain actually moved, and the source was checked only against the
 * claim itself, so an own wallet could be presented as an external funder and its movement labelled
 * EXPECTED. Both are checked here.
 *
 * Residual, recorded in ADR-0012: a claim is filed after the wallet has already submitted, so an
 * operator session that can read the dashboard knows a real inflow's signature and amount and can
 * still describe it. Closing that needs a pre-registered claim, which is an operator-flow change.
 */
export type FundingClaimVerdict =
  | { kind: 'EXPECTED' }
  | { kind: 'REFUSED'; reason: 'FUNDING_SOURCE_IS_OWNED' | 'FUNDING_AMOUNT_MISMATCH' }
  /** The claim does not describe this movement at all; classify it normally. */
  | { kind: 'NOT_THIS_MOVEMENT' };

export interface FundingClaim {
  sourceWallet: string;
  destinationTradingWallet: string;
  destinationAta: string | null;
  fundingMint: string;
  requestedAmount: string;
}

export interface ObservedFundingMovement {
  kind: 'SOL' | 'TOKEN';
  fromOwner: string | null;
  toOwner: string | null;
  toTokenAccount: string | null;
  mint: string | null;
  amount: string;
}

export function fundingClaimVerdict(claim: FundingClaim, m: ObservedFundingMovement, ownedAddresses: ReadonlySet<string>): FundingClaimVerdict {
  const destinationMatches = m.kind === 'SOL' ? m.toOwner === claim.destinationTradingWallet : m.mint === claim.fundingMint && (m.toTokenAccount === claim.destinationAta || m.toOwner === claim.destinationTradingWallet);
  if (m.fromOwner !== claim.sourceWallet || !destinationMatches) return { kind: 'NOT_THIS_MOVEMENT' };
  // §31: own-wallet or vault activity is never external funding, whatever a claim says it is.
  if (m.fromOwner !== null && ownedAddresses.has(m.fromOwner)) return { kind: 'REFUSED', reason: 'FUNDING_SOURCE_IS_OWNED' };
  let moved: bigint;
  let requested: bigint;
  try {
    moved = BigInt(m.amount);
    requested = BigInt(claim.requestedAmount);
  } catch {
    return { kind: 'REFUSED', reason: 'FUNDING_AMOUNT_MISMATCH' };
  }
  if (moved !== requested) return { kind: 'REFUSED', reason: 'FUNDING_AMOUNT_MISMATCH' };
  return { kind: 'EXPECTED' };
}

/** D56: crossing the attested ceiling is allowed as a manual action but must be labelled; new entries pause until re-attestation. */
export function fundingCeilingVerdict(input: { recognizedUsd: number | null; addUsd: number; ceilingUsd: number | null }): { exceeds: boolean; projectedUsd: number | null } {
  if (input.ceilingUsd === null) return { exceeds: false, projectedUsd: input.recognizedUsd === null ? null : input.recognizedUsd + input.addUsd };
  const projected = (input.recognizedUsd ?? 0) + input.addUsd;
  return { exceeds: projected > input.ceilingUsd, projectedUsd: projected };
}

/** payload of a FUND_TRADING_WALLET control request: the reviewed transfer plus what the wallet reported. */
export const FundingRequestPayload = z.strictObject({
  transfer: FundingTransfer,
  outcome: z.enum(['SUBMITTED', 'FAILED', 'ABANDONED']),
  txSignature: z.string().min(86).max(88).nullable(),
  failureReason: z.string().max(256).nullable(),
  source: z.string().max(64).optional(),
});
export type FundingRequestPayload = z.infer<typeof FundingRequestPayload>;
