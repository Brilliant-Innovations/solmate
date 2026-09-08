import type { Amount, Bps, DirectPoolHop, MintAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { anchorDiscriminator, ByteReader, concat, findProgramAddress, u64le, utf8 } from './bytes.js';
import { constantProductOut, impactBps, PoolDecodeError, type DecodeContext, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount, type SwapBuildInput } from './types.js';

/**
 * Raydium CPMM (constant product, program CPMMoo8L…). Layouts verified against mainnet accounts
 * on 2026-09-08: PoolState is 637 bytes (8-byte discriminator, ten pubkeys, five u8 fields, then
 * u64 lp_supply / protocol_fees_0 / protocol_fees_1 / fund_fees_0 / fund_fees_1 / open_time);
 * AmmConfig carries trade_fee_rate as a u64 over a 1_000_000 denominator at offset 12. The swap
 * is `swap_base_input(amount_in, minimum_amount_out)` with the thirteen accounts below.
 */

export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const FEE_DENOMINATOR = 1_000_000n;
const AUTH_SEED = utf8('vault_and_lp_mint_auth_seed');
const SWAP_BASE_INPUT = anchorDiscriminator('swap_base_input');

interface CpmmDetail {
  ammConfig: string;
  authority: string;
  token0Vault: string;
  token1Vault: string;
  observationKey: string;
  tradeFeeRate: bigint;
  status: number;
  openTime: bigint;
}

export class RaydiumCpmmAdapter implements DirectPoolAdapter {
  readonly program = 'RAYDIUM_CPMM' as const;
  readonly programId = RAYDIUM_CPMM_PROGRAM;

  requiredAccounts(hop: DirectPoolHop): string[] {
    return [hop.poolAddress];
  }

  dependentAccounts(_hop: DirectPoolHop, pool: RawAccount): string[] {
    const r = new ByteReader(pool.data).seek(8);
    const ammConfig = r.pubkey();
    r.pubkey(); // pool creator
    const token0Vault = r.pubkey();
    const token1Vault = r.pubkey();
    return [ammConfig, token0Vault, token1Vault];
  }

  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[], context: DecodeContext): DecodedPoolState {
    const [pool, config, vault0, vault1] = accounts;
    if (!pool || pool.owner !== this.programId) throw new PoolDecodeError(this.program, `pool ${hop.poolAddress} missing or not owned by ${this.programId}`);
    if (pool.data.length < 8 + 32 * 10 + 5 + 48) throw new PoolDecodeError(this.program, `pool data ${pool.data.length} bytes is too short`);
    const r = new ByteReader(pool.data).seek(8);
    const ammConfig = r.pubkey();
    r.pubkey(); // pool creator
    const token0Vault = r.pubkey();
    const token1Vault = r.pubkey();
    r.pubkey(); // lp mint
    const token0Mint = r.pubkey() as MintAddress;
    const token1Mint = r.pubkey() as MintAddress;
    const token0Program = r.pubkey();
    const token1Program = r.pubkey();
    const observationKey = r.pubkey();
    r.u8(); // auth bump
    const status = r.u8();
    r.skip(3); // lp / mint0 / mint1 decimals
    r.u64(); // lp supply
    const protocolFees0 = r.u64();
    const protocolFees1 = r.u64();
    const fundFees0 = r.u64();
    const fundFees1 = r.u64();
    const openTime = r.u64();
    if (!config || config.owner !== this.programId) throw new PoolDecodeError(this.program, `amm config ${ammConfig} missing`);
    if (config.data.length < 20) throw new PoolDecodeError(this.program, 'amm config too short');
    const tradeFeeRate = new ByteReader(config.data).seek(12).u64();
    if (!vault0 || !vault1) throw new PoolDecodeError(this.program, 'vault account missing');
    const bal0 = decodeTokenAccount(vault0.data).amount;
    const bal1 = decodeTokenAccount(vault1.data).amount;
    const reserveA = bal0 - protocolFees0 - fundFees0;
    const reserveB = bal1 - protocolFees1 - fundFees1;
    // status bit 0 disables deposit, bit 1 withdraw, bit 2 swap (Raydium: 1 << 2 = swap disabled)
    const swapDisabled = (status & 4) !== 0;
    const nowSec = BigInt(Math.floor(context.nowMs / 1000));
    const notOpen = openTime > nowSec;
    const detail: CpmmDetail = { ammConfig, authority: findProgramAddress([AUTH_SEED], this.programId).address, token0Vault, token1Vault, observationKey, tradeFeeRate, status, openTime };
    return {
      program: this.program,
      poolAddress: hop.poolAddress,
      mintA: token0Mint,
      mintB: token1Mint,
      tokenProgramA: token0Program,
      tokenProgramB: token1Program,
      reserveA: reserveA < 0n ? 0n : reserveA,
      reserveB: reserveB < 0n ? 0n : reserveB,
      feeBps: Number((tradeFeeRate * 10_000n) / FEE_DENOMINATOR),
      tradeable: !swapDisabled && !notOpen && reserveA > 0n && reserveB > 0n,
      tradeableReason: swapDisabled ? 'SWAP_DISABLED' : notOpen ? 'NOT_OPEN' : reserveA <= 0n || reserveB <= 0n ? 'EMPTY_RESERVES' : null,
      detail: detail as unknown as Record<string, unknown>,
    };
  }

  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote {
    const d = state.detail as unknown as CpmmDetail;
    const aToB = inputMint === state.mintA;
    if (!aToB && inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${inputMint} is not in pool ${state.poolAddress}`);
    const reserveIn = aToB ? state.reserveA : state.reserveB;
    const reserveOut = aToB ? state.reserveB : state.reserveA;
    // Raydium rounds the fee up (ceil), so the trader never pays less than the rate.
    const fee = (amountIn * d.tradeFeeRate + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
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
    const d = state.detail as unknown as CpmmDetail;
    const aToB = input.inputMint === state.mintA;
    if (!aToB && input.inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${input.inputMint} is not in pool ${state.poolAddress}`);
    const inputVault = aToB ? d.token0Vault : d.token1Vault;
    const outputVault = aToB ? d.token1Vault : d.token0Vault;
    const inputProgram = aToB ? state.tokenProgramA : state.tokenProgramB;
    const outputProgram = aToB ? state.tokenProgramB : state.tokenProgramA;
    const outputMint = aToB ? state.mintB : state.mintA;
    return {
      programId: this.programId,
      accounts: [
        { pubkey: input.user, isSigner: true, isWritable: false },
        { pubkey: d.authority, isSigner: false, isWritable: false },
        { pubkey: d.ammConfig, isSigner: false, isWritable: false },
        { pubkey: state.poolAddress, isSigner: false, isWritable: true },
        { pubkey: input.userSource, isSigner: false, isWritable: true },
        { pubkey: input.userDestination, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: inputProgram, isSigner: false, isWritable: false },
        { pubkey: outputProgram, isSigner: false, isWritable: false },
        { pubkey: input.inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        { pubkey: d.observationKey, isSigner: false, isWritable: true },
      ],
      data: concat(SWAP_BASE_INPUT, u64le(input.amountIn), u64le(input.minimumAmountOut)),
    };
  }
}
