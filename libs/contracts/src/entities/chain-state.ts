import { z } from 'zod';
import { Amount, Bps, Instant, MintAddress, Slot, SolanaAddress } from '../primitives.js';
import { AuthorityState, ConcentrationMetrics, TokenProgram } from './core.js';

/**
 * Hard token protocol state read directly from Solana (blueprint §7.1A, D45; GUARDRAILS §31
 * "hard token protocol-state security fields are verified from chain truth"). Produced only by
 * libs/solana-hard-state from raw account bytes; analytics providers may corroborate, never
 * override. Every field here is a fact at `slot`, not an opinion.
 */

export const Token2022Extension = z.enum([
  'TRANSFER_FEE_CONFIG',
  'MINT_CLOSE_AUTHORITY',
  'CONFIDENTIAL_TRANSFER_MINT',
  'DEFAULT_ACCOUNT_STATE',
  'NON_TRANSFERABLE',
  'INTEREST_BEARING_CONFIG',
  'PERMANENT_DELEGATE',
  'TRANSFER_HOOK',
  'CONFIDENTIAL_TRANSFER_FEE_CONFIG',
  'METADATA_POINTER',
  'TOKEN_METADATA',
  'GROUP_POINTER',
  'TOKEN_GROUP',
  'GROUP_MEMBER_POINTER',
  'TOKEN_GROUP_MEMBER',
  'CONFIDENTIAL_MINT_BURN',
  'SCALED_UI_AMOUNT',
  'PAUSABLE',
  'UNKNOWN',
]);
export type Token2022Extension = z.infer<typeof Token2022Extension>;

export const LargestTokenAccount = z.object({
  address: SolanaAddress,
  amount: Amount,
});

export const MintChainState = z.object({
  mintAddress: MintAddress,
  readAt: Instant,
  slot: Slot,
  /** Owner program of the mint account. */
  programId: SolanaAddress,
  tokenProgram: TokenProgram,
  isInitialized: z.boolean(),
  decimals: z.number().int().min(0).max(18),
  supply: Amount,
  mintAuthority: AuthorityState,
  freezeAuthority: AuthorityState,
  extensions: z.array(Token2022Extension),
  /** Highest of the older/newer transfer-fee schedules, so the conservative figure is used. */
  transferFeeBps: Bps.nullable(),
  maxTransferFee: Amount.nullable(),
  transferHookProgram: SolanaAddress.nullable(),
  permanentDelegate: SolanaAddress.nullable(),
  /** DefaultAccountState extension set to Frozen: new holders cannot move tokens until thawed. */
  defaultAccountFrozen: z.boolean(),
  nonTransferable: z.boolean(),
  mintCloseAuthority: z.boolean(),
  paused: z.boolean(),
  /** Up to 20 largest token accounts at `slot` (getTokenLargestAccounts). */
  largestAccounts: z.array(LargestTokenAccount).max(20),
  /** Chain-derived top-N concentration over `supply`; analyticsMismatch is decided by the engine. */
  concentration: ConcentrationMetrics,
});
export type MintChainState = z.infer<typeof MintChainState>;

/**
 * Analytics-derived security report (Birdeye /defi/token_security). Corroboration and
 * analytics-only evidence (creator/insider labels, holder clustering); never chain authority.
 */
export const TokenSecurityReport = z.object({
  mintAddress: MintAddress,
  provider: z.literal('BIRDEYE'),
  observedAt: Instant,
  creatorAddress: SolanaAddress.nullable(),
  creatorPercentage: z.number().min(0).max(100).nullable(),
  ownerPercentage: z.number().min(0).max(100).nullable(),
  top10HolderPercent: z.number().min(0).max(100).nullable(),
  top10UserPercent: z.number().min(0).max(100).nullable(),
  metaplexUpdateAuthorityPercent: z.number().min(0).max(100).nullable(),
  mutableMetadata: z.boolean().nullable(),
  freezeable: z.boolean().nullable(),
  freezeAuthority: SolanaAddress.nullable(),
  transferFeeEnabled: z.boolean().nullable(),
  transferFeeBps: Bps.nullable(),
  isToken2022: z.boolean().nullable(),
  nonTransferable: z.boolean().nullable(),
  jupStrictList: z.boolean().nullable(),
  fakeToken: z.boolean().nullable(),
  isTrueToken: z.boolean().nullable(),
  creationAt: Instant.nullable(),
  totalSupply: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).nullable(),
  preMarketHolderCount: z.number().int().nonnegative().nullable(),
});
export type TokenSecurityReport = z.infer<typeof TokenSecurityReport>;
