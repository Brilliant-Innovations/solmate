import { z } from 'zod';
import { Amount, Instant, MintAddress, SolanaAddress, SolanaCluster, Uuid } from '../primitives.js';

// §15.12 / §20.23 typed manual funding request ---------------------------------------------------

/**
 * The only operation the browser wallet connector may sign. Destination is resolved from the
 * deployment's configured trading wallet, never from user text; there is no recipient parameter
 * and no reusable signing verb (D46).
 */
export const FundTradingWalletRequest = z.strictObject({
  fundingIntentId: Uuid,
  sourceWallet: SolanaAddress,
  destinationTradingWallet: SolanaAddress,
  destinationAta: SolanaAddress.nullable(),
  fundingMint: MintAddress,
  amount: Amount,
  cluster: SolanaCluster,
  /** Fingerprint of the deployment guardrail the destination was read from (§26.2). */
  destinationFingerprint: z.string().min(8).max(128),
  createdAt: Instant,
  expiresAt: Instant,
});
export type FundTradingWalletRequest = z.infer<typeof FundTradingWalletRequest>;

export const FundingAllowlist = z.strictObject({
  cluster: SolanaCluster,
  tradingWallet: SolanaAddress,
  allowedMints: z.array(MintAddress).min(1),
});
export type FundingAllowlist = z.infer<typeof FundingAllowlist>;
