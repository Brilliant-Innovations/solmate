import type { Amount, Bps, DirectPoolHop, MintAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { ByteReader, concat, findProgramAddress, i64le, pk, u32le, u64le, utf8 } from './bytes.js';
import { activeTransferFee, decodeMintExtensions, transferFeeAmount, type TransferFee } from './token2022.js';
import { PoolDecodeError, type DecodeContext, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount, type SwapBuildInput } from './types.js';

/**
 * Meteora DLMM (discretised liquidity bins, program LBUZKhRx…). Layouts taken from the program's
 * published IDL (lb_clmm 0.12.0) and verified against live mainnet accounts on 2026-09-08: the
 * 904-byte LbPair (static parameters at 8, variable parameters at 40, active_id at 76, bin_step at
 * 80, mints and reserves from 88, protocol fee at 216, reward infos at 264, oracle at 552, the
 * 1024-bit bin-array bitmap at 584, token program flags at 880/881) and the 10136-byte BinArray
 * (index i64 at 8, lb_pair at 24, seventy 144-byte bins from 56, price as Q64.64 = (1 +
 * bin_step/10000)^bin_id). The swap is `swap2(amount_in, min_amount_out, remaining_accounts_info)`
 * with the bin arrays the swap will cross passed as remaining accounts; the quote replays the
 * program's bin walk including the dynamic (volatility) fee and limit-order liquidity.
 */

export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SWAP2 = new Uint8Array([65, 75, 63, 76, 235, 91, 91, 136]);
const BINS_PER_ARRAY = 70;
const BITMAP_SIZE = 512; // internal bitmap covers bin-array indexes [-512, 511]
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const BASIS_POINT_MAX = 10_000n;
const SCALE = 1n << 64n;
/** How many bin arrays with liquidity the emergency swap carries in the exit direction. */
const BIN_ARRAYS_FOR_SWAP = 3;

interface StaticParams {
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  baseFeePowerFactor: number;
  functionType: number;
  collectFeeMode: number;
}

interface VariableParams {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: bigint;
}

interface Bin {
  amountX: bigint;
  amountY: bigint;
  price: bigint;
  openOrderAmount: bigint;
  processedOrderRemainingAmount: bigint;
  limitOrderAskSide: boolean;
}

interface LbPairHeader {
  s: StaticParams;
  v: VariableParams;
  activeId: number;
  binStep: number;
  status: number;
  activationType: number;
  tokenX: MintAddress;
  tokenY: MintAddress;
  reserveX: string;
  reserveY: string;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  rewardMintsInitialised: boolean;
  oracle: string;
  bitmap: bigint;
  activationPoint: bigint;
  tokenXProgram: string;
  tokenYProgram: string;
}

interface DlmmDetail extends LbPairHeader {
  bitmapExtension: string | null;
  /** Token-2022 transfer fees in force on each side (null for classic mints or no fee). */
  transferFeeX: TransferFee | null;
  transferFeeY: TransferFee | null;
  /** Bin arrays loaded for the exit direction, by index. */
  binArrays: { index: number; address: string }[];
  bins: Map<number, Bin>;
  nowSec: bigint;
}

export function binArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}

export function deriveBinArray(lbPair: string, index: number): string {
  return findProgramAddress([utf8('bin_array'), pk(lbPair), i64le(BigInt(index))], METEORA_DLMM_PROGRAM).address;
}

export function deriveBitmapExtension(lbPair: string): string {
  return findProgramAddress([utf8('bitmap'), pk(lbPair)], METEORA_DLMM_PROGRAM).address;
}

export function deriveEventAuthority(): string {
  return findProgramAddress([utf8('__event_authority')], METEORA_DLMM_PROGRAM).address;
}

/** Next bin-array index (inclusive of `from`) flagged in the internal bitmap, walking down for X→Y and up for Y→X; null when none inside the bitmap. */
export function nextBinArrayWithLiquidity(bitmap: bigint, from: number, downward: boolean): number | null {
  if (downward) {
    for (let i = Math.min(from, BITMAP_SIZE - 1); i >= -BITMAP_SIZE; i--) if ((bitmap >> BigInt(i + BITMAP_SIZE)) & 1n) return i;
    return null;
  }
  for (let i = Math.max(from, -BITMAP_SIZE); i < BITMAP_SIZE; i++) if ((bitmap >> BigInt(i + BITMAP_SIZE)) & 1n) return i;
  return null;
}

