import type { Amount, Bps, DirectPoolHop, MintAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { TOKEN_PROGRAM } from '../validate/programs.js';
import { ByteReader, concat, createProgramAddress, pk, u64le, utf8 } from './bytes.js';
import { constantProductOut, impactBps, PoolDecodeError, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount, type SwapBuildInput } from './types.js';

/**
 * Raydium AMM v4 (constant product with an OpenBook market, program 675kPX9M…). Layouts verified
 * against mainnet on 2026-09-08: the 752-byte AmmInfo has status/nonce at 0/8, base/quote decimals
 * at 32/40, swap fee numerator/denominator at 176/184 and the pubkey block (base vault, quote
 * vault, base mint, quote mint, lp mint, open orders, market, market program, target orders, …)
 * from offset 336; the 388-byte OpenBook market has vault signer nonce at 45 and the request
 * queue / event queue / bids / asks pubkeys after the vault fields. `swapBaseIn` is instruction 9
 * with (amount_in, minimum_amount_out) and the eighteen accounts below.
 */

export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const AMM_AUTHORITY_SEED = utf8('amm authority');
const SWAP_BASE_IN = 9;
/** Status values in which the program executes swaps (1 initialized, 6 swap only, 7 open); 4 is withdraw-only. */
const SWAP_STATUSES = new Set([1n, 6n, 7n]);

interface AmmV4Detail {
  nonce: bigint;
  authority: string;
  openOrders: string;
  targetOrders: string;
  baseVault: string;
  quoteVault: string;
  marketProgramId: string;
  marketId: string;
  market: { bids: string; asks: string; eventQueue: string; baseVault: string; quoteVault: string; vaultSigner: string };
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
  status: bigint;
}

export class RaydiumAmmV4Adapter implements DirectPoolAdapter {
  readonly program = 'RAYDIUM_AMM_V4' as const;
  readonly programId = RAYDIUM_AMM_V4_PROGRAM;

  requiredAccounts(hop: DirectPoolHop): string[] {
    return [hop.poolAddress];
  }

  dependentAccounts(_hop: DirectPoolHop, pool: RawAccount): string[] {
    const r = new ByteReader(pool.data).seek(336);
    const baseVault = r.pubkey();
    const quoteVault = r.pubkey();
    r.pubkey(); // base mint
    r.pubkey(); // quote mint
    r.pubkey(); // lp mint
    r.pubkey(); // open orders
    const marketId = r.pubkey();
    return [marketId, baseVault, quoteVault];
  }

  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[]): DecodedPoolState {
    const [pool, market, baseVaultAcc, quoteVaultAcc] = accounts;
    if (!pool || pool.owner !== this.programId) throw new PoolDecodeError(this.program, `pool ${hop.poolAddress} missing or not owned by ${this.programId}`);
    if (pool.data.length !== 752) throw new PoolDecodeError(this.program, `pool data is ${pool.data.length} bytes, expected 752`);
    const r = new ByteReader(pool.data);
    const status = r.u64();
    const nonce = r.u64();
    r.seek(176);
    const swapFeeNumerator = r.u64();
    const swapFeeDenominator = r.u64();
    r.seek(336);
    const baseVault = r.pubkey();
    const quoteVault = r.pubkey();
    const baseMint = r.pubkey() as MintAddress;
    const quoteMint = r.pubkey() as MintAddress;
    r.pubkey(); // lp mint
    const openOrders = r.pubkey();
    const marketId = r.pubkey();
    const marketProgramId = r.pubkey();
    const targetOrders = r.pubkey();
    if (!market || market.owner !== marketProgramId) throw new PoolDecodeError(this.program, `market ${marketId} missing or not owned by ${marketProgramId}`);
    if (market.data.length < 5 + 8 + 32 * 5 + 16 + 32 + 24 + 32 * 4) throw new PoolDecodeError(this.program, `market data ${market.data.length} bytes is too short`);
    const m = new ByteReader(market.data).seek(5 + 8 + 32);
    const vaultSignerNonce = m.u64();
    m.pubkey(); // base mint
    m.pubkey(); // quote mint
    const mBaseVault = m.pubkey();
    m.skip(16); // base deposits, base fees
    const mQuoteVault = m.pubkey();
    m.skip(24); // quote deposits, quote fees, dust threshold
    m.pubkey(); // request queue
    const eventQueue = m.pubkey();
    const bids = m.pubkey();
    const asks = m.pubkey();
    const vaultSigner = createProgramAddress([pk(marketId), u64le(vaultSignerNonce)], marketProgramId);
    if (!vaultSigner) throw new PoolDecodeError(this.program, 'market vault signer derivation landed on the curve');
    const authority = createProgramAddress([AMM_AUTHORITY_SEED, new Uint8Array([Number(nonce)])], this.programId);
    if (!authority) throw new PoolDecodeError(this.program, 'amm authority derivation landed on the curve');
    if (!baseVaultAcc || !quoteVaultAcc) throw new PoolDecodeError(this.program, 'vault account missing');
    const reserveA = decodeTokenAccount(baseVaultAcc.data).amount;
    const reserveB = decodeTokenAccount(quoteVaultAcc.data).amount;
    const detail: AmmV4Detail = {
      nonce, authority, openOrders, targetOrders, baseVault, quoteVault, marketProgramId, marketId,
      market: { bids, asks, eventQueue, baseVault: mBaseVault, quoteVault: mQuoteVault, vaultSigner },
      swapFeeNumerator, swapFeeDenominator, status,
    };
    const tradeable = SWAP_STATUSES.has(status) && reserveA > 0n && reserveB > 0n;
    return {
      program: this.program,
      poolAddress: hop.poolAddress,
      mintA: baseMint,
      mintB: quoteMint,
      tokenProgramA: TOKEN_PROGRAM,
      tokenProgramB: TOKEN_PROGRAM,
      reserveA,
      reserveB,
      feeBps: swapFeeDenominator === 0n ? 0 : Number((swapFeeNumerator * 10_000n) / swapFeeDenominator),
      tradeable,
      tradeableReason: !SWAP_STATUSES.has(status) ? `STATUS_${status}` : reserveA <= 0n || reserveB <= 0n ? 'EMPTY_RESERVES' : null,
      detail: detail as unknown as Record<string, unknown>,
    };
  }

  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote {
    const d = state.detail as unknown as AmmV4Detail;
    const aToB = inputMint === state.mintA;
    if (!aToB && inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${inputMint} is not in pool ${state.poolAddress}`);
    const reserveIn = aToB ? state.reserveA : state.reserveB;
    const reserveOut = aToB ? state.reserveB : state.reserveA;
    const fee = d.swapFeeDenominator === 0n ? 0n : (amountIn * d.swapFeeNumerator + d.swapFeeDenominator - 1n) / d.swapFeeDenominator;
    const afterFee = amountIn - fee;
    const out = constantProductOut(reserveIn, reserveOut, afterFee);
    return {
      inputMint,
      outputMint: aToB ? state.mintB : state.mintA,
      inputAmount: amountIn.toString() as Amount,
      expectedOutputAmount: out.toString() as Amount,
      feeAmount: fee.toString() as Amount,
      impactBps: impactBps(reserveIn, reserveOut, afterFee, out) as Bps,
    };
  }

  swapInstruction(input: SwapBuildInput): DirectPoolInstruction {
    const { state } = input;
    const d = state.detail as unknown as AmmV4Detail;
    if (input.inputMint !== state.mintA && input.inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${input.inputMint} is not in pool ${state.poolAddress}`);
    return {
      programId: this.programId,
      accounts: [
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: state.poolAddress, isSigner: false, isWritable: true },
        { pubkey: d.authority, isSigner: false, isWritable: false },
        { pubkey: d.openOrders, isSigner: false, isWritable: true },
        { pubkey: d.targetOrders, isSigner: false, isWritable: true },
        { pubkey: d.baseVault, isSigner: false, isWritable: true },
        { pubkey: d.quoteVault, isSigner: false, isWritable: true },
        { pubkey: d.marketProgramId, isSigner: false, isWritable: false },
        { pubkey: d.marketId, isSigner: false, isWritable: true },
        { pubkey: d.market.bids, isSigner: false, isWritable: true },
        { pubkey: d.market.asks, isSigner: false, isWritable: true },
        { pubkey: d.market.eventQueue, isSigner: false, isWritable: true },
        { pubkey: d.market.baseVault, isSigner: false, isWritable: true },
        { pubkey: d.market.quoteVault, isSigner: false, isWritable: true },
        { pubkey: d.market.vaultSigner, isSigner: false, isWritable: false },
        { pubkey: input.userSource, isSigner: false, isWritable: true },
        { pubkey: input.userDestination, isSigner: false, isWritable: true },
        { pubkey: input.user, isSigner: true, isWritable: false },
      ],
      data: concat(new Uint8Array([SWAP_BASE_IN]), u64le(input.amountIn), u64le(input.minimumAmountOut)),
    };
  }
}
