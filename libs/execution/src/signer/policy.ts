import { ADDRESS_TABLE_LOOKUP, type SignerTransactionPolicy } from '@sol-agent-trader/contracts';
import type { DecodedTransaction } from '../tx/codec.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';

/**
 * Local mirror of the signer-side policy (blueprint D55, §15.7A, ADR-0008; INV-25).
 *
 * The provider enforces the real thing — nothing here can, and that is the point of D55. This
 * evaluator exists so that:
 *
 *   - the executor refuses before it asks, so a request the provider would deny never leaves the
 *     host and never appears in the provider's audit log as an attempted policy violation;
 *   - ADR-0008's Probe A cases (b) supported shapes accepted, (c) malicious shapes rejected and
 *     (d) lookup-table compatibility are contract tests here, against the same artifact that
 *     renders the pinned conditions, instead of being discovered live;
 *   - a drift between what we believe the policy is and what it says is a test failure.
 *
 * It reads the transaction the way the provider does. An account index beyond the static keys is
 * an address-table account: the provider substitutes the literal `ADDRESS_TABLE_LOOKUP` for it, so
 * neither of us knows where it points and a value movement into one is denied. A token mint is
 * policy-visible only for `TransferChecked` (12) and `TransferCheckedWithFee` (26); a plain
 * `Transfer` (3) carries no mint and therefore cannot satisfy a mint constraint.
 */

export type SignerPolicyRejection =
  | 'CLUSTER_MISMATCH'
  | 'FEE_PAYER_NOT_TRADING_WALLET'
  | 'UNEXPECTED_SIGNER'
  | 'PROGRAM_NOT_ALLOWED'
  | 'PROGRAM_VIA_LOOKUP_TABLE'
  | 'LOOKUP_TABLES_NOT_ALLOWED'
  | 'TOO_MANY_INSTRUCTIONS'
  | 'SOL_TRANSFER_NOT_PERMITTED'
  | 'SOL_TRANSFER_RECIPIENT_NOT_ALLOWED'
  | 'SPL_TRANSFER_NOT_PERMITTED'
  | 'SPL_MINT_NOT_POLICY_VISIBLE'
  | 'SPL_MINT_NOT_ALLOWED'
  | 'SPL_RECIPIENT_NOT_ALLOWED'
  | 'TRANSFER_TARGET_VIA_LOOKUP_TABLE'
  | 'MALFORMED_INSTRUCTION_DATA';

export interface SignerPolicyContext {
  /** The cluster the transaction is being submitted to; compared against the pinned policy. */
  cluster: string;
}

export type SignerPolicyVerdict =
  | { ok: true; programs: string[]; solTransfers: number; splTransfers: number }
  | { ok: false; reasons: SignerPolicyRejection[]; detail: string[] };

/** SPL instruction discriminators the policy cares about. */
const SPL_TRANSFER = 3;
const SPL_TRANSFER_CHECKED = 12;
const SPL_TRANSFER_CHECKED_WITH_FEE = 26;
/** System `Transfer` is a u32 discriminator, not a byte. */
const SYSTEM_TRANSFER = 2;

function readU32Le(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  return (data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)) >>> 0;
}