function readHeader(hop: DirectPoolHop, pool: RawAccount): LbPairHeader {
  if (pool.owner !== METEORA_DLMM_PROGRAM) throw new PoolDecodeError('METEORA_DLMM', `pool ${hop.poolAddress} missing or not owned by ${METEORA_DLMM_PROGRAM}`);
  if (pool.data.length !== 904) throw new PoolDecodeError('METEORA_DLMM', `lb pair data is ${pool.data.length} bytes, expected 904`);
  const r = new ByteReader(pool.data).seek(8);
  const s: StaticParams = { baseFactor: r.u16(), filterPeriod: r.u16(), decayPeriod: r.u16(), reductionFactor: r.u16(), variableFeeControl: r.u32(), maxVolatilityAccumulator: r.u32(), minBinId: r.i32(), maxBinId: r.i32(), protocolShare: r.u16(), baseFeePowerFactor: r.u8(), functionType: r.u8(), collectFeeMode: r.u8() };
  r.seek(40);
  const v: VariableParams = { volatilityAccumulator: r.u32(), volatilityReference: r.u32(), indexReference: r.i32(), lastUpdateTimestamp: r.skip(4).i64() };
  r.seek(72);
  r.u8(); // bump seed
  r.u16(); // bin step seed
  r.u8(); // pair type
  const activeId = r.i32();
  const binStep = r.u16();
  const status = r.u8();
  r.u8(); // require base factor seed
  r.u16(); // base factor seed
  const activationType = r.u8();
  r.u8(); // creator pool on/off control
  const tokenX = r.pubkey() as MintAddress;
  const tokenY = r.pubkey() as MintAddress;
  const reserveX = r.pubkey();
  const reserveY = r.pubkey();
  const protocolFeeX = r.u64();
  const protocolFeeY = r.u64();
  r.seek(264);
  const zero = '11111111111111111111111111111111';
  const rewardMint0 = r.pubkey();
  const rewardMint1 = new ByteReader(pool.data).seek(264 + 144).pubkey();
  const oracle = new ByteReader(pool.data).seek(552).pubkey();
  const b = new ByteReader(pool.data).seek(584);
  let bitmap = 0n;
  for (let i = 0; i < 16; i++) bitmap |= b.u64() << BigInt(64 * i);
  const activationPoint = new ByteReader(pool.data).seek(816).u64();
  const flagX = pool.data[880]!;
  const flagY = pool.data[881]!;
  return {
    s, v, activeId, binStep, status, activationType, tokenX, tokenY, reserveX, reserveY, protocolFeeX, protocolFeeY,
    rewardMintsInitialised: rewardMint0 !== zero || rewardMint1 !== zero,
    oracle, bitmap, activationPoint,
    tokenXProgram: flagX === 0 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
    tokenYProgram: flagY === 0 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
  };
}

function readBinArray(account: RawAccount, lbPair: string): { index: number; bins: Map<number, Bin> } {
  if (account.owner !== METEORA_DLMM_PROGRAM || account.data.length !== 10136) throw new PoolDecodeError('METEORA_DLMM', `bin array ${account.address} has ${account.data.length} bytes`);
  const r = new ByteReader(account.data).seek(8);
  const index = Number(r.i64());
  r.seek(24);
  if (r.pubkey() !== lbPair) throw new PoolDecodeError('METEORA_DLMM', `bin array ${account.address} belongs to another pair`);
  const bins = new Map<number, Bin>();
  const lower = index * BINS_PER_ARRAY;
  for (let i = 0; i < BINS_PER_ARRAY; i++) {
    const o = 56 + i * 144;
    const br = new ByteReader(account.data).seek(o);
    const amountX = br.u64();
    const amountY = br.u64();
    const price = br.u128();
    const lo = new ByteReader(account.data).seek(o + 112);
    const openOrderAmount = lo.u64();
    lo.u64(); // total processing order amount
    const processedOrderRemainingAmount = lo.u64();
    lo.u32(); // order age
    const limitOrderAskSide = lo.u8() !== 0;
    bins.set(lower + i, { amountX, amountY, price, openOrderAmount, processedOrderRemainingAmount, limitOrderAskSide });
  }
  return { index, bins };
}

const mulShr = (x: bigint, y: bigint, up: boolean): bigint => {
  const p = x * y;
  const q = p >> 64n;
  return up && (p & (SCALE - 1n)) !== 0n ? q + 1n : q;
};
const shlDiv = (x: bigint, y: bigint, up: boolean): bigint => {
  if (y === 0n) return 0n;
  const p = x << 64n;
  const q = p / y;
  return up && p % y !== 0n ? q + 1n : q;
};
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function baseFee(s: StaticParams, binStep: number): bigint {
  return BigInt(s.baseFactor) * BigInt(binStep) * 10n * 10n ** BigInt(s.baseFeePowerFactor);
}

