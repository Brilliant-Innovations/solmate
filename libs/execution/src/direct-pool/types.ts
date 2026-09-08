import type { Amount, Bps, DirectPoolHop, DirectPoolProgram, MintAddress } from '@sol-agent-trader/contracts';

/**
 * One execution contract for every direct-pool family (blueprint §14.6, D33; plan M8b). An
 * adapter turns a persisted hop plus freshly read pool accounts into (a) a local quote for
 * capacity and impact and (b) the swap instruction the executor signs during an emergency. It
 * never fetches anything itself: the caller supplies account data, so the same adapter serves the
 * worker's unsigned dry-run and the executor's real close from identical inputs.
 */

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface DirectPoolInstruction {
  programId: string;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface RawAccount {
  address: string;
  owner: string;
  data: Uint8Array;
  lamports: number;
}

/** What every family exposes after decoding: enough for a constant-product style estimate and for routing checks. */
export interface DecodedPoolState {
  program: DirectPoolProgram;
  poolAddress: string;
  mintA: MintAddress;
  mintB: MintAddress;
  tokenProgramA: string;
  tokenProgramB: string;
  /** Tradeable reserves after protocol/fund fees that live in the vaults but do not back swaps. */
  reserveA: bigint;
  reserveB: bigint;
  /** Fee charged on input, in basis points (rounded up to the nearest 0.01 bp is unnecessary; adapters use exact fractions internally). */
  feeBps: number;
  /** True when the program will accept a swap right now (status flags, open time). */
  tradeable: boolean;
  tradeableReason: string | null;
  /** Family-specific decoded fields the instruction builder needs; opaque to callers. */
  detail: Record<string, unknown>;
}

export interface PoolQuote {
  inputMint: MintAddress;
  outputMint: MintAddress;
  inputAmount: Amount;
  expectedOutputAmount: Amount;
  /** Input taken as fee, in input units. */
  feeAmount: Amount;
  /** Price impact vs the marginal spot price, in bps (0 when the pool is effectively infinite). */
  impactBps: Bps;
}

export interface SwapBuildInput {
  state: DecodedPoolState;
  /** The trading wallet: fee payer, token-account owner and signer. */
  user: string;
  inputMint: MintAddress;
  userSource: string;
  userDestination: string;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export interface DecodeContext {
  /** Wall-clock milliseconds from the caller's Clock; pools with an open time compare against it. */
  nowMs: number;
}

export interface DirectPoolAdapter {
  readonly program: DirectPoolProgram;
  readonly programId: string;
  /**
   * Addresses to fetch before decoding: the pool itself first, then whatever the family needs
   * (config, vaults, market). Callers pass every returned address to `decode` in the same order.
   */
  requiredAccounts(hop: DirectPoolHop): Promise<string[]> | string[];
  /** Pool-dependent accounts that were not knowable before the pool was read (vaults, market accounts, tick arrays). `first` holds the other first-round accounts, in `requiredAccounts` order. */
  dependentAccounts(hop: DirectPoolHop, pool: RawAccount, first: readonly (RawAccount | null)[]): string[];
  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[], context: DecodeContext): DecodedPoolState;
  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote;
  swapInstruction(input: SwapBuildInput): DirectPoolInstruction;
}

export class PoolDecodeError extends Error {
  constructor(readonly program: DirectPoolProgram, message: string) {
    super(`${program}: ${message}`);
    this.name = 'PoolDecodeError';
  }
}

/** Constant-product output for an input after fee; exact bigint arithmetic, floor rounding as the programs do. */
export function constantProductOut(reserveIn: bigint, reserveOut: bigint, amountInAfterFee: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
}

/** Impact in bps of the realised price against the marginal spot price; exact, floor rounding. */
export function impactBps(reserveIn: bigint, reserveOut: bigint, amountInAfterFee: bigint, out: bigint): number {
  if (amountInAfterFee <= 0n || reserveOut <= 0n || reserveIn <= 0n) return 0;
  // spot = reserveOut / reserveIn; realised = out / amountInAfterFee; impact = 1 - realised / spot
  const realisedScaled = out * reserveIn * 10_000n;
  const spotScaled = amountInAfterFee * reserveOut;
  if (spotScaled === 0n) return 0;
  const kept = realisedScaled / spotScaled;
  const bps = 10_000n - kept;
  return Number(bps < 0n ? 0n : bps > 10_000n ? 10_000n : bps);
}
