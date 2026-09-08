import type { Amount, Bps, DirectPoolHop, MintAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { anchorDiscriminator, ByteReader, concat, findProgramAddress, pk, u64le, u128le, utf8 } from './bytes.js';
import { activeTransferFee, decodeMintExtensions, transferFeeAmount, type TransferFee } from './token2022.js';
import { PoolDecodeError, type DecodeContext, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount, type SwapBuildInput } from './types.js';

/**
 * Orca Whirlpool (concentrated liquidity, program whirLbMi…). Layouts follow the program sources
 * and were verified against live pools on 2026-09-08: the 653-byte Whirlpool (tick spacing at 41,
 * fee tier seed at 43, fee rate at 45, protocol fee rate at 47, liquidity at 49, Q64.64 sqrt price
 * at 65, current tick at 81, mint/vault A from 101, mint/vault B from 181), fixed tick arrays
 * (9988 bytes, eighty-eight 113-byte ticks) and dynamic tick arrays (a 128-bit bitmap followed by
 * packed ticks, one byte when empty and 113 when initialised). The quote replays the program's
 * swap loop (tick math with the program's constants, `compute_swap`, tick crossings, the adaptive
 * fee manager when an oracle account exists) and the swap is `swap_v2` with three tick arrays and
 * the oracle PDA; a missing array in the sequence is passed as its PDA and treated as empty.
 */

export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SWAP_V2 = anchorDiscriminator('swap_v2');
const TICK_ARRAY_SIZE = 88;
const FIXED_TICK_ARRAY_LEN = 8 + 36 + 113 * TICK_ARRAY_SIZE;
const FIXED_DISC = [69, 97, 189, 190, 110, 7, 66, 187];
const DYNAMIC_DISC = [17, 216, 246, 142, 225, 199, 218, 56];
const FEE_RATE_MUL = 1_000_000n;
const FEE_RATE_HARD_LIMIT = 100_000n;
const VOLATILITY_ACCUMULATOR_SCALE_FACTOR = 10_000n;
const REDUCTION_FACTOR_DENOMINATOR = 10_000n;
const ADAPTIVE_FEE_CONTROL_FACTOR_DENOMINATOR = 100_000n;
const MAX_REFERENCE_AGE = 3_600n;
export const ORCA_MIN_TICK = -443636;
export const ORCA_MAX_TICK = 443636;
export const ORCA_MIN_SQRT_PRICE = 4295048016n;
export const ORCA_MAX_SQRT_PRICE = 79226673515401279992447579055n;
const U64_MAX = (1n << 64n) - 1n;

interface AdaptiveConstants {
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  adaptiveFeeControlFactor: number;
  maxVolatilityAccumulator: number;
  tickGroupSize: number;
  majorSwapThresholdTicks: number;
}

interface AdaptiveVariables {
  lastReferenceUpdateTimestamp: bigint;
  lastMajorSwapTimestamp: bigint;
  volatilityReference: number;
  tickGroupIndexReference: number;
  volatilityAccumulator: number;
}

interface WhirlpoolHeader {
  tickSpacing: number;
  feeTierIndexSeed: number;
  feeRate: number;
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrent: number;
  protocolFeeOwedA: bigint;
  protocolFeeOwedB: bigint;
  mintA: MintAddress;
  vaultA: string;
  mintB: MintAddress;
  vaultB: string;
}

interface Tick {
  initialized: boolean;
  liquidityNet: bigint;
  liquidityGross: bigint;
}

interface TickArray {
  address: string;
  startTick: number;
  /** Null for an array that does not exist on chain: it is carried as its PDA and reads as empty. */
  ticks: Tick[] | null;
}

interface WhirlpoolDetail extends WhirlpoolHeader {
  oracle: string;
  adaptive: { constants: AdaptiveConstants; variables: AdaptiveVariables; tradeEnableTimestamp: bigint } | null;
  tickArrays: TickArray[];
  transferFeeA: TransferFee | null;
  transferFeeB: TransferFee | null;
  tokenProgramA: string;
  tokenProgramB: string;
  nowSec: bigint;
}

// --- tick math (program: math/tick_math.rs) --------------------------------------------------------
const POSITIVE_MAGIC: [number, bigint][] = [
  [2, 79236085330515764027303304731n], [4, 79244008939048815603706035061n], [8, 79259858533276714757314932305n], [16, 79291567232598584799939703904n], [32, 79355022692464371645785046466n],
  [64, 79482085999252804386437311141n], [128, 79736823300114093921829183326n], [256, 80248749790819932309965073892n], [512, 81282483887344747381513967011n], [1024, 83390072131320151908154831281n],
  [2048, 87770609709833776024991924138n], [4096, 97234110755111693312479820773n], [8192, 119332217159966728226237229890n], [16384, 179736315981702064433883588727n], [32768, 407748233172238350107850275304n],
  [65536, 2098478828474011932436660412517n], [131072, 55581415166113811149459800483533n], [262144, 38992368544603139932233054999993551n],
];
const NEGATIVE_MAGIC: [number, bigint][] = [
  [2, 18444899583751176498n], [4, 18443055278223354162n], [8, 18439367220385604838n], [16, 18431993317065449817n], [32, 18417254355718160513n], [64, 18387811781193591352n],
  [128, 18329067761203520168n], [256, 18212142134806087854n], [512, 17980523815641551639n], [1024, 17526086738831147013n], [2048, 16651378430235024244n], [4096, 15030750278693429944n],
  [8192, 12247334978882834399n], [16384, 8131365268884726200n], [32768, 3584323654723342297n], [65536, 696457651847595233n], [131072, 26294789957452057n], [262144, 37481735321082n],
];

export function orcaSqrtPriceFromTick(tick: number): bigint {
  if (tick < ORCA_MIN_TICK || tick > ORCA_MAX_TICK) throw new RangeError(`tick ${tick} out of range`);
  if (tick >= 0) {
    let ratio = tick & 1 ? 79232123823359799118286999567n : 79228162514264337593543950336n;
    for (const [bit, m] of POSITIVE_MAGIC) if (tick & bit) ratio = (ratio * m) >> 96n;
    return ratio >> 32n;
  }
  const abs = -tick;
  let ratio = abs & 1 ? 18445821805675392311n : 18446744073709551616n;
  for (const [bit, m] of NEGATIVE_MAGIC) if (abs & bit) ratio = (ratio * m) >> 64n;
  return ratio;
}

export function orcaTickFromSqrtPrice(sqrtPrice: bigint): number {
  const msb = sqrtPrice.toString(2).length - 1;
  const log2pIntegerX32 = BigInt(msb - 64) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let precision = 0;
  let log2pFractionX64 = 0n;
  let r = msb >= 64 ? sqrtPrice >> BigInt(msb - 63) : sqrtPrice << BigInt(63 - msb);
  while (bit > 0n && precision < 14) {
    r = r * r;
    const more = r >> 127n;
    r >>= 63n + more;
    log2pFractionX64 += bit * more;
    bit >>= 1n;
    precision++;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  const logbpX64 = log2pX32 * 59543866431248n;
  const tickLow = Number((logbpX64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logbpX64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return orcaSqrtPriceFromTick(tickHigh) <= sqrtPrice ? tickHigh : tickLow;
}

// --- token math (program: math/token_math.rs, swap_math.rs) ----------------------------------------
const order = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b]);

function amountDeltaA(sqrt0: bigint, sqrt1: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = order(sqrt0, sqrt1);
  const numerator = (liquidity * (hi - lo)) << 64n;
  const denominator = hi * lo;
  const q = numerator / denominator;
  return roundUp && numerator % denominator !== 0n ? q + 1n : q;
}

function amountDeltaB(sqrt0: bigint, sqrt1: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = order(sqrt0, sqrt1);
  const p = liquidity * (hi - lo);
  const q = p >> 64n;
  return roundUp && (p & U64_MAX) !== 0n ? q + 1n : q;
}

function nextSqrtPriceFromAIn(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  const numerator = (liquidity * sqrtPrice) << 64n;
  const denominator = (liquidity << 64n) + sqrtPrice * amount;
  const q = numerator / denominator;
  return numerator % denominator !== 0n ? q + 1n : q;
}

function nextSqrtPriceFromBIn(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  return sqrtPrice + (amount << 64n) / liquidity;
}

interface Step {
  amountIn: bigint;
  amountOut: bigint;
  nextPrice: bigint;
  feeAmount: bigint;
}

/** Exact-in step (program: swap_math::compute_swap with amount_specified_is_input = true). */
function computeSwapStep(amountRemaining: bigint, feeRate: bigint, liquidity: bigint, sqrtCurrent: bigint, sqrtTarget: bigint, aToB: boolean): Step {
  const fixedAtTarget = aToB ? amountDeltaA(sqrtCurrent, sqrtTarget, liquidity, true) : amountDeltaB(sqrtCurrent, sqrtTarget, liquidity, true);
  const amountCalc = (amountRemaining * (FEE_RATE_MUL - feeRate)) / FEE_RATE_MUL;
  const fixedFits = fixedAtTarget <= U64_MAX && fixedAtTarget <= amountCalc;
  const nextPrice = fixedFits ? sqrtTarget : aToB ? nextSqrtPriceFromAIn(sqrtCurrent, liquidity, amountCalc) : nextSqrtPriceFromBIn(sqrtCurrent, liquidity, amountCalc);
  const isMax = nextPrice === sqrtTarget;
  const amountOut = aToB ? amountDeltaB(sqrtCurrent, nextPrice, liquidity, false) : amountDeltaA(sqrtCurrent, nextPrice, liquidity, false);
  const amountIn = !isMax || fixedAtTarget > U64_MAX ? (aToB ? amountDeltaA(sqrtCurrent, nextPrice, liquidity, true) : amountDeltaB(sqrtCurrent, nextPrice, liquidity, true)) : fixedAtTarget;
  const feeAmount = !isMax ? amountRemaining - amountIn : (amountIn * feeRate + (FEE_RATE_MUL - feeRate) - 1n) / (FEE_RATE_MUL - feeRate);
  return { amountIn, amountOut, nextPrice, feeAmount };
}

// --- tick arrays -----------------------------------------------------------------------------------
const floorDiv = (a: number, b: number): number => Math.floor(a / b);

export function orcaTickArrayStart(tick: number, tickSpacing: number): number {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  return floorDiv(tick, span) * span;
}

export function deriveWhirlpoolTickArray(pool: string, startTick: number): string {
  return findProgramAddress([utf8('tick_array'), pk(pool), utf8(String(startTick))], ORCA_WHIRLPOOL_PROGRAM).address;
}

export function deriveWhirlpoolOracle(pool: string): string {
  return findProgramAddress([utf8('oracle'), pk(pool)], ORCA_WHIRLPOOL_PROGRAM).address;
}

function validStart(start: number, tickSpacing: number): boolean {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  if (start < ORCA_MIN_TICK || start > ORCA_MAX_TICK) {
    if (start > ORCA_MIN_TICK) return false;
    const minStart = ORCA_MIN_TICK - ((ORCA_MIN_TICK % span) + span);
    return start === minStart;
  }
  return start % span === 0;
}

/** The three arrays the program requires for a swap, exactly as `get_start_tick_indexes` picks them. */
export function whirlpoolSwapArrayStarts(tickCurrent: number, tickSpacing: number, aToB: boolean): number[] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const base = floorDiv(tickCurrent, span) * span;
  const offsets = aToB ? [0, -1, -2] : tickCurrent + tickSpacing >= base + span ? [1, 2, 3] : [0, 1, 2];
  return offsets.map((o) => base + o * span).filter((s) => validStart(s, tickSpacing));
}

function readHeader(hop: DirectPoolHop, pool: RawAccount): WhirlpoolHeader {
  if (pool.owner !== ORCA_WHIRLPOOL_PROGRAM) throw new PoolDecodeError('ORCA_WHIRLPOOL', `pool ${hop.poolAddress} missing or not owned by ${ORCA_WHIRLPOOL_PROGRAM}`);
  if (pool.data.length !== 653) throw new PoolDecodeError('ORCA_WHIRLPOOL', `whirlpool data is ${pool.data.length} bytes, expected 653`);
  const r = new ByteReader(pool.data).seek(41);
  const tickSpacing = r.u16();
  const feeTierIndexSeed = r.u16();
  const feeRate = r.u16();
  const protocolFeeRate = r.u16();
  const liquidity = r.u128();
  const sqrtPrice = r.u128();
  const tickCurrent = r.i32();
  const protocolFeeOwedA = r.u64();
  const protocolFeeOwedB = r.u64();
  const mintA = r.pubkey() as MintAddress;
  const vaultA = r.pubkey();
  r.skip(16);
  const mintB = r.pubkey() as MintAddress;
  const vaultB = r.pubkey();
  return { tickSpacing, feeTierIndexSeed, feeRate, protocolFeeRate, liquidity, sqrtPrice, tickCurrent, protocolFeeOwedA, protocolFeeOwedB, mintA, vaultA, mintB, vaultB };
}

function readTickArray(account: RawAccount, pool: string): { startTick: number; ticks: Tick[] } {
  if (account.owner !== ORCA_WHIRLPOOL_PROGRAM || account.data.length < 8) throw new PoolDecodeError('ORCA_WHIRLPOOL', `tick array ${account.address} is not a program account`);
  const disc = [...account.data.slice(0, 8)];
  const ticks: Tick[] = [];
  if (disc.every((b, i) => b === FIXED_DISC[i])) {
    if (account.data.length !== FIXED_TICK_ARRAY_LEN) throw new PoolDecodeError('ORCA_WHIRLPOOL', `fixed tick array ${account.address} has ${account.data.length} bytes`);
    const r = new ByteReader(account.data).seek(8);
    const startTick = r.i32();
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      const t = new ByteReader(account.data).seek(12 + i * 113);
      const initialized = t.u8() !== 0;
      const liquidityNet = BigInt.asIntN(128, t.u128());
      const liquidityGross = t.u128();
      ticks.push({ initialized, liquidityNet, liquidityGross });
    }
    const whirlpool = new ByteReader(account.data).seek(12 + 113 * TICK_ARRAY_SIZE).pubkey();
    if (whirlpool !== pool) throw new PoolDecodeError('ORCA_WHIRLPOOL', `tick array ${account.address} belongs to another whirlpool`);
    return { startTick, ticks };
  }
  if (disc.every((b, i) => b === DYNAMIC_DISC[i])) {
    const r = new ByteReader(account.data).seek(8);
    const startTick = r.i32();
    const whirlpool = r.pubkey();
    if (whirlpool !== pool) throw new PoolDecodeError('ORCA_WHIRLPOOL', `tick array ${account.address} belongs to another whirlpool`);
    const bitmap = r.u128();
    let offset = 8 + 4 + 32 + 16;
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      const initialized = ((bitmap >> BigInt(i)) & 1n) === 1n;
      if (!initialized) {
        ticks.push({ initialized: false, liquidityNet: 0n, liquidityGross: 0n });
        offset += 1;
        continue;
      }
      const t = new ByteReader(account.data).seek(offset + 1);
      ticks.push({ initialized: true, liquidityNet: BigInt.asIntN(128, t.u128()), liquidityGross: t.u128() });
      offset += 113;
    }
    return { startTick, ticks };
  }
  throw new PoolDecodeError('ORCA_WHIRLPOOL', `tick array ${account.address} has an unknown discriminator`);
}

