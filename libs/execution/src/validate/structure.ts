import type { DecodedTransaction } from '../tx/codec.js';
import { SYSTEM_PROGRAM } from './programs.js';

/**
 * Structural transaction checks before signing (blueprint §15.4 step 4, §15.7A, ADR-0007/0008;
 * ADR-0009 P7 build-time half). Pure over the decoded transaction and the executor's expectation:
 * the trading wallet is the fee payer and the only required signer, every program invoked is
 * statically present and on the allowed set (a program reached through an address table cannot be
 * policy-checked and is rejected, matching the signer-side policy), lookup tables are permitted
 * only when the Release allows them, and no System transfer leaves the wallet for a recipient
 * outside the approved set.
 */

export interface StructureExpectation {
  tradingWallet: string;
  allowedPrograms: readonly string[];
  allowLookupTables: boolean;
  /** Recipients a System transfer may target (wallet-owned or custody accounts); anything else is denied. */
  allowedTransferRecipients: readonly string[];
}

export type StructureRejection =
  | 'NO_INSTRUCTIONS'
  | 'VERSION_UNSUPPORTED'
  | 'FEE_PAYER_MISMATCH'
  | 'UNEXPECTED_SIGNER'
  | 'WALLET_NOT_SIGNER'
  | 'PROGRAM_VIA_LOOKUP_TABLE'
  | 'PROGRAM_NOT_ALLOWED'
  | 'LOOKUP_TABLES_NOT_ALLOWED'
  | 'SYSTEM_TRANSFER_TO_UNAPPROVED_RECIPIENT'
  | 'ALREADY_SIGNED_BY_OTHERS';

export type StructureVerdict = { ok: true; programs: string[] } | { ok: false; reasons: StructureRejection[]; detail: string[] };

const SYSTEM_TRANSFER = 2;

export function checkTransactionStructure(tx: DecodedTransaction, expected: StructureExpectation): StructureVerdict {
  const m = tx.message;
  const reasons: StructureRejection[] = [];
  const detail: string[] = [];
  if (m.instructions.length === 0) reasons.push('NO_INSTRUCTIONS');
  if (m.version !== 'legacy' && m.version !== 0) reasons.push('VERSION_UNSUPPORTED');
  const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures);
  if (signers[0] !== expected.tradingWallet) {
    reasons.push('FEE_PAYER_MISMATCH');
    detail.push(`fee payer ${signers[0] ?? 'none'}`);
  }
  if (!signers.includes(expected.tradingWallet)) reasons.push('WALLET_NOT_SIGNER');
  const others = signers.filter((s) => s !== expected.tradingWallet);
  if (others.length) {
    reasons.push('UNEXPECTED_SIGNER');
    detail.push(`extra signers ${others.join(', ')}`);
  }
  if (tx.signatures.some((s, i) => s !== null && signers[i] !== expected.tradingWallet)) reasons.push('ALREADY_SIGNED_BY_OTHERS');
  if (m.addressTableLookups.length > 0 && !expected.allowLookupTables) reasons.push('LOOKUP_TABLES_NOT_ALLOWED');

  const programs = new Set<string>();
  for (const ix of m.instructions) {
    const program = m.staticAccountKeys[ix.programIdIndex];
    if (program === undefined) {
      reasons.push('PROGRAM_VIA_LOOKUP_TABLE');
      detail.push(`instruction program index ${ix.programIdIndex} is not a static key`);
      continue;
    }
    programs.add(program);
    if (!expected.allowedPrograms.includes(program)) {
      reasons.push('PROGRAM_NOT_ALLOWED');
      detail.push(program);
    }
    if (program === SYSTEM_PROGRAM && ix.data.length >= 4 && ix.data[0] === SYSTEM_TRANSFER && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0) {
      const from = m.staticAccountKeys[ix.accountIndexes[0] ?? -1];
      const to = m.staticAccountKeys[ix.accountIndexes[1] ?? -1];
      if (from === expected.tradingWallet && (to === undefined || !expected.allowedTransferRecipients.includes(to))) {
        reasons.push('SYSTEM_TRANSFER_TO_UNAPPROVED_RECIPIENT');
        detail.push(`transfer to ${to ?? 'lookup-table account'}`);
      }
    }
  }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)], detail } : { ok: true, programs: [...programs] };
}