export function evaluateSignerPolicy(tx: DecodedTransaction, policy: SignerTransactionPolicy, ctx: SignerPolicyContext): SignerPolicyVerdict {
  const m = tx.message;
  const reasons: SignerPolicyRejection[] = [];
  const detail: string[] = [];
  const add = (r: SignerPolicyRejection, d?: string) => {
    reasons.push(r);
    if (d) detail.push(d);
  };

  if (ctx.cluster !== policy.cluster) add('CLUSTER_MISMATCH', `transaction for ${ctx.cluster}, policy pinned to ${policy.cluster}`);

  const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures);
  if (signers[0] !== policy.tradingWallet) add('FEE_PAYER_NOT_TRADING_WALLET', `fee payer ${signers[0] ?? 'none'}`);
  const others = signers.filter((s) => s !== policy.tradingWallet);
  if (others.length) add('UNEXPECTED_SIGNER', `extra signers ${others.join(', ')}`);

  if (m.addressTableLookups.length > 0 && !policy.allowLookupTables) add('LOOKUP_TABLES_NOT_ALLOWED', `${m.addressTableLookups.length} lookup table(s)`);
  if (m.instructions.length > policy.maxInstructions) add('TOO_MANY_INSTRUCTIONS', `${m.instructions.length} > ${policy.maxInstructions}`);

  const allowedPrograms = new Set<string>(policy.allowedPrograms);
  const allowedSolRecipients = new Set<string>(policy.allowedTransferRecipients);
  const allowedMints = new Set<string>(policy.allowedSplMints);
  const allowedSplRecipients = new Set<string>(policy.allowedSplRecipients);

  /** The address at an account index, or the lookup placeholder when it is loaded from a table. */
  const keyAt = (index: number): string => m.staticAccountKeys[index] ?? ADDRESS_TABLE_LOOKUP;

  const programs = new Set<string>();
  let solTransfers = 0;
  let splTransfers = 0;

  for (const ix of m.instructions) {
    const program = keyAt(ix.programIdIndex);
    if (program === ADDRESS_TABLE_LOOKUP) {
      // The provider rejects a program reached through a lookup table outright; so do we.
      add('PROGRAM_VIA_LOOKUP_TABLE', `program index ${ix.programIdIndex}`);
      continue;
    }
    programs.add(program);
    if (!allowedPrograms.has(program)) add('PROGRAM_NOT_ALLOWED', program);

    if (program === SYSTEM_PROGRAM) {
      const disc = readU32Le(ix.data);
      if (disc === null) {
        add('MALFORMED_INSTRUCTION_DATA', 'system instruction shorter than its discriminator');
        continue;
      }
      if (disc !== SYSTEM_TRANSFER) continue;
      solTransfers++;
      // system transfer accounts: [source, destination]
      const to = ix.accountIndexes.length > 1 ? keyAt(ix.accountIndexes[1]!) : ADDRESS_TABLE_LOOKUP;
      if (policy.allowedTransferRecipients.length === 0) add('SOL_TRANSFER_NOT_PERMITTED', `to ${to}`);
      else if (to === ADDRESS_TABLE_LOOKUP) add('TRANSFER_TARGET_VIA_LOOKUP_TABLE', 'SOL transfer destination is not policy-visible');
      else if (!allowedSolRecipients.has(to)) add('SOL_TRANSFER_RECIPIENT_NOT_ALLOWED', to);
      continue;
    }

    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const disc = ix.data[0];
      if (disc === undefined) {
        add('MALFORMED_INSTRUCTION_DATA', 'token instruction carries no discriminator');
        continue;
      }
      if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED && disc !== SPL_TRANSFER_CHECKED_WITH_FEE) continue;
      splTransfers++;
      if (!policy.anySplMint && policy.allowedSplMints.length === 0) {
        add('SPL_TRANSFER_NOT_PERMITTED', `token program instruction ${disc}`);
        continue;
      }
      if (disc === SPL_TRANSFER) {
        // Transfer: [source, destination, authority] — no mint account, so the mint the provider
        // would evaluate does not exist. A mint constraint cannot be satisfied; deny.
        add('SPL_MINT_NOT_POLICY_VISIBLE', 'plain SPL Transfer carries no mint; use TransferChecked');
        continue;
      }
      // TransferChecked: [source, mint, destination, authority]
      const mint = ix.accountIndexes.length > 1 ? keyAt(ix.accountIndexes[1]!) : ADDRESS_TABLE_LOOKUP;
      const to = ix.accountIndexes.length > 2 ? keyAt(ix.accountIndexes[2]!) : ADDRESS_TABLE_LOOKUP;
      if (mint === ADDRESS_TABLE_LOOKUP || to === ADDRESS_TABLE_LOOKUP) {
        add('TRANSFER_TARGET_VIA_LOOKUP_TABLE', `SPL transfer mint ${mint} destination ${to}`);
        continue;
      }
      // Under `anySplMint` the mint is deliberately unconstrained; the destination check below is
      // what keeps the value ours, and TransferChecked keeps the mint visible in the incident log.
      if (!policy.anySplMint && !allowedMints.has(mint)) add('SPL_MINT_NOT_ALLOWED', mint);
      if (!allowedSplRecipients.has(to)) add('SPL_RECIPIENT_NOT_ALLOWED', to);
    }
  }

  const unique = [...new Set(reasons)];
  return unique.length ? { ok: false, reasons: unique, detail } : { ok: true, programs: [...programs], solTransfers, splTransfers };
}