export class OrcaWhirlpoolAdapter implements DirectPoolAdapter {
  readonly program = 'ORCA_WHIRLPOOL' as const;
  readonly programId = ORCA_WHIRLPOOL_PROGRAM;

  requiredAccounts(hop: DirectPoolHop): string[] {
    return [hop.poolAddress];
  }

  /** Vaults, mints, the oracle slot, then the three tick arrays the program requires in the exit direction. */
  dependentAccounts(hop: DirectPoolHop, pool: RawAccount, _first: readonly (RawAccount | null)[] = []): string[] {
    const h = readHeader(hop, pool);
    const aToB = hop.inputMint === h.mintA;
    const starts = whirlpoolSwapArrayStarts(h.tickCurrent, h.tickSpacing, aToB);
    return [h.vaultA, h.vaultB, h.mintA, h.mintB, deriveWhirlpoolOracle(hop.poolAddress), ...starts.map((s) => deriveWhirlpoolTickArray(hop.poolAddress, s))];
  }

  decode(hop: DirectPoolHop, accounts: readonly (RawAccount | null)[], context: DecodeContext): DecodedPoolState {
    const [pool, vaultA, vaultB, mintAAcc, mintBAcc, oracleAcc, ...arrays] = accounts;
    if (!pool) throw new PoolDecodeError(this.program, `pool ${hop.poolAddress} does not exist`);
    const h = readHeader(hop, pool);
    if (!vaultA || !vaultB) throw new PoolDecodeError(this.program, 'vault account missing');
    const balA = decodeTokenAccount(vaultA.data).amount;
    const balB = decodeTokenAccount(vaultB.data).amount;
    const aToB = hop.inputMint === h.mintA;
    const starts = whirlpoolSwapArrayStarts(h.tickCurrent, h.tickSpacing, aToB);
    const tickArrays: TickArray[] = starts.map((start, i) => {
      const a = arrays[i] ?? null;
      const address = deriveWhirlpoolTickArray(hop.poolAddress, start);
      if (!a) return { address, startTick: start, ticks: null };
      const parsed = readTickArray(a, hop.poolAddress);
      if (parsed.startTick !== start) throw new PoolDecodeError(this.program, `tick array ${address} starts at ${parsed.startTick}, expected ${start}`);
      return { address, startTick: start, ticks: parsed.ticks };
    });
    if (tickArrays.length === 0) throw new PoolDecodeError(this.program, 'no tick array in range');
    let adaptive: WhirlpoolDetail['adaptive'] = null;
    if (oracleAcc && oracleAcc.owner === this.programId && oracleAcc.data.length >= 8 + 32 + 8 + 34 + 44) {
      const o = new ByteReader(oracleAcc.data).seek(8);
      const whirlpool = o.pubkey();
      if (whirlpool === hop.poolAddress) {
        const tradeEnableTimestamp = o.u64();
        const constants: AdaptiveConstants = { filterPeriod: o.u16(), decayPeriod: o.u16(), reductionFactor: o.u16(), adaptiveFeeControlFactor: o.u32(), maxVolatilityAccumulator: o.u32(), tickGroupSize: o.u16(), majorSwapThresholdTicks: o.u16() };
        o.skip(16);
        const variables: AdaptiveVariables = { lastReferenceUpdateTimestamp: o.u64(), lastMajorSwapTimestamp: o.u64(), volatilityReference: o.u32(), tickGroupIndexReference: o.i32(), volatilityAccumulator: o.u32() };
        adaptive = { constants, variables, tradeEnableTimestamp };
      }
    }
    const extA = decodeMintExtensions(mintAAcc ?? null);
    const extB = decodeMintExtensions(mintBAcc ?? null);
    const blocked = extA.transferHook || extB.transferHook ? 'TRANSFER_HOOK_UNSUPPORTED' : extA.nonTransferable || extB.nonTransferable ? 'NON_TRANSFERABLE' : extA.pausable || extB.pausable ? 'PAUSABLE_MINT' : null;
    const nowSec = BigInt(Math.floor(context.nowMs / 1000));
    const notEnabled = adaptive !== null && adaptive.tradeEnableTimestamp > nowSec;
    const detail: WhirlpoolDetail = {
      ...h, oracle: deriveWhirlpoolOracle(hop.poolAddress), adaptive, tickArrays,
      transferFeeA: activeTransferFee(extA, null), transferFeeB: activeTransferFee(extB, null),
      tokenProgramA: mintAAcc?.owner === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      tokenProgramB: mintBAcc?.owner === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      nowSec,
    };
    const reserveA = balA - h.protocolFeeOwedA;
    const reserveB = balB - h.protocolFeeOwedB;
    return {
      program: this.program,
      poolAddress: hop.poolAddress,
      mintA: h.mintA,
      mintB: h.mintB,
      tokenProgramA: detail.tokenProgramA,
      tokenProgramB: detail.tokenProgramB,
      reserveA: reserveA < 0n ? 0n : reserveA,
      reserveB: reserveB < 0n ? 0n : reserveB,
      feeBps: Number((BigInt(h.feeRate) * 10_000n) / FEE_RATE_MUL),
      tradeable: !notEnabled && blocked === null && h.liquidity > 0n,
      tradeableReason: notEnabled ? 'NOT_OPEN' : blocked ?? (h.liquidity <= 0n ? 'ZERO_LIQUIDITY' : null),
      detail: detail as unknown as Record<string, unknown>,
    };
  }

