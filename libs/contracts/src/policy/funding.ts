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
  /** Funding assets besides the account's settlement mint (native SOL for gas). */
  extraAllowedMints: z.array(MintAddress),
});
export type FundingPolicy = z.infer<typeof FundingPolicy>;

export const DEFAULT_FUNDING_POLICY: FundingPolicy = {
  version: 'funding-v1' as VersionId,
  maxInstructions: 4,
  allowComputeBudget: true,
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

/** A prepared instruction reduced to what the guard needs: program and the accounts it names, in order. */
export const PreparedInstruction = z.strictObject({
  programAddress: z.string().min(32).max(44),
  accountAddresses: z.array(z.string().min(32).max(44)),
});
export type PreparedInstruction = z.infer<typeof PreparedInstruction>;

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
  | 'ATA_OWNER_MISMATCH';

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
 * is the trading wallet (SOL) or its reviewed ATA (token). Anything else, including a second
 * transfer or an unknown program, refuses before the wallet prompt.
 */
export function validateFundingInstructions(instructions: readonly PreparedInstruction[], t: FundingTransfer, policy: FundingPolicy = DEFAULT_FUNDING_POLICY): FundingGuardVerdict {
  const reasons: FundingGuardReason[] = [];
  if (instructions.length === 0) return { ok: false, reasons: ['NO_TRANSFER'] };
  if (instructions.length > policy.maxInstructions) reasons.push('TOO_MANY_INSTRUCTIONS');
  const native = t.fundingMint === NATIVE_SOL_MINT;
  let transfers = 0;
  for (const ix of instructions) {
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM:
        if (!policy.allowComputeBudget) reasons.push('UNKNOWN_PROGRAM');
        break;
      case SYSTEM_PROGRAM: {
        // system transfer: [source, destination]
        transfers++;
        if (!native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[0] !== t.sourceWallet || ix.accountAddresses[1] !== t.destinationTradingWallet) reasons.push('TRANSFER_DESTINATION_MISMATCH');
        break;
      }
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM: {
        // transferChecked: [source ata, mint, destination ata, authority]
        transfers++;
        if (native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[1] !== t.fundingMint || ix.accountAddresses[2] !== t.destinationAta || ix.accountAddresses[3] !== t.sourceWallet) reasons.push('TRANSFER_DESTINATION_MISMATCH');
        break;
      }
      case ASSOCIATED_TOKEN_PROGRAM: {
        // create idempotent: [payer, ata, owner, mint, system, token]
        if (native) reasons.push('UNKNOWN_PROGRAM');
        else if (ix.accountAddresses[1] !== t.destinationAta || ix.accountAddresses[2] !== t.destinationTradingWallet || ix.accountAddresses[3] !== t.fundingMint) reasons.push('ATA_OWNER_MISMATCH');
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
