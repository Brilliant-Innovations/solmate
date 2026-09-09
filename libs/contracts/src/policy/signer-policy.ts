import { z } from 'zod';
import { canonicalHash } from '../signing/canonical.js';
import { MintAddress, Sha256Hex, SolanaAddress, SolanaCluster, VersionId } from '../primitives.js';

/**
 * The signer-side transaction policy (blueprint D55, §15.7A, ADR-0008). This is the **second**
 * layer: the executor's own structural and simulation checks are the first, and D55 requires a
 * transaction-aware policy enforced *outside* the executor so a compromised executor host cannot
 * decide what the non-exportable key signs.
 *
 * One artifact, two consumers, so the two cannot drift:
 *
 *   - `renderTurnkeyPolicy` produces the exact condition expressions pinned at the provider. That
 *     is what actually enforces the policy — nothing in this repository can.
 *   - `libs/execution`'s evaluator mirrors the same rules locally, so a request the provider would
 *     refuse is refused before it is ever sent, and so ADR-0008's Probe A cases (b) supported-shape
 *     acceptance, (c) malicious-shape rejection and (d) lookup-table compatibility are contract
 *     tests rather than a live-only discovery.
 *
 * `signerPolicyDigest` is what Live Readiness pins and what `SignerHealth.policyDigest` reports, so
 * a policy edited at the provider without a matching Release stops being the policy we attested.
 *
 * Two provider facts shape this artifact and are not negotiable design choices:
 *
 *   1. Turnkey does not resolve accounts loaded through an address lookup table. They surface as
 *      the literal `ADDRESS_TABLE_LOOKUP`, so a transfer *to* such an account can never be
 *      allowlisted — its destination is unknowable at policy time and it is always denied. Program
 *      addresses reached through a lookup table are rejected by Turnkey outright.
 *   2. A token mint is policy-visible only for `TransferChecked` and `TransferCheckedWithFee`. A
 *      plain SPL `Transfer` therefore cannot satisfy a mint constraint and is denied by
 *      construction — which is the fail-closed behaviour we want, not an omission.
 */

export const SignerTransactionPolicy = z.strictObject({
  version: VersionId,
  /** The policy is pinned to one cluster; a transaction for any other is not this deployment's. */
  cluster: SolanaCluster,
  /** The only fee payer and the only required signer a normal autonomous signature may carry. */
  tradingWallet: SolanaAddress,
  /** Deny by default: only these programs may be invoked, and only as static account keys. */
  allowedPrograms: z.array(SolanaAddress).min(1),
  /** Native SOL transfer recipients. Empty means the shape set permits no bare SOL transfer at all. */
  allowedTransferRecipients: z.array(SolanaAddress),
  /** Mints the wallet may move. A transfer whose mint is not policy-visible fails this by construction. */
  allowedSplMints: z.array(MintAddress),
  /**
   * Break-glass only: permit any mint, with the destination constraint doing the work.
   *
   * An incident has to be able to sell whatever the wallet actually holds, which may include mints
   * no Release ever enabled, so an allowlist cannot be written in advance. Dropping the mint
   * constraint is safe *only* because `allowedSplRecipients` still pins every destination to an
   * account we own: the mint of a transfer into our own account does not change who ends up with
   * the value. `TransferChecked` is still required, so the mint appears in the provider's incident
   * log even though it is not constrained.
   *
   * The autonomous builders never set this. `profile2SignerPolicy` and `sweepSignerPolicy` both
   * enumerate their mints.
   */
  anySplMint: z.boolean().default(false),
  /** Token accounts an SPL transfer may credit: the wallet's own accounts and the registered custody set. */
  allowedSplRecipients: z.array(SolanaAddress),
  /** Whether the shape set uses lookup tables for account loading at all (a program via one is always denied). */
  allowLookupTables: z.boolean(),
  /** Upper bound on instruction count; a route that needs more is requoted, not signed. */
  maxInstructions: z.number().int().positive(),
});
export type SignerTransactionPolicy = z.infer<typeof SignerTransactionPolicy>;

/** The literal Turnkey substitutes for an account it cannot resolve through a lookup table. */
export const ADDRESS_TABLE_LOOKUP = 'ADDRESS_TABLE_LOOKUP';

export async function signerPolicyDigest(policy: SignerTransactionPolicy): Promise<Sha256Hex> {
  return canonicalHash(SignerTransactionPolicy.parse(policy));
}

export interface TurnkeyPolicy {
  name: string;
  effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  condition: string;
  /** Why this clause exists, carried into the provider console so a reviewer sees the reason. */
  note: string;
}

const list = (xs: readonly string[]): string => `[${xs.map((x) => `'${x}'`).join(', ')}]`;