  quote(state: DecodedPoolState, inputMint: MintAddress, amountIn: bigint): PoolQuote {
    const d = state.detail as unknown as WhirlpoolDetail;
    const aToB = inputMint === state.mintA;
    if (!aToB && inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${inputMint} is not in pool ${state.poolAddress}`);
    const transferFeeIn = transferFeeAmount(aToB ? d.transferFeeA : d.transferFeeB, amountIn);
    let remaining = amountIn - transferFeeIn;
    const limit = aToB ? ORCA_MIN_SQRT_PRICE : ORCA_MAX_SQRT_PRICE;
    let sqrtPrice = d.sqrtPrice;
    let tick = d.tickCurrent;
    let liquidity = d.liquidity;
    let arrayIdx = 0;
    let totalOut = 0n;
    let totalFee = 0n;
    const spacing = d.tickSpacing;
    const span = TICK_ARRAY_SIZE * spacing;

    // adaptive fee manager (program: manager/fee_rate_manager.rs); static when no oracle exists
    const fm = d.adaptive ? this.feeManager(d, aToB, tick) : null;
    const feeRate = () => (fm ? fm.totalFeeRate() : BigInt(d.feeRate));

    const nextInitialisedTick = (from: number, startArray: number): { arrayIdx: number; tickIndex: number } => {
      let search = from;
      let idx = startArray;
      for (;;) {
        const arr = d.tickArrays[idx];
        if (!arr) throw new PoolDecodeError(this.program, `insufficient liquidity within the ${d.tickArrays.length} loaded tick array(s) for ${amountIn} in`);
        const lower = arr.startTick - (aToB ? 0 : spacing);
        const upper = arr.startTick + span - (aToB ? 0 : spacing);
        if (search < lower || search >= upper) throw new PoolDecodeError(this.program, 'tick array sequence does not cover the search tick');
        const lhs = search - arr.startTick;
        let offset = Math.trunc(lhs / spacing);
        if (lhs % spacing < 0) offset -= 1;
        if (!aToB) offset += 1;
        let found: number | null = null;
        if (arr.ticks) {
          while (offset >= 0 && offset < TICK_ARRAY_SIZE) {
            if (arr.ticks[offset]!.initialized) {
              found = offset * spacing + arr.startTick;
              break;
            }
            offset += aToB ? -1 : 1;
          }
        }
        if (found !== null) return { arrayIdx: idx, tickIndex: found };
        if (aToB && arr.startTick <= ORCA_MIN_TICK) return { arrayIdx: idx, tickIndex: ORCA_MIN_TICK };
        if (!aToB && arr.startTick + span > ORCA_MAX_TICK) return { arrayIdx: idx, tickIndex: ORCA_MAX_TICK };
        if (idx + 1 === d.tickArrays.length) return { arrayIdx: idx, tickIndex: aToB ? arr.startTick : arr.startTick + span - 1 };
        search = aToB ? arr.startTick - 1 : arr.startTick + span - 1;
        idx += 1;
      }
    };

    let guard = 0;
    while (remaining > 0n && limit !== sqrtPrice) {
      if (++guard > 4000) throw new PoolDecodeError(this.program, 'swap walk did not converge');
      const next = nextInitialisedTick(tick, arrayIdx);
      const nextTickSqrt = orcaSqrtPriceFromTick(next.tickIndex);
      const target = aToB ? (nextTickSqrt < limit ? limit : nextTickSqrt) : nextTickSqrt > limit ? limit : nextTickSqrt;
      let inner = 0;
      for (;;) {
        if (++inner > 4000) throw new PoolDecodeError(this.program, 'bounded walk did not converge');
        fm?.updateVolatilityAccumulator();
        const rate = feeRate();
        const [bounded, skipped] = fm ? fm.boundedTarget(target, liquidity) : [target, false];
        const step = computeSwapStep(remaining, rate, liquidity, sqrtPrice, bounded, aToB);
        remaining -= step.amountIn + step.feeAmount;
        totalOut += step.amountOut;
        totalFee += step.feeAmount;
        if (step.nextPrice === nextTickSqrt) {
          const arr = d.tickArrays[next.arrayIdx]!;
          const offset = Math.trunc((next.tickIndex - arr.startTick) / spacing);
          const t = arr.ticks?.[offset] ?? null;
          if (t && t.initialized) {
            const net = aToB ? -t.liquidityNet : t.liquidityNet;
            liquidity += net;
            if (liquidity < 0n) throw new PoolDecodeError(this.program, 'liquidity underflow crossing tick');
          }
          arrayIdx = (aToB && offset === 0) || (!aToB && offset === TICK_ARRAY_SIZE - 1) ? next.arrayIdx + 1 : next.arrayIdx;
          tick = aToB ? next.tickIndex - 1 : next.tickIndex;
        } else if (step.nextPrice !== sqrtPrice) {
          tick = orcaTickFromSqrtPrice(step.nextPrice);
        }
        sqrtPrice = step.nextPrice;
        if (fm) {
          if (!skipped) fm.advanceTickGroup();
          else fm.advanceAfterSkip(sqrtPrice, nextTickSqrt, next.tickIndex);
        }
        if (remaining === 0n || sqrtPrice === target) break;
      }
    }
    if (remaining > 0n) throw new PoolDecodeError(this.program, 'price limit reached before the input was consumed');
    const transferFeeOut = transferFeeAmount(aToB ? d.transferFeeB : d.transferFeeA, totalOut);
    const netIn = amountIn - transferFeeIn;
    const feeAtStart = (netIn * BigInt(d.feeRate) + FEE_RATE_MUL - 1n) / FEE_RATE_MUL;
    const spotOut = aToB ? ((((netIn - feeAtStart) * d.sqrtPrice) >> 64n) * d.sqrtPrice) >> 64n : ((((netIn - feeAtStart) << 64n) / d.sqrtPrice) << 64n) / d.sqrtPrice;
    const impact = spotOut > 0n ? Number(((spotOut - totalOut) * 10_000n) / spotOut) : 0;
    return {
      inputMint,
      outputMint: aToB ? state.mintB : state.mintA,
      inputAmount: amountIn.toString() as Amount,
      expectedOutputAmount: (totalOut - transferFeeOut).toString() as Amount,
      feeAmount: (totalFee + transferFeeIn).toString() as Amount,
      impactBps: Math.max(0, Math.min(10_000, impact)) as Bps,
    };
  }

  private feeManager(d: WhirlpoolDetail, aToB: boolean, tickCurrent: number) {
    const c = d.adaptive!.constants;
    const v: AdaptiveVariables = { ...d.adaptive!.variables };
    const groupSize = c.tickGroupSize;
    let tickGroupIndex = floorDiv(tickCurrent, groupSize);
    // update_reference
    const maxTs = v.lastReferenceUpdateTimestamp > v.lastMajorSwapTimestamp ? v.lastReferenceUpdateTimestamp : v.lastMajorSwapTimestamp;
    const now = d.nowSec < maxTs ? maxTs : d.nowSec;
    const referenceAge = now - v.lastReferenceUpdateTimestamp;
    if (referenceAge > MAX_REFERENCE_AGE) {
      v.tickGroupIndexReference = tickGroupIndex;
      v.volatilityReference = 0;
    } else {
      const elapsed = now - maxTs;
      if (elapsed >= BigInt(c.filterPeriod)) {
        v.tickGroupIndexReference = tickGroupIndex;
        v.volatilityReference = elapsed < BigInt(c.decayPeriod) ? Number((BigInt(v.volatilityAccumulator) * BigInt(c.reductionFactor)) / REDUCTION_FACTOR_DENOMINATOR) : 0;
      }
    }
    const maxDelta = Math.ceil((c.maxVolatilityAccumulator - v.volatilityReference) / Number(VOLATILITY_ACCUMULATOR_SCALE_FACTOR));
    const lowerIndex = v.tickGroupIndexReference - maxDelta;
    const upperIndex = v.tickGroupIndexReference + maxDelta;
    const lowerTick = lowerIndex * groupSize;
    const upperTick = upperIndex * groupSize + groupSize;
    const lowerBound = lowerTick > ORCA_MIN_TICK ? { index: lowerIndex, sqrt: orcaSqrtPriceFromTick(lowerTick) } : null;
    const upperBound = upperTick < ORCA_MAX_TICK ? { index: upperIndex, sqrt: orcaSqrtPriceFromTick(upperTick) } : null;
    const adaptiveRate = (): bigint => {
      const crossed = BigInt(v.volatilityAccumulator) * BigInt(groupSize);
      const rate = (BigInt(c.adaptiveFeeControlFactor) * crossed * crossed + ADAPTIVE_FEE_CONTROL_FACTOR_DENOMINATOR * VOLATILITY_ACCUMULATOR_SCALE_FACTOR * VOLATILITY_ACCUMULATOR_SCALE_FACTOR - 1n) / (ADAPTIVE_FEE_CONTROL_FACTOR_DENOMINATOR * VOLATILITY_ACCUMULATOR_SCALE_FACTOR * VOLATILITY_ACCUMULATOR_SCALE_FACTOR);
      return rate > FEE_RATE_HARD_LIMIT ? FEE_RATE_HARD_LIMIT : rate;
    };
    const updateVolatility = (groupIndex: number) => {
      const delta = Math.abs(v.tickGroupIndexReference - groupIndex);
      const acc = BigInt(v.volatilityReference) + BigInt(delta) * VOLATILITY_ACCUMULATOR_SCALE_FACTOR;
      v.volatilityAccumulator = Number(acc < BigInt(c.maxVolatilityAccumulator) ? acc : BigInt(c.maxVolatilityAccumulator));
    };
    return {
      updateVolatilityAccumulator: () => updateVolatility(tickGroupIndex),
      totalFeeRate: (): bigint => {
        const total = BigInt(d.feeRate) + adaptiveRate();
        return total > FEE_RATE_HARD_LIMIT ? FEE_RATE_HARD_LIMIT : total;
      },
      boundedTarget: (sqrtTarget: bigint, liquidity: bigint): [bigint, boolean] => {
        if (c.adaptiveFeeControlFactor === 0 || liquidity === 0n) return [sqrtTarget, true];
        if (lowerBound && tickGroupIndex < lowerBound.index) return aToB ? [sqrtTarget, true] : [sqrtTarget < lowerBound.sqrt ? sqrtTarget : lowerBound.sqrt, true];
        if (upperBound && tickGroupIndex > upperBound.index) return aToB ? [sqrtTarget > upperBound.sqrt ? sqrtTarget : upperBound.sqrt, true] : [sqrtTarget, true];
        const boundaryTick = aToB ? tickGroupIndex * groupSize : tickGroupIndex * groupSize + groupSize;
        const boundarySqrt = orcaSqrtPriceFromTick(Math.max(ORCA_MIN_TICK, Math.min(ORCA_MAX_TICK, boundaryTick)));
        return aToB ? [sqrtTarget > boundarySqrt ? sqrtTarget : boundarySqrt, false] : [sqrtTarget < boundarySqrt ? sqrtTarget : boundarySqrt, false];
      },
      advanceTickGroup: () => {
        tickGroupIndex += aToB ? -1 : 1;
      },
      advanceAfterSkip: (sqrtPrice: bigint, nextTickSqrt: bigint, nextTickIndex: number) => {
        let tickIndex: number;
        let onBoundary: boolean;
        if (sqrtPrice === nextTickSqrt) {
          tickIndex = nextTickIndex;
          onBoundary = nextTickIndex % groupSize === 0;
        } else {
          tickIndex = orcaTickFromSqrtPrice(sqrtPrice);
          onBoundary = tickIndex % groupSize === 0 && sqrtPrice === orcaSqrtPriceFromTick(tickIndex);
        }
        const lastTraversed = onBoundary && !aToB ? Math.trunc(tickIndex / groupSize) - 1 : floorDiv(tickIndex, groupSize);
        if ((aToB && lastTraversed < tickGroupIndex) || (!aToB && lastTraversed > tickGroupIndex)) {
          tickGroupIndex = lastTraversed;
          updateVolatility(tickGroupIndex);
        }
        tickGroupIndex += aToB ? -1 : 1;
      },
    };
  }

  swapInstruction(input: SwapBuildInput): DirectPoolInstruction {
    const { state } = input;
    const d = state.detail as unknown as WhirlpoolDetail;
    const aToB = input.inputMint === state.mintA;
    if (!aToB && input.inputMint !== state.mintB) throw new PoolDecodeError(this.program, `mint ${input.inputMint} is not in pool ${state.poolAddress}`);
    const ownerA = aToB ? input.userSource : input.userDestination;
    const ownerB = aToB ? input.userDestination : input.userSource;
    const arrays = [0, 1, 2].map((i) => d.tickArrays[i]?.address ?? d.tickArrays[d.tickArrays.length - 1]!.address);
    return {
      programId: this.programId,
      accounts: [
        { pubkey: state.tokenProgramA, isSigner: false, isWritable: false },
        { pubkey: state.tokenProgramB, isSigner: false, isWritable: false },
        { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: input.user, isSigner: true, isWritable: false },
        { pubkey: state.poolAddress, isSigner: false, isWritable: true },
        { pubkey: state.mintA, isSigner: false, isWritable: false },
        { pubkey: state.mintB, isSigner: false, isWritable: false },
        { pubkey: ownerA, isSigner: false, isWritable: true },
        { pubkey: d.vaultA, isSigner: false, isWritable: true },
        { pubkey: ownerB, isSigner: false, isWritable: true },
        { pubkey: d.vaultB, isSigner: false, isWritable: true },
        { pubkey: arrays[0]!, isSigner: false, isWritable: true },
        { pubkey: arrays[1]!, isSigner: false, isWritable: true },
        { pubkey: arrays[2]!, isSigner: false, isWritable: true },
        { pubkey: d.oracle, isSigner: false, isWritable: true },
      ],
      // swap_v2 args: amount, other_amount_threshold, sqrt_price_limit (0 = default), amount_specified_is_input, a_to_b, remaining_accounts_info = None
      data: concat(SWAP_V2, u64le(input.amountIn), u64le(input.minimumAmountOut), u128le(0n), new Uint8Array([1, aToB ? 1 : 0, 0])),
    };
  }
}
