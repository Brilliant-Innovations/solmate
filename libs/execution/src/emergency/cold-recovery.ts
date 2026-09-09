import { sweepDestinations, sweepSignerPolicy, type ColdRecoveryRecord, type SolanaAddress, type VersionId } from '@sol-agent-trader/contracts';
import { associatedTokenAddress } from '../direct-pool/bytes.js';
import { evaluateSignerPolicy, type SignerPolicyVerdict } from '../signer/policy.js';
import type { DecodedTransaction } from '../tx/codec.js';

/**
 * Cold-recovery sweep checks (blueprint D53, D54, §15.7B; INV-27).
 *
 * Two independent things are checked here, and they fail for different reasons:
 *
 *   1. `verifyColdRecoveryRecord` proves each pinned token account really is the canonical
 *      associated token account of the pinned wallet for its mint. Without this, the record could
 *      pin a lookalike address — the sweep would be "to the pinned destination" and the funds would
 *      still be gone. The derivation is the same one the direct-pool adapters use.
 *
 *   2. `checkSweepTransaction` evaluates a candidate sweep against the policy built from the
 *      record, so no destination outside it can appear. The provider's break-glass policy is the
 *      enforcing layer during an incident; this is what makes the drill meaningful beforehand.
 */

export type ColdRecoveryRecordFinding =
  | { kind: 'TOKEN_ACCOUNT_NOT_CANONICAL'; mint: string; pinned: string; canonical: string }
  | { kind: 'DERIVATION_FAILED'; mint: string; detail: string };

export function verifyColdRecoveryRecord(record: ColdRecoveryRecord): { ok: true } | { ok: false; findings: ColdRecoveryRecordFinding[] } {
  const findings: ColdRecoveryRecordFinding[] = [];
  for (const t of record.tokenAccounts) {
    let canonical: string;
    try {
      canonical = associatedTokenAddress(record.coldRecoveryWallet, t.mint, t.tokenProgram);
    } catch (err) {
      findings.push({ kind: 'DERIVATION_FAILED', mint: t.mint, detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (canonical !== t.tokenAccount) findings.push({ kind: 'TOKEN_ACCOUNT_NOT_CANONICAL', mint: t.mint, pinned: t.tokenAccount, canonical });
  }
  return findings.length ? { ok: false, findings } : { ok: true };
}

/**
 * A candidate `SWEEP_TO_COLD_RECOVERY` transaction, against the policy the record implies. The
 * record is the only source of the destination: this function takes no recipient argument, so a
 * caller cannot pass one (D54).
 */
export function checkSweepTransaction(tx: DecodedTransaction, record: ColdRecoveryRecord, input: { policyVersion: VersionId; tradingWallet: SolanaAddress; cluster: string }): SignerPolicyVerdict {
  const policy = sweepSignerPolicy(record, { policyVersion: input.policyVersion, tradingWallet: input.tradingWallet });
  return evaluateSignerPolicy(tx, policy, { cluster: input.cluster });
}

export { sweepDestinations };