/**
 * The policy set to pin at the provider, deny-by-default: the organisation grants the autonomous
 * principal nothing, one ALLOW admits exactly the approved shape, and the explicit DENY rules make
 * the lookup-table cases visible to a human reviewer instead of resting on the ALLOW's silence.
 *
 * Raw-message signing is denied by granting the principal no raw-signing activity at all, which is
 * an organisation configuration rather than a condition, and is verified by Probe A case (a)
 * alongside deny-export.
 */
export function renderTurnkeyPolicy(policy: SignerTransactionPolicy): TurnkeyPolicy[] {
  const p = SignerTransactionPolicy.parse(policy);
  const allow: string[] = [
    `solana.tx.fee_payer == '${p.tradingWallet}'`,
    `solana.tx.program_keys.all(k, k in ${list(p.allowedPrograms)})`,
    `solana.tx.instructions.count() <= ${p.maxInstructions}`,
    p.allowedTransferRecipients.length === 0
      ? 'solana.tx.transfers.count() == 0'
      : `solana.tx.transfers.all(t, t.from == '${p.tradingWallet}' && t.to in ${list(p.allowedTransferRecipients)})`,
    p.anySplMint
      ? `solana.tx.spl_transfers.all(t, t.owner == '${p.tradingWallet}' && t.to in ${list(p.allowedSplRecipients)})`
      : p.allowedSplMints.length === 0
        ? 'solana.tx.spl_transfers.count() == 0'
        : `solana.tx.spl_transfers.all(t, t.owner == '${p.tradingWallet}' && t.token_mint in ${list(p.allowedSplMints)} && t.to in ${list(p.allowedSplRecipients)})`,
  ];
  if (!p.allowLookupTables) allow.push('solana.tx.address_table_lookups.count() == 0');

  return [
    {
      name: `solmate-autonomous-swap-${p.version}`,
      effect: 'EFFECT_ALLOW',
      condition: allow.join(' && '),
      note: 'The only shape the autonomous principal may sign: our wallet pays and signs, every program is on the allowlist as a static key, and every value movement lands on an account we already own or have registered as custody.',
    },
    {
      name: `solmate-deny-sol-to-lookup-${p.version}`,
      effect: 'EFFECT_DENY',
      condition: `solana.tx.transfers.any(t, t.to == '${ADDRESS_TABLE_LOOKUP}')`,
      note: 'A SOL transfer whose destination arrives through a lookup table has no policy-visible recipient. It cannot be allowlisted and is never signed (D55).',
    },
    {
      name: `solmate-deny-spl-to-lookup-${p.version}`,
      effect: 'EFFECT_DENY',
      condition: `solana.tx.spl_transfers.any(t, t.to == '${ADDRESS_TABLE_LOOKUP}' || t.token_mint == '${ADDRESS_TABLE_LOOKUP}')`,
      note: 'Same for SPL: an unresolvable destination or mint means the transfer is unknowable at policy time.',
    },
  ];
}

/**
 * The Profile 2 shape set of ADR-0007, expressed as a policy: Jupiter `/order` swaps between the
 * settlement mint and the held asset, plus the base programs those routes touch. Direct-pool
 * emergency shapes are added by name once M8b's adapters are part of an armed Release; nothing
 * widens the set at run time.
 */
export function profile2SignerPolicy(input: {
  version: VersionId;
  cluster: SolanaCluster;
  tradingWallet: SolanaAddress;
  /** Router and route-venue programs the Release enables, on top of the base set. */
  routePrograms: readonly SolanaAddress[];
  basePrograms: readonly SolanaAddress[];
  settlementMint: MintAddress;
  heldMints: readonly MintAddress[];
  /** The wallet's own token accounts and the registered custody set. */
  ownedTokenAccounts: readonly SolanaAddress[];
  allowLookupTables: boolean;
  maxInstructions?: number;
}): SignerTransactionPolicy {
  return SignerTransactionPolicy.parse({
    version: input.version,
    cluster: input.cluster,
    tradingWallet: input.tradingWallet,
    allowedPrograms: [...new Set([...input.basePrograms, ...input.routePrograms])],
    // A swap moves value through token accounts, never as a bare SOL transfer out of the wallet.
    // Rent and fees are paid by the fee payer, which is not a `transfers` entry.
    allowedTransferRecipients: [],
    allowedSplMints: [...new Set([input.settlementMint, ...input.heldMints])],
    allowedSplRecipients: [...new Set(input.ownedTokenAccounts)],
    allowLookupTables: input.allowLookupTables,
    maxInstructions: input.maxInstructions ?? 12,
  });
}
