import { z } from 'zod';
import { canonicalHash } from '../signing/canonical.js';
import { MintAddress, Sha256Hex, SolanaAddress, SolanaCluster, VersionId } from '../primitives.js';
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './funding.js';
import { SignerTransactionPolicy } from './signer-policy.js';

/**
 * The pre-registered cold-recovery destination and the break-glass sweep policy (blueprint D53,
 * D54, §15.7B; INV-27).
 *
 * D54 is unusually specific about provenance, and it is the whole point of this file:
 *
 *   "The cold-recovery address/trust record is pinned in the signer/recovery control plane and
 *    independently documented offline; it is not supplied by a browser, database row, environment
 *    variable on the executor host or incident CLI argument."
 *
 * So the address is a field of a versioned, digested artifact that a human reviews once — never a
 * parameter. `SWEEP_TO_COLD_RECOVERY` is the only incident transfer class with an external
 * recipient, and this record is the only place that recipient can come from.
 *
 * Nothing here signs. The break-glass principal signs at the provider's control plane, outside
 * every application deployable (D53), and `renderTurnkeyPolicy` over `sweepSignerPolicy` produces
 * the conditions pinned there. The local evaluator in `libs/execution` mirrors them so a malformed
 * sweep is caught while rehearsing rather than during an incident.
 */

export const ColdRecoveryTokenAccount = z.strictObject({
  mint: MintAddress,
  /** The wallet's canonical associated token account for that mint; provable, not merely asserted. */
  tokenAccount: SolanaAddress,
  tokenProgram: SolanaAddress,
});
export type ColdRecoveryTokenAccount = z.infer<typeof ColdRecoveryTokenAccount>;

export const ColdRecoveryRecord = z
  .strictObject({
    version: VersionId,
    cluster: SolanaCluster,
    /** The single pre-registered destination. One address: a sweep has no choice of recipient. */
    coldRecoveryWallet: SolanaAddress,
    /** Its canonical token accounts, one per mint the incident may need to move. */
    tokenAccounts: z.array(ColdRecoveryTokenAccount),
    /**
     * Where the offline trust record lives (D54 "independently documented offline"). Not a secret
     * and not a credential — a pointer a human can check the address against, away from this repo.
     */
    offlineRecordReference: z.string().min(1).max(200),
  })
  .refine((r) => new Set(r.tokenAccounts.map((t) => t.mint)).size === r.tokenAccounts.length, { message: 'one token account per mint' })
  .refine((r) => !r.tokenAccounts.some((t) => t.tokenAccount === r.coldRecoveryWallet), { message: 'a token account cannot be the wallet address itself' });
export type ColdRecoveryRecord = z.infer<typeof ColdRecoveryRecord>;

export async function coldRecoveryDigest(record: ColdRecoveryRecord): Promise<Sha256Hex> {
  return canonicalHash(ColdRecoveryRecord.parse(record));
}

/**
 * The break-glass sweep policy: transfers only, to the pinned destination only.
 *
 * Deliberately narrower than the autonomous policy in every direction — no router, no DEX venue, no
 * lookup tables. A sweep moves what the wallet already holds to one known address; it never swaps,
 * so a route program appearing in one is a sign that something other than a sweep is being signed.
 * Lookup tables are refused outright because an unresolvable destination is exactly the thing this
 * policy exists to prevent.
 *
 * This is one of the three classes D53 permits the break-glass principal. The other two —
 * risk-reducing held-asset swaps and provider vault cancel/withdraw — need their own policy and are
 * not widened into this one.
 */
export function sweepSignerPolicy(record: ColdRecoveryRecord, input: { policyVersion: VersionId; tradingWallet: SolanaAddress }): SignerTransactionPolicy {
  const r = ColdRecoveryRecord.parse(record);
  return SignerTransactionPolicy.parse({
    version: input.policyVersion,
    cluster: r.cluster,
    tradingWallet: input.tradingWallet,
    // Transfers and the accounts they need. No router, no direct-pool venue: a sweep does not trade.
    allowedPrograms: [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM],
    // Native SOL goes to the cold wallet itself; SPL goes to its canonical token accounts.
    allowedTransferRecipients: [r.coldRecoveryWallet],
    allowedSplMints: r.tokenAccounts.map((t) => t.mint),
    allowedSplRecipients: r.tokenAccounts.map((t) => t.tokenAccount),
    allowLookupTables: false,
    maxInstructions: 2 + r.tokenAccounts.length * 2,
  });
}

/** Every address this policy permits value to reach. Nothing else may appear as a destination. */
export function sweepDestinations(record: ColdRecoveryRecord): string[] {
  const r = ColdRecoveryRecord.parse(record);
  return [r.coldRecoveryWallet, ...r.tokenAccounts.map((t) => t.tokenAccount)];
}
