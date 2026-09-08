import type { Amount, Bps, DirectPoolHop, MintAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { ByteReader, concat, findProgramAddress, i32be, pk, u64le, u128le, utf8 } from './bytes.js';
import { activeTransferFee, decodeMintExtensions, transferFeeAmount, type TransferFee } from './token2022.js';
import { PoolDecodeError, type DecodeContext, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount, type SwapBuildInput } from './types.js';

/**
 * Raydium CLMM (concentrated liquidity, program CAMMCzo5…). Layouts follow the published
 * raydium_clmm IDL and the program sources, verified against a live pool on 2026-09-08: the
 * 1544-byte PoolState (config at 9, mints/vaults from 73, tick spacing at 235, liquidity at 237,
 * sqrt price Q64.64 at 253, current tick at 269, protocol fees at 309, status at 389, fee side at
 * 390, the 1024-bit tick-array bitmap at 904, fund fees at 1064, open time at 1080, dynamic fee
 * info at 1096), the 10240-byte TickArrayState (start tick at 40, sixty 168-byte ticks from 44)
 * and the 1832-byte bitmap extension. The quote replays the program's swap loop (Uniswap-v3 style
 * sqrt-price steps with the program's exact rounding, tick crossings, fee-on-input or fee-on-side,
 * dynamic volatility fee) and the swap is `swap_v2` with the bitmap extension and tick arrays as
 * remaining accounts. Ticks carrying limit orders are refused rather than approximated.
 */

export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SWAP_V2 = new Uint8Array([43, 4, 237, 11, 26, 201, 30, 98]);
const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_LEN = 10240;
const TICK_LEN = 168;
const BITMAP_EXT_LEN = 8 + 32 + 64 * 14 * 2;
const BITMAP_SIZE = 512;
const FEE_DENOM = 1_000_000n;
const MAX_FEE_RATE_NUMERATOR = 100_000n;
const DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000n;
const VOLATILITY_ACCUMULATOR_SCALE = 10_000n;
const REDUCTION_FACTOR_DENOMINATOR = 10_000n;
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE_X64 = 4295048016n;
export const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const Q64 = 1n << 64n;
/** Tick arrays the emergency swap carries in the exit direction. */
const TICK_ARRAYS_FOR_SWAP = 3;

interface DynamicFee {
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  dynamicFeeControl: number;
  maxVolatilityAccumulator: number;
  tickSpacingIndexReference: number;
  volatilityReference: number;
  volatilityAccumulator: number;
  lastUpdateTimestamp: bigint;
}

interface PoolHeader {
  ammConfig: string;
  mint0: MintAddress;
  mint1: MintAddress;
  vault0: string;
  vault1: string;
  observation: string;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
  status: number;
  feeOn: number;
  bitmap: bigint;
  openTime: bigint;
  dynamicFee: DynamicFee | null;
}

interface Tick {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  hasLimitOrders: boolean;
}

interface TickArray {
  address: string;
  startTick: number;
  ticks: Tick[];
}

interface ClmmDetail extends PoolHeader {
  tradeFeeRate: bigint;
  tickArrays: TickArray[];
  bitmapExtension: string | null;
  extension: { positive: bigint[]; negative: bigint[] } | null;
  transferFee0: TransferFee | null;
  transferFee1: TransferFee | null;
  tokenProgram0: string;
  tokenProgram1: string;
  nowSec: bigint;
}

// --- tick math (program: libraries/tick_math.rs) ---------------------------------------------------
const MAGIC: [number, bigint][] = [
  [0x2, 0xfff97272373d4000n], [0x4, 0xfff2e50f5f657000n], [0x8, 0xffe5caca7e10f000n], [0x10, 0xffcb9843d60f7000n], [0x20, 0xff973b41fa98e800n], [0x40, 0xff2ea16466c9b000n],
  [0x80, 0xfe5dee046a9a3800n], [0x100, 0xfcbe86c7900bb000n], [0x200, 0xf987a7253ac65800n], [0x400, 0xf3392b0822bb6000n], [0x800, 0xe7159475a2caf000n], [0x1000, 0xd097f3bdfd2f2000n],
  [0x2000, 0xa9f746462d9f8000n], [0x4000, 0x70d869a156f31c00n], [0x8000, 0x31be135f97ed3200n], [0x10000, 0x9aa508b5b85a500n], [0x20000, 0x5d6af8dedc582cn], [0x40000, 0x2216e584f5fan],
];

export function sqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick} out of range`);
  const abs = Math.abs(tick);
  let ratio = abs & 1 ? 0xfffcb933bd6fb800n : Q64;
  for (const [bit, m] of MAGIC) if (abs & bit) ratio = (ratio * m) >> 64n;
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}

export function tickAtSqrtPrice(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) throw new RangeError('sqrt price out of range');
  const msb = sqrtPriceX64.toString(2).length - 1;
  const log2pIntegerX32 = BigInt(msb - 64) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let precision = 0;
  let log2pFractionX64 = 0n;
  let r = msb >= 64 ? sqrtPriceX64 >> BigInt(msb - 63) : sqrtPriceX64 << BigInt(63 - msb);
  while (bit > 0n && precision < 16) {
    r = r * r;
    const more = r >> 127n;
    r >>= 63n + more;
    log2pFractionX64 += bit * more;
    bit >>= 1n;
    precision++;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  const logSqrt10001X64 = log2pX32 * 59543866431248n;
  const tickLow = Number((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return sqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

// --- sqrt price / delta math with the program's rounding ------------------------------------------
const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;
const divCeil = (a: bigint, d: bigint): bigint => (a + d - 1n) / d;

function nextSqrtPriceFromAmount0RoundingUp(sqrtPrice: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPrice;
  const numerator1 = liquidity << 64n;
  if (add) {
    const product = amount * sqrtPrice;
    const denominator = numerator1 + product;
    if (denominator >= numerator1) return mulDivCeil(numerator1, sqrtPrice, denominator);
    return divCeil(numerator1, numerator1 / sqrtPrice + amount);
  }
  const product = amount * sqrtPrice;
  const denominator = numerator1 - product;
  if (denominator <= 0n) throw new RangeError('sqrt price underflow');
  return mulDivCeil(numerator1, sqrtPrice, denominator);
}

function nextSqrtPriceFromAmount1RoundingDown(sqrtPrice: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPrice;
  if (add) return sqrtPrice + (amount << 64n) / liquidity;
  return sqrtPrice - divCeil(amount << 64n, liquidity);
}

function nextSqrtPriceFromInput(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (liquidity <= 0n) throw new RangeError('zero liquidity');
  return zeroForOne ? nextSqrtPriceFromAmount0RoundingUp(sqrtPrice, liquidity, amountIn, true) : nextSqrtPriceFromAmount1RoundingDown(sqrtPrice, liquidity, amountIn, true);
}

/** (amount_in, amount_out) to move between two sqrt prices at constant liquidity, rounded as the program does. */
function deltaAmountsForSwap(a: bigint, b: bigint, liquidity: bigint, zeroForOne: boolean): { amountIn: bigint; amountOut: bigint } {
  let lo = a;
  let hi = b;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo <= 0n) throw new RangeError('zero sqrt price');
  const amount1X64 = liquidity * (hi - lo);
  const sqrtProduct = lo * hi;
  if (zeroForOne) {
    const amountIn = divCeil(amount1X64 << 64n, sqrtProduct);
    const amountOut = amount1X64 >> 64n;
    return { amountIn, amountOut };
  }
  const amountIn = (amount1X64 + U64_MAX) >> 64n;
  const amountOut = (amount1X64 << 64n) / sqrtProduct;
  return { amountIn, amountOut };
}

interface StepResult {
  sqrtPriceNext: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/** One exact-in step towards a target price (program: swap_math::compute_swap with is_base_input = true). */
function computeSwapStep(sqrtPriceCurrent: bigint, sqrtPriceTarget: bigint, liquidity: bigint, amountRemaining: bigint, feeRate: bigint, zeroForOne: boolean, feeOnInput: boolean): StepResult {
  const amountForPrice = feeOnInput ? mulDivFloor(amountRemaining, FEE_DENOM - feeRate, FEE_DENOM) : amountRemaining;
  let reached: { amountIn: bigint; amountOut: bigint } | null = null;
  try {
    const atTarget = deltaAmountsForSwap(sqrtPriceTarget, sqrtPriceCurrent, liquidity, zeroForOne);
    if (atTarget.amountIn <= U64_MAX && atTarget.amountOut <= U64_MAX && amountForPrice >= atTarget.amountIn) reached = atTarget;
  } catch {
    reached = null;
  }
  let sqrtPriceNext: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  if (reached) {
    sqrtPriceNext = sqrtPriceTarget;
    amountIn = reached.amountIn;
    amountOut = reached.amountOut;
  } else {
    sqrtPriceNext = nextSqrtPriceFromInput(sqrtPriceCurrent, liquidity, amountForPrice, zeroForOne);
    const d = deltaAmountsForSwap(sqrtPriceNext, sqrtPriceCurrent, liquidity, zeroForOne);
    amountIn = d.amountIn;
    amountOut = d.amountOut;
  }
  let feeAmount: bigint;
  if (feeOnInput) {
    feeAmount = sqrtPriceNext !== sqrtPriceTarget ? amountRemaining - amountIn : mulDivCeil(amountIn, feeRate, FEE_DENOM - feeRate);
  } else {
    feeAmount = mulDivCeil(amountOut, feeRate, FEE_DENOM);
    amountOut -= feeAmount;
    if (sqrtPriceNext !== sqrtPriceTarget) amountIn = amountRemaining;
  }
  return { sqrtPriceNext, amountIn, amountOut, feeAmount };
}

// --- tick arrays and bitmaps ----------------------------------------------------------------------
export function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  let start = Math.trunc(tick / span);
  if (tick < 0 && tick % span !== 0) start -= 1;
  return start * span;
}

export function deriveTickArray(pool: string, startTick: number): string {
  return findProgramAddress([utf8('tick_array'), pk(pool), i32be(startTick)], RAYDIUM_CLMM_PROGRAM).address;
}

export function deriveClmmBitmapExtension(pool: string): string {
  return findProgramAddress([utf8('pool_tick_array_bitmap_extension'), pk(pool)], RAYDIUM_CLMM_PROGRAM).address;
}

const maxTickInBitmap = (tickSpacing: number): number => tickSpacing * TICK_ARRAY_SIZE * BITMAP_SIZE;

/** Position of a tick array inside the default 1024-bit bitmap, or null when it lives in the extension. */
function defaultBitmapBit(startTick: number, tickSpacing: number): number | null {
  const boundary = maxTickInBitmap(tickSpacing);
  if (startTick < -boundary || startTick >= boundary) return null;
  return startTick / (TICK_ARRAY_SIZE * tickSpacing) + BITMAP_SIZE;
}

function extensionWord(ext: { positive: bigint[]; negative: bigint[] }, startTick: number, tickSpacing: number): { word: bigint; bit: number } | null {
  const perBitmap = maxTickInBitmap(tickSpacing);
  let offset = Math.trunc(Math.abs(startTick) / perBitmap) - 1;
  if (startTick < 0 && Math.abs(startTick) % perBitmap === 0) offset -= 1;
  if (offset < 0 || offset >= 14) return null;
  const word = startTick < 0 ? ext.negative[offset]! : ext.positive[offset]!;
  const m = Math.abs(startTick) % perBitmap;
  let bit = Math.trunc(m / (TICK_ARRAY_SIZE * tickSpacing));
  if (startTick < 0 && m !== 0) bit = BITMAP_SIZE - bit;
  return { word, bit };
}

function isTickArrayInitialised(h: PoolHeader, ext: ClmmDetail['extension'], startTick: number): boolean | null {
  const bit = defaultBitmapBit(startTick, h.tickSpacing);
  if (bit !== null) return ((h.bitmap >> BigInt(bit)) & 1n) === 1n;
  if (!ext) return null;
  const w = extensionWord(ext, startTick, h.tickSpacing);
  return w ? ((w.word >> BigInt(w.bit)) & 1n) === 1n : false;
}

/** Next initialised tick-array start strictly after `from` in the swap direction, searching the default bitmap and then the extension; null when none. */
export function nextInitialisedTickArray(h: PoolHeader, ext: ClmmDetail['extension'], from: number, zeroForOne: boolean): number | null {
  const span = TICK_ARRAY_SIZE * h.tickSpacing;
  const minStart = tickArrayStartIndex(MIN_TICK, h.tickSpacing);
  const maxStart = tickArrayStartIndex(MAX_TICK, h.tickSpacing);
  let s = zeroForOne ? from - span : from + span;
  // bounded linear walk: the bitmaps cover at most 15 × 512 arrays per side and real pools are far sparser
  let guard = 0;
  while (s >= minStart && s <= maxStart && guard++ < 15 * BITMAP_SIZE) {
    const init = isTickArrayInitialised(h, ext, s);
    if (init === null) return null; // extension needed but not loaded
    if (init) return s;
    s += zeroForOne ? -span : span;
  }
  return null;
}

function readHeader(hop: DirectPoolHop, pool: RawAccount): PoolHeader {
  if (pool.owner !== RAYDIUM_CLMM_PROGRAM) throw new PoolDecodeError('RAYDIUM_CLMM', `pool ${hop.poolAddress} missing or not owned by ${RAYDIUM_CLMM_PROGRAM}`);
  if (pool.data.length !== 1544) throw new PoolDecodeError('RAYDIUM_CLMM', `pool data is ${pool.data.length} bytes, expected 1544`);
  const r = new ByteReader(pool.data).seek(9);
  const ammConfig = r.pubkey();
  r.pubkey(); // owner
  const mint0 = r.pubkey() as MintAddress;
  const mint1 = r.pubkey() as MintAddress;
  const vault0 = r.pubkey();
  const vault1 = r.pubkey();
  const observation = r.pubkey();
  r.skip(2); // decimals
  const tickSpacing = r.u16();
  const liquidity = r.u128();
  const sqrtPriceX64 = r.u128();
  const tickCurrent = r.i32();
  r.seek(309);
  const protocolFees0 = r.u64();
  const protocolFees1 = r.u64();
  const status = pool.data[389]!;
  const feeOn = pool.data[390]!;
  const b = new ByteReader(pool.data).seek(904);
  let bitmap = 0n;
  for (let i = 0; i < 16; i++) bitmap |= b.u64() << BigInt(64 * i);
  const f = new ByteReader(pool.data).seek(1064);
  const fundFees0 = f.u64();
  const fundFees1 = f.u64();
  const openTime = f.u64();
  const d = new ByteReader(pool.data).seek(1096);
  const dyn: DynamicFee = { filterPeriod: d.u16(), decayPeriod: d.u16(), reductionFactor: d.u16(), dynamicFeeControl: d.u32(), maxVolatilityAccumulator: d.u32(), tickSpacingIndexReference: d.i32(), volatilityReference: d.u32(), volatilityAccumulator: d.u32(), lastUpdateTimestamp: d.u64() };
  const dynamicFee = dyn.filterPeriod === 0 && dyn.decayPeriod === 0 && dyn.reductionFactor === 0 && dyn.dynamicFeeControl === 0 && dyn.maxVolatilityAccumulator === 0 && dyn.tickSpacingIndexReference === 0 && dyn.volatilityReference === 0 && dyn.volatilityAccumulator === 0 && dyn.lastUpdateTimestamp === 0n ? null : dyn;
  return { ammConfig, mint0, mint1, vault0, vault1, observation, tickSpacing, liquidity, sqrtPriceX64, tickCurrent, protocolFees0, protocolFees1, fundFees0, fundFees1, status, feeOn, bitmap, openTime, dynamicFee };
}

function readTickArray(account: RawAccount, pool: string): TickArray {
  if (account.owner !== RAYDIUM_CLMM_PROGRAM || account.data.length !== TICK_ARRAY_LEN) throw new PoolDecodeError('RAYDIUM_CLMM', `tick array ${account.address} has ${account.data.length} bytes`);
  const r = new ByteReader(account.data).seek(8);
  if (r.pubkey() !== pool) throw new PoolDecodeError('RAYDIUM_CLMM', `tick array ${account.address} belongs to another pool`);
  const startTick = r.i32();
  const ticks: Tick[] = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    const t = new ByteReader(account.data).seek(44 + i * TICK_LEN);
    const tick = t.i32();
    const liquidityNet = BigInt.asIntN(128, t.u128());
    const liquidityGross = t.u128();
    const o = new ByteReader(account.data).seek(44 + i * TICK_LEN + 124);
    const ordersAmount = o.u64();
    o.u64(); // part-filled orders remaining follows
    const partFilled = new ByteReader(account.data).seek(44 + i * TICK_LEN + 132).u64();
    ticks.push({ tick, liquidityNet, liquidityGross, hasLimitOrders: ordersAmount > 0n || partFilled > 0n });
  }
  return { address: account.address, startTick, ticks };
}

const tickSpacingIndexFromTick = (tick: number, spacing: number): number => (tick % spacing === 0 || tick >= 0 ? Math.trunc(tick / spacing) : Math.trunc(tick / spacing) - 1);

function dynamicFeeRate(dyn: DynamicFee, tickSpacing: number): bigint {
  const crossed = BigInt(dyn.volatilityAccumulator) * BigInt(tickSpacing);
  const squared = crossed * crossed;
  const denominator = DYNAMIC_FEE_CONTROL_DENOMINATOR * VOLATILITY_ACCUMULATOR_SCALE * VOLATILITY_ACCUMULATOR_SCALE;
  const rate = mulDivCeil(BigInt(dyn.dynamicFeeControl), squared, denominator);
  return rate > MAX_FEE_RATE_NUMERATOR ? MAX_FEE_RATE_NUMERATOR : rate;
}

/** The 1832-byte TickArrayBitmapExtension (positive and negative halves of fourteen 512-bit words each); null when the account does not exist. */
function parseBitmapExtension(acc: RawAccount | null): ClmmDetail['extension'] {
  if (!acc || acc.owner !== RAYDIUM_CLMM_PROGRAM || acc.data.length !== BITMAP_EXT_LEN) return null;
  const e = new ByteReader(acc.data).seek(40);
  const read = (): bigint[] => {
    const out: bigint[] = [];
    for (let i = 0; i < 14; i++) {
      let w = 0n;
      for (let j = 0; j < 8; j++) w |= e.u64() << BigInt(64 * j);
      out.push(w);
    }
    return out;
  };
  const positive = read();
  const negative = read();
  return { positive, negative };
}

export class RaydiumClmmAdapter implements DirectPoolAdapter {
  readonly program = 'RAYDIUM_CLMM' as const;
  readonly programId = RAYDIUM_CLMM_PROGRAM;

  /** The pool and its bitmap-extension slot: both are needed before the first tick array can be chosen. */
  requiredAccounts(hop: DirectPoolHop): string[] {
    return [hop.poolAddress, deriveClmmBitmapExtension(hop.poolAddress)];
  }

  /** Config, vaults, mints, then the tick arrays the exit will cross (first the one holding the current tick when initialised). */
  dependentAccounts(hop: DirectPoolHop, pool: RawAccount, first: readonly (RawAccount | null)[]): string[] {
    const h = readHeader(hop, pool);
    const ext = parseBitmapExtension(first[0] ?? null);
    const zeroForOne = hop.inputMint === h.mint0;
    const starts: number[] = [];
    const current = tickArrayStartIndex(h.tickCurrent, h.tickSpacing);
    const init = isTickArrayInitialised(h, ext, current);
    let cursor = current;
    if (init === true) starts.push(current);
    else if (init === null) starts.push(current); // no extension account exists yet: carry the current array and let the program judge
    else {
      // the current array is empty: the program's first array is the next initialised one in the swap direction
      const firstInit = nextInitialisedTickArray(h, ext, cursor, zeroForOne);
      if (firstInit !== null) {
        starts.push(firstInit);
        cursor = firstInit;
      }
    }
    while (starts.length < TICK_ARRAYS_FOR_SWAP) {
      const next = nextInitialisedTickArray(h, ext, cursor, zeroForOne);
      if (next === null) break;
      starts.push(next);
      cursor = next;
    }
    return [h.ammConfig, h.vault0, h.vault1, h.mint0, h.mint1, ...starts.map((s) => deriveTickArray(hop.poolAddress, s))];
  }

  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[], context: DecodeContext): DecodedPoolState {
    const [pool, bitmapExt, config, vault0, vault1, mint0Acc, mint1Acc, ...arrays] = accounts;
    if (!pool) throw new PoolDecodeError(this.program, `pool ${hop.poolAddress} does not exist`);
    const h = readHeader(hop, pool);
    if (!config || config.owner !== this.programId || config.data.length < 57) throw new PoolDecodeError(this.program, `amm config ${h.ammConfig} missing`);
    const tradeFeeRate = BigInt(new ByteReader(config.data).seek(47).u32());
    if (!vault0 || !vault1) throw new PoolDecodeError(this.program, 'vault account missing');
    const bal0 = decodeTokenAccount(vault0.data).amount;
    const bal1 = decodeTokenAccount(vault1.data).amount;
    const extension = parseBitmapExtension(bitmapExt ?? null);
    const bitmapExtension = extension ? bitmapExt!.address : null;
    const tickArrays: TickArray[] = [];
    for (const a of arrays) if (a) tickArrays.push(readTickArray(a, hop.poolAddress));
    if (tickArrays.length === 0) throw new PoolDecodeError(this.program, 'no tick array could be loaded');
    const ext0 = decodeMintExtensions(mint0Acc ?? null);
    const ext1 = decodeMintExtensions(mint1Acc ?? null);
    const blocked = ext0.transferHook || ext1.transferHook ? 'TRANSFER_HOOK_UNSUPPORTED' : ext0.nonTransferable || ext1.nonTransferable ? 'NON_TRANSFERABLE' : ext0.pausable || ext1.pausable ? 'PAUSABLE_MINT' : null;
    const nowSec = BigInt(Math.floor(context.nowMs / 1000));
    const swapDisabled = (h.status & (1 << 4)) !== 0;
    const notOpen = h.openTime >= nowSec;
    const detail: ClmmDetail = {
      ...h, tradeFeeRate, tickArrays, bitmapExtension, extension,
      transferFee0: activeTransferFee(ext0, null), transferFee1: activeTransferFee(ext1, null),
      tokenProgram0: mint0Acc?.owner === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      tokenProgram1: mint1Acc?.owner === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      nowSec,
    };
    const reserveA = bal0 - h.protocolFees0 - h.fundFees0;
    const reserveB = bal1 - h.protocolFees1 - h.fundFees1;
    return {
      program: this.program,
      poolAddress: hop.poolAddress,
      mintA: h.mint0,
      mintB: h.mint1,
      tokenProgramA: detail.tokenProgram0,
      tokenProgramB: detail.tokenProgram1,
      reserveA: reserveA < 0n ? 0n : reserveA,
      reserveB: reserveB < 0n ? 0n : reserveB,
      feeBps: Number((tradeFeeRate * 10_000n) / FEE_DENOM),
      tradeable: !swapDisabled && !notOpen && blocked === null && h.liquidity > 0n,
      tradeableReason: swapDisabled ? 'SWAP_DISABLED' : notOpen ? 'NOT_OPEN' : blocked ?? (h.liquidity <= 0n ? 'ZERO_LIQUIDITY' : null),
      detail: detail as unknown as Record<string, unknown>,
    };
  }

  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote {
    const d = state.detail as unknown as ClmmDetail;
    const zeroForOne = inputMint === state.mintA;
    if (!zeroForOne && inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${inputMint} is not in pool ${state.poolAddress}`);
    const feeOnInput = d.feeOn === 0 ? true : d.feeOn === 1 ? zeroForOne : !zeroForOne;
    const transferFeeIn = transferFeeAmount(zeroForOne ? d.transferFee0 : d.transferFee1, amountIn);
    let remaining = amountIn - transferFeeIn;
    const sqrtLimit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
    let sqrtPrice = d.sqrtPriceX64;
    let tick = d.tickCurrent;
    let liquidity = d.liquidity;
    let totalOut = 0n;
    let totalFee = 0n;
    const dyn: DynamicFee | null = d.dynamicFee ? { ...d.dynamicFee } : null;
    let tickSpacingIndex = 0;
    if (dyn) {
      tickSpacingIndex = tickSpacingIndexFromTick(tick, d.tickSpacing);
      const elapsed = d.nowSec - dyn.lastUpdateTimestamp;
      if (elapsed >= BigInt(dyn.filterPeriod)) {
        dyn.tickSpacingIndexReference = tickSpacingIndex;
        dyn.volatilityReference = elapsed < BigInt(dyn.decayPeriod) ? Number((BigInt(dyn.volatilityAccumulator) * BigInt(dyn.reductionFactor)) / REDUCTION_FACTOR_DENOMINATOR) : 0;
      }
    }
    const updateVolatility = () => {
      if (!dyn) return;
      const delta = Math.abs(dyn.tickSpacingIndexReference - tickSpacingIndex);
      const v = BigInt(dyn.volatilityReference) + BigInt(delta) * VOLATILITY_ACCUMULATOR_SCALE;
      dyn.volatilityAccumulator = Number(v < BigInt(dyn.maxVolatilityAccumulator) ? v : BigInt(dyn.maxVolatilityAccumulator));
    };
    const totalFeeRate = () => {
      if (!dyn) return d.tradeFeeRate;
      const total = d.tradeFeeRate + dynamicFeeRate(dyn, d.tickSpacing);
      return total > MAX_FEE_RATE_NUMERATOR ? MAX_FEE_RATE_NUMERATOR : total;
    };

    // tick-array cursor exactly as the program walks it
    const arrays = [...d.tickArrays];
    const currentStart = tickArrayStartIndex(tick, d.tickSpacing);
    let arrayIdx = arrays.findIndex((a) => a.startTick === currentStart);
    let firstContainsPoolTick = arrayIdx >= 0;
    if (arrayIdx < 0) {
      arrayIdx = 0;
      if (!arrays[0]) throw new PoolDecodeError(this.program, 'no tick array loaded');
    }
    const nextInitialisedTick = (): Tick => {
      const arr = arrays[arrayIdx]!;
      if (tickArrayStartIndex(tick, d.tickSpacing) === arr.startTick) {
        const offset = Math.trunc((tick - arr.startTick) / d.tickSpacing);
        if (zeroForOne) {
          for (let i = offset; i >= 0; i--) if (arr.ticks[i]!.liquidityGross > 0n || arr.ticks[i]!.hasLimitOrders) return arr.ticks[i]!;
        } else {
          for (let i = offset + 1; i < TICK_ARRAY_SIZE; i++) if (arr.ticks[i]!.liquidityGross > 0n || arr.ticks[i]!.hasLimitOrders) return arr.ticks[i]!;
        }
      }
      if (!firstContainsPoolTick) {
        firstContainsPoolTick = true;
        return firstInitialised(arr);
      }
      arrayIdx++;
      const nextArr = arrays[arrayIdx];
      if (!nextArr) throw new PoolDecodeError(this.program, `insufficient liquidity within the ${arrays.length} loaded tick array(s) for ${amountIn} in`);
      return firstInitialised(nextArr);
    };
    const firstInitialised = (arr: TickArray): Tick => {
      const list = zeroForOne ? [...arr.ticks].reverse() : arr.ticks;
      const t = list.find((x) => x.liquidityGross > 0n || x.hasLimitOrders);
      if (!t) throw new PoolDecodeError(this.program, `tick array ${arr.startTick} has no initialised tick`);
      return t;
    };

    let guard = 0;
    while (remaining > 0n && sqrtPrice !== sqrtLimit) {
      if (++guard > 4000) throw new PoolDecodeError(this.program, 'swap walk did not converge');
      const nextTick = nextInitialisedTick();
      if (nextTick.hasLimitOrders) throw new PoolDecodeError(this.program, `tick ${nextTick.tick} carries limit orders; the local quote does not model them`);
      const tickNext = Math.max(MIN_TICK, Math.min(MAX_TICK, nextTick.tick));
      const sqrtPriceNextTick = sqrtPriceAtTick(tickNext);
      const targetPrice = (zeroForOne && sqrtPriceNextTick < sqrtLimit) || (!zeroForOne && sqrtPriceNextTick > sqrtLimit) ? sqrtLimit : sqrtPriceNextTick;
      let liquidityNext = liquidity;
      // inner loop: with a dynamic fee the price moves one tick spacing at a time so the fee can re-rate
      let inner = 0;
      for (;;) {
        if (++inner > 4000) throw new PoolDecodeError(this.program, 'bounded walk did not converge');
        updateVolatility();
        const feeRate = totalFeeRate();
        let bounded = targetPrice;
        let boundedTick: number | null = null;
        let skipped = true;
        if (dyn && liquidity !== 0n && dyn.volatilityAccumulator !== dyn.maxVolatilityAccumulator) {
          skipped = false;
          const bt = Math.max(MIN_TICK, Math.min(MAX_TICK, zeroForOne ? tickSpacingIndex * d.tickSpacing : (tickSpacingIndex + 1) * d.tickSpacing));
          const bs = sqrtPriceAtTick(bt);
          if (zeroForOne ? targetPrice > bs : targetPrice < bs) bounded = targetPrice;
          else {
            bounded = bs;
            boundedTick = bt;
          }
        }
        let step: StepResult;
        if (sqrtPrice !== bounded) {
          step = computeSwapStep(sqrtPrice, bounded, liquidity, remaining, feeRate, zeroForOne, feeOnInput);
          const consumed = feeOnInput ? step.amountIn + step.feeAmount : step.amountIn;
          remaining -= consumed;
          totalOut += step.amountOut;
          totalFee += step.feeAmount;
        } else step = { sqrtPriceNext: bounded, amountIn: 0n, amountOut: 0n, feeAmount: 0n };
        if (sqrtPriceNextTick === step.sqrtPriceNext) {
          // crossed the initialised tick: apply its liquidity delta
          if (nextTick.liquidityGross > 0n) {
            const net = zeroForOne ? -nextTick.liquidityNet : nextTick.liquidityNet;
            liquidityNext = liquidity + net;
            if (liquidityNext < 0n) throw new PoolDecodeError(this.program, 'liquidity underflow crossing tick');
          }
          tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (sqrtPrice !== step.sqrtPriceNext) {
          tick = boundedTick !== null && step.sqrtPriceNext === bounded ? boundedTick : tickAtSqrtPrice(step.sqrtPriceNext);
        }
        sqrtPrice = step.sqrtPriceNext;
        if (dyn) {
          if (skipped) {
            const tickIndex = sqrtPrice === sqrtPriceNextTick ? tickNext : tick;
            let tsi = tickSpacingIndexFromTick(tickIndex, d.tickSpacing);
            if (!zeroForOne && tickIndex % d.tickSpacing === 0) tsi -= 1;
            tickSpacingIndex = tsi;
            if (dyn.volatilityAccumulator !== dyn.maxVolatilityAccumulator) updateVolatility();
          } else tickSpacingIndex += zeroForOne ? -1 : 1;
        }
        if (remaining === 0n || sqrtPrice === targetPrice) break;
      }
      liquidity = liquidityNext;
    }
    if (remaining > 0n) throw new PoolDecodeError(this.program, 'price limit reached before the input was consumed');
    const transferFeeOut = transferFeeAmount(zeroForOne ? d.transferFee1 : d.transferFee0, totalOut);
    // impact against the spot price at the starting sqrt price, fee excluded
    const netIn = amountIn - transferFeeIn;
    const feeAtStart = feeOnInput ? mulDivCeil(netIn, d.tradeFeeRate, FEE_DENOM) : 0n;
    const spotOut = zeroForOne ? (((netIn - feeAtStart) * d.sqrtPriceX64) >> 64n) * d.sqrtPriceX64 >> 64n : (((netIn - feeAtStart) << 64n) / d.sqrtPriceX64 << 64n) / d.sqrtPriceX64;
    const impact = spotOut > 0n ? Number(((spotOut - totalOut) * 10_000n) / spotOut) : 0;
    return {
      inputMint,
      outputMint: zeroForOne ? state.mintB : state.mintA,
      inputAmount: amountIn.toString() as Amount,
      expectedOutputAmount: (totalOut - transferFeeOut).toString() as Amount,
      feeAmount: (totalFee + transferFeeIn).toString() as Amount,
      impactBps: Math.max(0, Math.min(10_000, impact)) as Bps,
    };
  }

  swapInstruction(input: SwapBuildInput): DirectPoolInstruction {
    const { state } = input;
    const d = state.detail as unknown as ClmmDetail;
    const zeroForOne = input.inputMint === state.mintA;
    if (!zeroForOne && input.inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${input.inputMint} is not in pool ${state.poolAddress}`);
    const inputVault = zeroForOne ? d.vault0 : d.vault1;
    const outputVault = zeroForOne ? d.vault1 : d.vault0;
    const outputMint = zeroForOne ? state.mintB : state.mintA;
    return {
      programId: this.programId,
      accounts: [
        { pubkey: input.user, isSigner: true, isWritable: false },
        { pubkey: d.ammConfig, isSigner: false, isWritable: false },
        { pubkey: state.poolAddress, isSigner: false, isWritable: true },
        { pubkey: input.userSource, isSigner: false, isWritable: true },
        { pubkey: input.userDestination, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: d.observation, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: input.inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        ...(d.bitmapExtension ? [{ pubkey: d.bitmapExtension, isSigner: false, isWritable: true }] : []),
        ...d.tickArrays.map((t) => ({ pubkey: t.address, isSigner: false, isWritable: true })),
      ],
      // swap_v2 args: amount, other_amount_threshold (min out), sqrt_price_limit_x64 (0 = default), is_base_input
      data: concat(SWAP_V2, u64le(input.amountIn), u64le(input.minimumAmountOut), u128le(0n), new Uint8Array([1])),
    };
  }
}