function totalFee(s: StaticParams, v: VariableParams, binStep: number): bigint {
  let variable = 0n;
  if (s.variableFeeControl > 0) {
    const square = (BigInt(v.volatilityAccumulator) * BigInt(binStep)) ** 2n;
    variable = (BigInt(s.variableFeeControl) * square + 99_999_999_999n) / 100_000_000_000n;
  }
  const total = baseFee(s, binStep) + variable;
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

function updateReference(activeId: number, v: VariableParams, s: StaticParams, nowSec: bigint): void {
  const elapsed = Number(nowSec - v.lastUpdateTimestamp);
  if (elapsed >= s.filterPeriod) {
    v.indexReference = activeId;
    v.volatilityReference = elapsed < s.decayPeriod ? Math.floor((v.volatilityAccumulator * s.reductionFactor) / Number(BASIS_POINT_MAX)) : 0;
  }
}

function updateVolatilityAccumulator(v: VariableParams, s: StaticParams, activeId: number): void {
  const delta = Math.abs(v.indexReference - activeId);
  v.volatilityAccumulator = Math.min(v.volatilityReference + delta * Number(BASIS_POINT_MAX), s.maxVolatilityAccumulator);
}

function fill(bin: Bin, amount: bigint, maxOut: bigint, swapForY: boolean): { amountIn: bigint; amountLeft: bigint; out: bigint } {
  const maxIn = swapForY ? shlDiv(maxOut, bin.price, true) : mulShr(maxOut, bin.price, true);
  if (amount >= maxIn) return { amountIn: maxIn, amountLeft: amount - maxIn, out: maxOut };
  const out = swapForY ? mulShr(amount, bin.price, false) : shlDiv(amount, bin.price, false);
  return { amountIn: amount, amountLeft: 0n, out };
}

/** One bin of the program's exact-in walk (market-making liquidity, then processed and open limit orders on the taker's side). */
function swapAtBin(bin: Bin, amountIn: bigint, swapForY: boolean, supportLimitOrder: boolean, fee: bigint, feeOnInput: boolean): { amountIn: bigint; amountOut: bigint; fee: bigint } {
  let tradingFee = 0n;
  let excludedIn = amountIn;
  if (feeOnInput) {
    tradingFee = ceilDiv(amountIn * fee, FEE_PRECISION);
    excludedIn = amountIn - tradingFee;
  }
  const mm = fill(bin, excludedIn, swapForY ? bin.amountY : bin.amountX, swapForY);
  let totalOut = mm.out;
  let left = mm.amountLeft;
  if (supportLimitOrder && left > 0n) {
    const takerSide = (swapForY && !bin.limitOrderAskSide) || (!swapForY && bin.limitOrderAskSide);
    const processed = fill(bin, left, takerSide ? bin.processedOrderRemainingAmount : 0n, swapForY);
    totalOut += processed.out;
    left = processed.amountLeft;
    if (left > 0n) {
      const open = fill(bin, left, takerSide ? bin.openOrderAmount : 0n, swapForY);
      totalOut += open.out;
      left = open.amountLeft;
    }
  }
  let includedIn = amountIn;
  if (left > 0n) {
    const consumed = excludedIn - left;
    if (feeOnInput) {
      const denominator = FEE_PRECISION - fee;
      includedIn = ceilDiv(consumed * FEE_PRECISION, denominator);
      tradingFee = includedIn - consumed;
    } else includedIn = consumed;
  }
  let excludedOut = totalOut;
  if (!feeOnInput) {
    tradingFee = ceilDiv(totalOut * fee, FEE_PRECISION);
    excludedOut = totalOut - tradingFee;
  }
  return { amountIn: includedIn, amountOut: excludedOut, fee: tradingFee };
}

export class MeteoraDlmmAdapter implements DirectPoolAdapter {
  readonly program = 'METEORA_DLMM' as const;
  readonly programId = METEORA_DLMM_PROGRAM;

  requiredAccounts(hop: DirectPoolHop): string[] {
    return [hop.poolAddress, deriveBitmapExtension(hop.poolAddress)];
  }

  /** Reserves, mints, and the bin arrays with liquidity in the exit direction (active first). */
  dependentAccounts(hop: DirectPoolHop, pool: RawAccount, _first: readonly (RawAccount | null)[] = []): string[] {
    const h = readHeader(hop, pool);
    const swapForY = hop.inputMint === h.tokenX;
    const arrays: number[] = [];
    let idx: number | null = binArrayIndex(h.activeId);
    while (arrays.length < BIN_ARRAYS_FOR_SWAP && idx !== null) {
      const found = nextBinArrayWithLiquidity(h.bitmap, idx, swapForY);
      if (found === null) break;
      arrays.push(found);
      idx = swapForY ? found - 1 : found + 1;
    }
    if (arrays.length === 0) arrays.push(binArrayIndex(h.activeId));
    return [h.reserveX, h.reserveY, h.tokenX, h.tokenY, ...arrays.map((i) => deriveBinArray(hop.poolAddress, i))];
  }

  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[], context: DecodeContext): DecodedPoolState {
    const [pool, bitmapExt, reserveX, reserveY, mintX, mintY, ...arrays] = accounts;
    if (!pool) throw new PoolDecodeError(this.program, `pool ${hop.poolAddress} does not exist`);
    const h = readHeader(hop, pool);
    if (!reserveX || !reserveY) throw new PoolDecodeError(this.program, 'reserve account missing');
    const balX = decodeTokenAccount(reserveX.data).amount;
    const balY = decodeTokenAccount(reserveY.data).amount;
    const bins = new Map<number, Bin>();
    const binArrays: { index: number; address: string }[] = [];
    for (const a of arrays) {
      if (!a) continue;
      const ba = readBinArray(a, hop.poolAddress);
      binArrays.push({ index: ba.index, address: a.address });
      for (const [id, bin] of ba.bins) bins.set(id, bin);
    }
    if (binArrays.length === 0) throw new PoolDecodeError(this.program, 'no bin array could be loaded for the active bin');
    const nowSec = BigInt(Math.floor(context.nowMs / 1000));
    const disabled = h.status !== 0;
    const notOpen = h.activationType === 1 && h.activationPoint > nowSec;
    const extX = decodeMintExtensions(mintX ?? null);
    const extY = decodeMintExtensions(mintY ?? null);
    // a transfer hook needs accounts the emergency path does not carry; a paused or non-transferable mint cannot move at all
    const blocked = extX.transferHook || extY.transferHook ? 'TRANSFER_HOOK_UNSUPPORTED' : extX.nonTransferable || extY.nonTransferable ? 'NON_TRANSFERABLE' : extX.pausable || extY.pausable ? 'PAUSABLE_MINT' : null;
    const detail: DlmmDetail = { ...h, bitmapExtension: bitmapExt && bitmapExt.owner === this.programId ? bitmapExt.address : null, transferFeeX: activeTransferFee(extX, null), transferFeeY: activeTransferFee(extY, null), binArrays, bins, nowSec };
    const reserveA = balX - h.protocolFeeX;
    const reserveB = balY - h.protocolFeeY;
    return {
      program: this.program,
      poolAddress: hop.poolAddress,
      mintA: h.tokenX,
      mintB: h.tokenY,
      tokenProgramA: h.tokenXProgram,
      tokenProgramB: h.tokenYProgram,
      reserveA: reserveA < 0n ? 0n : reserveA,
      reserveB: reserveB < 0n ? 0n : reserveB,
      feeBps: Number((baseFee(h.s, h.binStep) * BASIS_POINT_MAX) / FEE_PRECISION),
      tradeable: !disabled && !notOpen && blocked === null && reserveA > 0n && reserveB > 0n,
      tradeableReason: disabled ? 'PAIR_DISABLED' : notOpen ? 'NOT_OPEN' : blocked ?? (reserveA <= 0n || reserveB <= 0n ? 'EMPTY_RESERVES' : null),
      detail: detail as unknown as Record<string, unknown>,
    };
  }

  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote {
    const d = state.detail as unknown as DlmmDetail;
    const swapForY = inputMint === state.mintA;
    if (!swapForY && inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${inputMint} is not in pool ${state.poolAddress}`);
    const v: VariableParams = { ...d.v };
    updateReference(d.activeId, v, d.s, d.nowSec);
    const supportLimitOrder = d.s.functionType === 2 || (d.s.functionType === 0 && !d.rewardMintsInitialised);
    const feeOnInput = d.s.collectFeeMode === 0 ? true : !swapForY;
    // Token-2022 transfer fees: withheld from the input before the swap and from the output after it
    const transferFeeIn = transferFeeAmount(swapForY ? d.transferFeeX : d.transferFeeY, amountIn);
    let left = amountIn - transferFeeIn;
    let activeId = d.activeId;
    let totalOut = 0n;
    let totalFeePaid = 0n;
    let startBin: Bin | null = null;
    let guard = 0;
    while (left > 0n) {
      const bin = d.bins.get(activeId);
      if (!bin) throw new PoolDecodeError(this.program, `insufficient liquidity within the ${d.binArrays.length} loaded bin array(s) for ${amountIn} in (stopped at bin ${activeId})`);
      const maxOut = swapForY ? bin.amountY + (supportLimitOrder && !bin.limitOrderAskSide ? bin.openOrderAmount + bin.processedOrderRemainingAmount : 0n) : bin.amountX + (supportLimitOrder && bin.limitOrderAskSide ? bin.openOrderAmount + bin.processedOrderRemainingAmount : 0n);
      if (maxOut > 0n) {
        updateVolatilityAccumulator(v, d.s, activeId);
        const r = swapAtBin(bin, left, swapForY, supportLimitOrder, totalFee(d.s, v, d.binStep), feeOnInput);
        if (r.amountIn > 0n) {
          left -= r.amountIn;
          totalOut += r.amountOut;
          totalFeePaid += r.fee;
          startBin ??= bin;
        }
      }
      if (left > 0n) activeId += swapForY ? -1 : 1;
      if (++guard > BINS_PER_ARRAY * BIN_ARRAYS_FOR_SWAP + 1) throw new PoolDecodeError(this.program, 'bin walk exceeded the loaded range');
    }
    if (!startBin) throw new PoolDecodeError(this.program, 'no liquidity at the active bin');
    // impact against the price of the first bin filled, fee excluded, as the program's quote does
    const netIn = amountIn - transferFeeIn;
    const feeAtStart = feeOnInput ? ceilDiv(netIn * totalFee(d.s, v, d.binStep), FEE_PRECISION) : 0n;
    const noSlippageOut = swapForY ? mulShr(netIn - feeAtStart, startBin.price, false) : shlDiv(netIn - feeAtStart, startBin.price, false);
    const impact = noSlippageOut > 0n ? Number(((noSlippageOut - totalOut) * BASIS_POINT_MAX) / noSlippageOut) : 0;
    const transferFeeOut = transferFeeAmount(swapForY ? d.transferFeeY : d.transferFeeX, totalOut);
    return {
      inputMint,
      outputMint: swapForY ? state.mintB : state.mintA,
      inputAmount: amountIn.toString() as Amount,
      expectedOutputAmount: (totalOut - transferFeeOut).toString() as Amount,
      feeAmount: (totalFeePaid + transferFeeIn).toString() as Amount,
      impactBps: Math.max(0, Math.min(10_000, impact)) as Bps,
    };
  }

  swapInstruction(input: SwapBuildInput): DirectPoolInstruction {
    const { state } = input;
    const d = state.detail as unknown as DlmmDetail;
    if (input.inputMint !== state.mintA && input.inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${input.inputMint} is not in pool ${state.poolAddress}`);
    const none = this.programId; // Anchor optional account left empty
    return {
      programId: this.programId,
      accounts: [
        { pubkey: state.poolAddress, isSigner: false, isWritable: true },
        { pubkey: d.bitmapExtension ?? none, isSigner: false, isWritable: d.bitmapExtension !== null },
        { pubkey: d.reserveX, isSigner: false, isWritable: true },
        { pubkey: d.reserveY, isSigner: false, isWritable: true },
        { pubkey: input.userSource, isSigner: false, isWritable: true },
        { pubkey: input.userDestination, isSigner: false, isWritable: true },
        { pubkey: state.mintA, isSigner: false, isWritable: false },
        { pubkey: state.mintB, isSigner: false, isWritable: false },
        { pubkey: d.oracle, isSigner: false, isWritable: true },
        { pubkey: none, isSigner: false, isWritable: false }, // host_fee_in: none
        { pubkey: input.user, isSigner: true, isWritable: false },
        { pubkey: state.tokenProgramA, isSigner: false, isWritable: false },
        { pubkey: state.tokenProgramB, isSigner: false, isWritable: false },
        { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: deriveEventAuthority(), isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        ...d.binArrays.map((b) => ({ pubkey: b.address, isSigner: false, isWritable: true })),
      ],
      // swap2 args: amount_in, min_amount_out, remaining_accounts_info { slices: [] }
      data: concat(SWAP2, u64le(input.amountIn), u64le(input.minimumAmountOut), u32le(0)),
    };
  }
}
