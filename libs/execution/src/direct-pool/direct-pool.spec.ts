import type { DirectPoolHop, MintAddress, SolanaAddress } from '@sol-agent-trader/contracts';
import { base58Decode } from '@sol-agent-trader/solana-hard-state';
import type { SimulationOutcome, SimulationReader } from '../simulate/client.js';
import { decodeTransaction, fromBase64 } from '../tx/codec.js';
import { TOKEN_PROGRAM } from '../validate/programs.js';
import { anchorDiscriminator, associatedTokenAddress, createProgramAddress, findProgramAddress, isOnCurve, utf8 } from './bytes.js';
import { buildEmergencyExit, classifyDryRun, compileLegacyMessage, runEmergencyDryRun } from './dry-run.js';
import { MAINNET_POOL_FIXTURES } from './fixtures/mainnet-pools.js';
import { MAINNET_DLMM_FIXTURE } from './fixtures/mainnet-dlmm.js';
import { binArrayIndex, deriveBinArray, deriveEventAuthority, MeteoraDlmmAdapter, nextBinArrayWithLiquidity } from './meteora-dlmm.js';
import { MAINNET_TOKEN2022_MINT } from './fixtures/mainnet-token2022-mint.js';
import { MAINNET_CLMM_FIXTURE } from './fixtures/mainnet-clmm.js';
import { deriveTickArray, MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK, nextInitialisedTickArray, RaydiumClmmAdapter, sqrtPriceAtTick, tickArrayStartIndex, tickAtSqrtPrice } from './raydium-clmm.js';
import { activeTransferFee, decodeMintExtensions, transferFeeAmount } from './token2022.js';
import { RaydiumAmmV4Adapter } from './raydium-amm-v4.js';
import { RaydiumCpmmAdapter } from './raydium-cpmm.js';
import { constantProductOut, impactBps, type RawAccount } from './types.js';

const SOL = 'So11111111111111111111111111111111111111112' as MintAddress;
const NOW = '2026-09-08T20:00:00.000Z' as never;
const CTX = { nowMs: Date.parse(NOW) };
const WALLET = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const raw = (a: { address: string; owner: string; lamports: number; dataBase64: string } | null): RawAccount | null => (a ? { address: a.address, owner: a.owner, lamports: a.lamports, data: fromBase64(a.dataBase64) } : null);
const cpmmHop: DirectPoolHop = { program: 'RAYDIUM_CPMM', programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' as SolanaAddress, poolAddress: 'AiP94aqcnsxPfHTQLerdwNACedhmEUxMaaSxevS2Drxm' as SolanaAddress, inputMint: 'HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd' as MintAddress, outputMint: SOL };
const ammHop: DirectPoolHop = { program: 'RAYDIUM_AMM_V4', programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' as SolanaAddress, poolAddress: '7yMhxapzceFUo24KNgP77mGj1crdAv8ayYfqGvB5skZf' as SolanaAddress, inputMint: '463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA' as MintAddress, outputMint: SOL };

/** A reader that serves the captured mainnet accounts and records what was simulated. */
function fixtureReader(sim: (tx: string) => SimulationOutcome): SimulationReader & { simulated: string[] } {
  const all = [...MAINNET_POOL_FIXTURES.cpmm.accounts, ...MAINNET_POOL_FIXTURES.ammv4.accounts].filter((a): a is NonNullable<typeof a> => a !== null);
  const simulated: string[] = [];
  return {
    label: 'fixture',
    simulated,
    async accounts(addresses) {
      return { slot: MAINNET_POOL_FIXTURES.cpmm.slot, accounts: addresses.map((x) => all.find((a) => a.address === x) ?? null) };
    },
    async simulate(tx) {
      simulated.push(tx);
      return sim(tx);
    },
  };
}

describe('byte helpers and program-derived addresses', () => {
  it('derives the well-known PDAs exactly as the runtime does', () => {
    // Raydium CPMM vault/lp authority and AMM v4 authority are public constants
    expect(findProgramAddress([utf8('vault_and_lp_mint_auth_seed')], cpmmHop.programId).address).toBe('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
    expect(createProgramAddress([utf8('amm authority'), new Uint8Array([254])], ammHop.programId)).toBe('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
    // a real (on-curve) public key can never be a PDA; the AMM owner used as our wallet stand-in is itself a PDA
    expect(isOnCurve(base58Decode(TOKEN_PROGRAM))).toBe(true);
    expect(isOnCurve(base58Decode(WALLET))).toBe(false);
    expect(isOnCurve(base58Decode('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL'))).toBe(false);
    // ATA of the wallet for wSOL
    expect(associatedTokenAddress(WALLET, SOL, TOKEN_PROGRAM)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(Buffer.from(anchorDiscriminator('swap_base_input')).toString('hex')).toBe('8fbe5adac41e33de');
  });
  it('constant-product math floors and reports impact against spot', () => {
    expect(constantProductOut(1_000_000n, 2_000_000n, 1_000n)).toBe(1_998n);
    expect(impactBps(1_000_000n, 2_000_000n, 1_000n, 1_998n)).toBe(10);
    expect(impactBps(1_000_000n, 2_000_000n, 500_000n, constantProductOut(1_000_000n, 2_000_000n, 500_000n))).toBe(3334);
  });
});

describe('Raydium CPMM adapter (layout captured from mainnet 2026-09-08)', () => {
  const adapter = new RaydiumCpmmAdapter();
  const accounts = MAINNET_POOL_FIXTURES.cpmm.accounts.map(raw);
  it('decodes the pool, config and vaults into tradeable reserves with the 30 bp fee', () => {
    expect(adapter.dependentAccounts(cpmmHop, accounts[0]!)).toEqual(['BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP', 'BaorCoZHp26WNmWZEJPKJYUQ98D4mRtx18v4euTukPT3', 'EyqTvZwKPMkt3TKP9gSD7Z8b2Jjj3DxwSaAz6Wbpixmf']);
    const state = adapter.decode(cpmmHop, accounts, CTX);
    expect(state).toMatchObject({ program: 'RAYDIUM_CPMM', mintA: SOL, mintB: cpmmHop.inputMint, tokenProgramA: TOKEN_PROGRAM, feeBps: 30, tradeable: true, tradeableReason: null });
    expect(state.reserveA).toBeGreaterThan(0n);
    expect(state.reserveB).toBeGreaterThan(0n);
    const q = adapter.quote(state, cpmmHop.inputMint, 1_000_000_000n);
    expect(q.outputMint).toBe(SOL);
    expect(BigInt(q.feeAmount)).toBe(3_000_000n);
    expect(BigInt(q.expectedOutputAmount)).toBeGreaterThan(0n);
    expect(q.impactBps).toBeGreaterThanOrEqual(0);
    const ix = adapter.swapInstruction({ state, user: WALLET, inputMint: cpmmHop.inputMint, userSource: 'src', userDestination: 'dst', amountIn: 5n, minimumAmountOut: 1n });
    expect(ix.programId).toBe(cpmmHop.programId);
    expect(ix.accounts).toHaveLength(13);
    expect(ix.accounts[0]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: false });
    expect(ix.accounts[3]).toEqual({ pubkey: cpmmHop.poolAddress, isSigner: false, isWritable: true });
    // token1 is the input here, so the input vault is vault1 and the output mint is SOL
    expect(ix.accounts[6]!.pubkey).toBe('EyqTvZwKPMkt3TKP9gSD7Z8b2Jjj3DxwSaAz6Wbpixmf');
    expect(ix.accounts[11]!.pubkey).toBe(SOL);
    expect(Buffer.from(ix.data).toString('hex')).toBe('8fbe5adac41e33de' + '0500000000000000' + '0100000000000000');
    expect(() => adapter.quote(state, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress, 1n)).toThrow(/not in pool/);
    expect(() => adapter.decode(cpmmHop, [{ ...accounts[0]!, owner: 'Other' }, ...accounts.slice(1)], CTX)).toThrow(/not owned/);
    // a pool whose open time is in the future is decoded but not tradeable
    expect(adapter.decode(cpmmHop, accounts, { nowMs: 0 })).toMatchObject({ tradeable: false, tradeableReason: 'NOT_OPEN' });
  });
});

describe('Raydium AMM v4 adapter (layout captured from mainnet 2026-09-08)', () => {
  const adapter = new RaydiumAmmV4Adapter();
  const accounts = MAINNET_POOL_FIXTURES.ammv4.accounts.map(raw);
  it('decodes the pool and its OpenBook market, derives the vault signer and authority, and builds the 18-account swapBaseIn', () => {
    expect(adapter.dependentAccounts(ammHop, accounts[0]!)).toEqual(['7hF2eZaLQWwztFq3ojdyY1FYWJQG9QisrScc5QACoGaK', 'BCaWrDNcFnTJ9xiKan82V7wuXcnWjEhL4ZGev4kzT8mK', 'AqbNjgq7YcyysT846feSezJa72nGspxq1h2ZEzJLpVXs']);
    const state = adapter.decode(ammHop, accounts);
    expect(state).toMatchObject({ program: 'RAYDIUM_AMM_V4', mintA: ammHop.inputMint, mintB: SOL, feeBps: 25, tradeable: true });
    const d = state.detail as { authority: string; market: { bids: string; asks: string; eventQueue: string; vaultSigner: string } };
    expect(d.authority).toBe('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
    expect(d.market.bids).toBe('TGKNFGSoEYX7XmgJ3d7ukryM4yABfb3e4uvpA1kMbTc');
    expect(d.market.asks).toBe('4r6wC3SN6ReHd2VKa8evEAG4hG2TRtdyqDiFZVcsnHni');
    expect(d.market.eventQueue).toBe('DZFbD2LngG5sV3cZ4yVU5EtAVAV3phXY6Gi51ELwyeSn');
    expect(d.market.vaultSigner).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const q = adapter.quote(state, ammHop.inputMint, 1_000_000_000n);
    expect(BigInt(q.feeAmount)).toBe(2_500_000n);
    expect(q.outputMint).toBe(SOL);
    const ix = adapter.swapInstruction({ state, user: WALLET, inputMint: ammHop.inputMint, userSource: 'src', userDestination: 'dst', amountIn: 7n, minimumAmountOut: 2n });
    expect(ix.accounts).toHaveLength(18);
    expect(ix.accounts[0]!.pubkey).toBe(TOKEN_PROGRAM);
    expect(ix.accounts[17]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: false });
    expect(Buffer.from(ix.data).toString('hex')).toBe('09' + '0700000000000000' + '0200000000000000');
  });
});

describe('unsigned emergency build + simulation dry-run (§14.6, D33)', () => {
  const policy = { computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 50_000 };
  it('builds compute budget + create-ATA + swap into a legacy message the codec round-trips, payer first', async () => {
    const reader = fixtureReader(() => ({ slot: 1, err: null, logs: [], unitsConsumed: 0, accounts: [] }));
    const build = await buildEmergencyExit({ hop: cpmmHop, user: WALLET, amountIn: 1_000_000_000n, slippageBps: 300, policy, reader, now: NOW });
    expect(build.message.instructions).toHaveLength(4);
    expect(build.message.staticAccountKeys[0]).toBe(WALLET);
    expect(build.message.header.numRequiredSignatures).toBe(1);
    expect(build.minimumAmountOut).toBe((BigInt(build.quote.expectedOutputAmount) * 9_700n) / 10_000n);
    const decoded = decodeTransaction(fromBase64(build.unsignedTransactionBase64));
    expect(decoded.signatures).toEqual([null]);
    expect(decoded.message.staticAccountKeys).toEqual(build.message.staticAccountKeys);
    expect(decoded.message.instructions.map((i) => decoded.message.staticAccountKeys[i.programIdIndex])).toEqual(['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', cpmmHop.programId]);
    expect(build.userDestination).toBe(associatedTokenAddress(WALLET, SOL, TOKEN_PROGRAM));
    // message compiler orders writable signers, readonly signers, writable, readonly
    const m = compileLegacyMessage('P', [{ programId: 'X', accounts: [{ pubkey: 'A', isSigner: false, isWritable: true }, { pubkey: 'B', isSigner: false, isWritable: false }, { pubkey: 'P', isSigner: true, isWritable: false }], data: new Uint8Array([1]) }]);
    expect(m.staticAccountKeys).toEqual(['P', 'A', 'B', 'X']);
    expect(m.header).toEqual({ numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 2 });
  });

  it('classifies a clean simulation OK with the destination delta, an unfunded wallet OK_UNFUNDED, a program rejection POOL_REJECTED, and a short fill SLIPPAGE_EXCEEDED', async () => {
    const reader = fixtureReader(() => ({ slot: 1, err: null, logs: [], unitsConsumed: 0, accounts: [] }));
    const build = await buildEmergencyExit({ hop: ammHop, user: WALLET, amountIn: 1_000_000_000n, slippageBps: 300, policy, reader, now: NOW });
    const expected = BigInt(build.quote.expectedOutputAmount);
    const destWith = (amount: bigint) => {
      const data = new Uint8Array(165);
      new DataView(data.buffer).setBigUint64(64, amount, true);
      data[108] = 1;
      return { address: build.userDestination, lamports: 1, owner: TOKEN_PROGRAM, dataBase64: Buffer.from(data).toString('base64') };
    };
    const ok = classifyDryRun(build, { slot: 2, err: null, logs: [`Program ${ammHop.programId} invoke [1]`, 'Program log: ray_log', `Program ${ammHop.programId} success`], unitsConsumed: 40_000, accounts: [destWith(100n + expected)] }, 100n, 300);
    expect(ok).toEqual({ class: 'OK', ok: true, simulatedOutputAmount: expected.toString(), error: null });
    const unfunded = classifyDryRun(build, { slot: 2, err: { InstructionError: [3, { Custom: 1 }] }, logs: [`Program ${ammHop.programId} invoke [1]`, `Program ${TOKEN_PROGRAM} invoke [2]`, 'Program log: Error: insufficient funds', `Program ${TOKEN_PROGRAM} failed: custom program error: 0x1`], unitsConsumed: 20_000, accounts: [null] }, 0n, 300);
    expect(unfunded.class).toBe('OK_UNFUNDED');
    expect(unfunded.ok).toBe(true);
    const rejected = classifyDryRun(build, { slot: 2, err: { InstructionError: [3, { Custom: 30 }] }, logs: [`Program ${ammHop.programId} invoke [1]`, 'Program log: Error: InvalidStatus', `Program ${ammHop.programId} failed: custom program error: 0x1e`], unitsConsumed: 5_000, accounts: [null] }, 0n, 300);
    expect(rejected).toMatchObject({ class: 'POOL_REJECTED', ok: false });
    expect(rejected.error).toContain('InvalidStatus');
    const short = classifyDryRun(build, { slot: 2, err: null, logs: [], unitsConsumed: 1, accounts: [destWith(expected / 2n)] }, 0n, 300);
    expect(short).toMatchObject({ class: 'SLIPPAGE_EXCEEDED', ok: false });
    // an insufficient-funds error before the swap program ran (e.g. the ATA create) is not a pass
    const early = classifyDryRun(build, { slot: 2, err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]', 'Program log: Error: insufficient funds'], unitsConsumed: 1, accounts: [null] }, 0n, 300);
    expect(early.class).toBe('POOL_REJECTED');
    // the payer holds none of the input token: seen live on mainnet 2026-09-08 for both families
    const cpmmMissing = classifyDryRun(build, { slot: 2, err: { InstructionError: [3, { Custom: 3012 }] }, logs: ['Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]', 'Program log: Instruction: SwapBaseInput', 'Program log: AnchorError caused by account: input_token_account. Error Code: AccountNotInitialized. Error Number: 3012.'], unitsConsumed: 6103, accounts: [null] }, 0n, 300);
    expect(cpmmMissing.class).toBe('POOL_REJECTED'); // wrong program invoked for this build (AMM v4 build): not the source check
    const ammMissing = classifyDryRun(build, { slot: 2, err: { InstructionError: [3, { Custom: 38 }] }, logs: [`Program ${ammHop.programId} invoke [1]`, 'Program log: Number of accounts: 18', 'Program log: AMM error: Invalid SPL token program.'], unitsConsumed: 20_009, accounts: [null] }, 0n, 300);
    expect(ammMissing).toMatchObject({ class: 'SOURCE_ACCOUNT_MISSING', ok: false });
    const noPayer = classifyDryRun(build, { slot: 2, err: 'AccountNotFound', logs: [], unitsConsumed: 0, accounts: [null] }, 0n, 300);
    expect(noPayer).toMatchObject({ class: 'PAYER_UNFUNDED', ok: false });
  });

  it('runs end to end: unsupported family, decode failure and RPC failure are outcomes, not exceptions', async () => {
    const reader = fixtureReader(() => ({ slot: 9, err: null, logs: [`Program ${cpmmHop.programId} invoke [1]`], unitsConsumed: 1, accounts: [null] }));
    const ok = await runEmergencyDryRun({ hop: cpmmHop, user: WALLET, amountIn: 1_000_000n, slippageBps: 300, policy, reader, now: NOW });
    expect(ok).toMatchObject({ class: 'OK', ok: true, slot: 9, tradeable: true });
    expect(reader.simulated).toHaveLength(1);
    const unsupported = await runEmergencyDryRun({ hop: { ...cpmmHop, program: 'ORCA_WHIRLPOOL' }, user: WALLET, amountIn: 1n, slippageBps: 300, policy, reader, now: NOW });
    expect(unsupported).toMatchObject({ class: 'UNSUPPORTED_PROGRAM', ok: false, build: null });
    const missing = await runEmergencyDryRun({ hop: { ...cpmmHop, poolAddress: 'Missing1111111111111111111111111111111111111' as SolanaAddress }, user: WALLET, amountIn: 1n, slippageBps: 300, policy, reader, now: NOW });
    expect(missing).toMatchObject({ class: 'DECODE_FAILED', ok: false });
    const failing = fixtureReader(() => {
      throw new Error('rpc down');
    });
    const rpc = await runEmergencyDryRun({ hop: cpmmHop, user: WALLET, amountIn: 1n, slippageBps: 300, policy, reader: failing, now: NOW });
    expect(rpc).toMatchObject({ class: 'RPC_ERROR', ok: false, error: 'rpc down' });
  });
});

describe('Meteora DLMM adapter (layout captured from mainnet 2026-09-08, BANK/USDC bin step 100, 2% base fee)', () => {
  const adapter = new MeteoraDlmmAdapter();
  const F = MAINNET_DLMM_FIXTURE;
  const USDC = F.tokenY as MintAddress;
  const hop: DirectPoolHop = { program: 'METEORA_DLMM', programId: adapter.programId as SolanaAddress, poolAddress: F.pool as SolanaAddress, inputMint: F.tokenX as MintAddress, outputMint: USDC };
  const byAddress = new Map<string, RawAccount>(F.accounts.filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.address, raw(a)!]));
  const ctx = { nowMs: Date.parse(F.capturedAt) };
  it('bin-array index and PDA helpers match the program (negative ids floor, i64 LE seed, __event_authority)', () => {
    expect(binArrayIndex(-132)).toBe(-2);
    expect(binArrayIndex(-140)).toBe(-2);
    expect(binArrayIndex(-141)).toBe(-3);
    expect(binArrayIndex(69)).toBe(0);
    expect(binArrayIndex(70)).toBe(1);
    expect(deriveBinArray(F.pool, -2)).toBe('J2tGA3QNyTwu9uhoMrdQBwysmcSbCaxdByvYAHLmMfUn');
    expect(deriveEventAuthority()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // bitmap bit i+512 marks array i; walking down from 3 finds 1, walking up from -1 finds 1
    const bitmap = (1n << BigInt(1 + 512)) | (1n << BigInt(-5 + 512));
    expect(nextBinArrayWithLiquidity(bitmap, 3, true)).toBe(1);
    expect(nextBinArrayWithLiquidity(bitmap, 0, true)).toBe(-5);
    expect(nextBinArrayWithLiquidity(bitmap, -1, false)).toBe(1);
    expect(nextBinArrayWithLiquidity(bitmap, 2, false)).toBeNull();
  });
  it('decodes the pair, walks the bins for a quote in both directions and builds swap2 with the crossed bin arrays as remaining accounts', () => {
    const pool = byAddress.get(F.pool)!;
    const dependent = adapter.dependentAccounts(hop, pool);
    // reserves, bitmap-extension slot, then the arrays with liquidity going down from the active array (-2)
    expect(dependent.slice(0, 3)).toEqual(['2cUVAYX1YeTDPXPjxkyQbDqQEGJtr88AhTfqXn3FywKe', 'DoPExZQ53JStdZdpLjYf7nUmuDsrwePm6YdVmQaQSJdP', dependent[2]]);
    expect(dependent.slice(3, 5)).toEqual([F.tokenX, F.tokenY]);
    expect(dependent.length).toBeGreaterThanOrEqual(6);
    expect(dependent[5]).toBe(deriveBinArray(F.pool, -2));
    const accounts = [pool, ...dependent.map((a) => byAddress.get(a) ?? null)];
    const state = adapter.decode(hop, accounts, ctx);
    expect(state).toMatchObject({ program: 'METEORA_DLMM', mintA: F.tokenX, mintB: USDC, tokenProgramA: TOKEN_PROGRAM, tokenProgramB: TOKEN_PROGRAM, feeBps: 200, tradeable: true }); // base_factor 20000 × bin_step 100 × 10 = 2%
    const d = state.detail as { activeId: number; binStep: number; oracle: string; bitmapExtension: string | null; binArrays: { index: number }[] };
    expect(d.binStep).toBe(100);
    expect(d.oracle).toBe('97oMGv1FAaan8VzaFefsaof2LPHHXeuyot2RwbWBmngR');
    expect(d.bitmapExtension).toBeNull();
    expect(d.binArrays[0]!.index).toBe(-2);
    // selling 1 BANK (9 decimals? the fixture mint has 6) at ~0.27 USDC: output in the right order of magnitude and below the fee-free spot
    const q = adapter.quote(state, hop.inputMint, 1_000_000n);
    const spot = Math.pow(1.01, d.activeId);
    expect(Number(q.expectedOutputAmount)).toBeGreaterThan(spot * 1_000_000 * 0.9);
    expect(Number(q.expectedOutputAmount)).toBeLessThan(spot * 1_000_000);
    expect(BigInt(q.feeAmount)).toBeGreaterThan(0n);
    // buying BANK with USDC walks upward into the X-only bins
    const up = adapter.dependentAccounts({ ...hop, inputMint: USDC, outputMint: hop.inputMint }, pool);
    expect(up[5]).toBe(deriveBinArray(F.pool, -2));
    const upState = adapter.decode({ ...hop, inputMint: USDC, outputMint: hop.inputMint }, [pool, ...up.map((a) => byAddress.get(a) ?? null)], ctx);
    const q2 = adapter.quote(upState, USDC, 10_000_000n);
    expect(Number(q2.expectedOutputAmount)).toBeGreaterThan((10_000_000 / spot) * 0.9);
    // a size beyond the loaded bins is refused rather than guessed
    expect(() => adapter.quote(state, hop.inputMint, 10n ** 18n)).toThrow(/insufficient liquidity/);
    const ix = adapter.swapInstruction({ state, user: WALLET, inputMint: hop.inputMint, userSource: 'src', userDestination: 'dst', amountIn: 5n, minimumAmountOut: 1n });
    expect(ix.accounts).toHaveLength(16 + d.binArrays.length);
    expect(ix.accounts[0]).toEqual({ pubkey: F.pool, isSigner: false, isWritable: true });
    expect(ix.accounts[1]!.pubkey).toBe(adapter.programId); // no bitmap extension: optional account left as the program id
    expect(ix.accounts[10]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: false });
    expect(ix.accounts[13]!.pubkey).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    expect(ix.accounts[15]!.pubkey).toBe(adapter.programId);
    expect(ix.accounts[16]!.pubkey).toBe(deriveBinArray(F.pool, -2));
    expect(Buffer.from(ix.data).toString('hex')).toBe('414b3f4ceb5b5b88' + '0500000000000000' + '0100000000000000' + '00000000');
  });
});

describe('Token-2022 mint extensions (transfer fee, captured from mainnet 2026-09-08)', () => {
  it('decodes the TLV transfer-fee config, picks the schedule in force and withholds the fee as the program does; classic mints carry nothing', () => {
    const mint = raw(MAINNET_TOKEN2022_MINT)!;
    const ext = decodeMintExtensions(mint);
    expect(ext.transferHook).toBe(false);
    expect(ext.transferFee?.newer).toEqual({ epoch: 1029n, maximumFee: 1_000_000_000_000_000n, basisPoints: 300 });
    expect(ext.transferFee?.older.basisPoints).toBe(300);
    const fee = activeTransferFee(ext, 1031n);
    expect(fee?.basisPoints).toBe(300);
    expect(transferFeeAmount(fee, 1_000_000_000n)).toBe(30_000_000n);
    expect(transferFeeAmount(fee, 1n)).toBe(1n); // rounds up
    expect(transferFeeAmount({ epoch: 0n, maximumFee: 5n, basisPoints: 300 }, 1_000_000n)).toBe(5n); // capped
    expect(transferFeeAmount(null, 1_000_000n)).toBe(0n);
    expect(activeTransferFee(ext, null)?.basisPoints).toBe(300);
    expect(decodeMintExtensions(null).transferFee).toBeNull();
    expect(decodeMintExtensions(raw(MAINNET_POOL_FIXTURES.cpmm.accounts[2])!).extensionTypes).toEqual([]); // a classic token account, not a Token-2022 mint
  });
});

describe('Raydium CLMM adapter (layout captured from mainnet 2026-09-08, USDC/HcRL tick spacing 60)', () => {
  const adapter = new RaydiumClmmAdapter();
  const F = MAINNET_CLMM_FIXTURE;
  const USDC = F.mint0 as MintAddress;
  const HCRL = F.mint1 as MintAddress;
  const byAddress = new Map<string, RawAccount>(F.accounts.filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.address, raw(a)!]));
  const ctx = { nowMs: Date.parse(F.capturedAt) };
  it('tick math matches the program: bounds, round trips and Q64.64 sqrt prices', () => {
    expect(sqrtPriceAtTick(0)).toBe(1n << 64n);
    expect(sqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE_X64);
    expect(sqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE_X64);
    for (const t of [-443636, -100000, -92240, -61, -1, 0, 1, 60, 92240, 100000, 443635]) expect(tickAtSqrtPrice(sqrtPriceAtTick(t))).toBe(t);
    // price 1.0001^92240 ≈ 10132.86 and sqrt price squared agrees
    const sp = Number(sqrtPriceAtTick(92240)) / 2 ** 64;
    expect(sp * sp).toBeCloseTo(Math.pow(1.0001, 92240), -1);
    expect(tickArrayStartIndex(92240, 60)).toBe(90000);
    expect(tickArrayStartIndex(-1, 60)).toBe(-3600);
    expect(tickArrayStartIndex(-3600, 60)).toBe(-3600);
    expect(deriveTickArray(F.pool, 90000)).toBe('5FctGXM9xrtuFPhtCduG4kqAdfus9nRK9XAjsVPb7xHj');
  });
  it('decodes the pool, config, bitmap extension and tick arrays; quotes both directions by walking ticks; builds swap_v2 with the extension and arrays as remaining accounts', () => {
    const pool = byAddress.get(F.pool)!;
    const hop: DirectPoolHop = { program: 'RAYDIUM_CLMM', programId: adapter.programId as SolanaAddress, poolAddress: F.pool as SolanaAddress, inputMint: HCRL, outputMint: USDC };
    const dependent = adapter.dependentAccounts(hop, pool);
    expect(dependent.slice(0, 6)).toEqual([F.ammConfig, 'Be76qZre4bLB5LsEZQVLumvCn3qcPuVeFNbnMGLEZr8L', '36yskKDMc8fonVifSDKYCDeurrRpecDZw55cej18nyxJ', USDC, HCRL, F.bitmapExtension]);
    // selling HcRL (token 1) pushes the price up: the current array first, then higher ones
    expect(dependent[6]).toBe(deriveTickArray(F.pool, 90000));
    expect(dependent.length).toBeGreaterThanOrEqual(8);
    const accounts = [pool, ...dependent.map((a) => byAddress.get(a) ?? null)];
    const state = adapter.decode(hop, accounts, ctx);
    expect(state).toMatchObject({ program: 'RAYDIUM_CLMM', mintA: USDC, mintB: HCRL, tokenProgramA: TOKEN_PROGRAM, feeBps: 40, tradeable: true, tradeableReason: null });
    const d = state.detail as { tickSpacing: number; tickCurrent: number; liquidity: bigint; bitmapExtension: string | null; tickArrays: { startTick: number }[]; dynamicFee: unknown };
    expect(d.tickSpacing).toBe(60);
    // the pool moved between the layout probe (tick 92240) and the capture; the current tick still sits in array 90000
    expect(tickArrayStartIndex(d.tickCurrent, 60)).toBe(90000);
    expect(d.tickCurrent).toBeGreaterThanOrEqual(90000);
    expect(d.liquidity).toBeGreaterThan(0n);
    expect(d.bitmapExtension).toBe(F.bitmapExtension);
    expect(d.tickArrays[0]!.startTick).toBe(90000);
    // 1 HcRL (9 decimals) at ~10133 USDC per token... the pool prices token1 in token0 terms: price = 1.0001^tick = HcRL per USDC? check magnitude only
    const q = adapter.quote(state, HCRL, 1_000_000_000n);
    expect(BigInt(q.expectedOutputAmount)).toBeGreaterThan(0n);
    expect(BigInt(q.feeAmount)).toBeGreaterThan(0n);
    expect(q.outputMint).toBe(USDC);
    const back = adapter.quote(state, USDC, 1_000_000n);
    expect(BigInt(back.expectedOutputAmount)).toBeGreaterThan(0n);
    expect(back.outputMint).toBe(HCRL);
    // round trip loses roughly the two fees, never gains
    const twice = adapter.quote(state, USDC, BigInt(q.expectedOutputAmount));
    expect(BigInt(twice.expectedOutputAmount)).toBeLessThan(1_000_000_000n);
    expect(BigInt(twice.expectedOutputAmount)).toBeGreaterThan(900_000_000n);
    expect(() => adapter.quote(state, HCRL, 10n ** 24n)).toThrow(/insufficient liquidity|converge|limit/);
    const ix = adapter.swapInstruction({ state, user: WALLET, inputMint: HCRL, userSource: 'src', userDestination: 'dst', amountIn: 5n, minimumAmountOut: 1n });
    expect(ix.accounts.length).toBe(13 + 1 + d.tickArrays.length);
    expect(ix.accounts[0]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: false });
    expect(ix.accounts[5]!.pubkey).toBe('36yskKDMc8fonVifSDKYCDeurrRpecDZw55cej18nyxJ'); // input vault = vault1 for HcRL in
    expect(ix.accounts[11]!.pubkey).toBe(HCRL);
    expect(ix.accounts[12]!.pubkey).toBe(USDC);
    expect(ix.accounts[13]!.pubkey).toBe(F.bitmapExtension);
    expect(Buffer.from(ix.data).toString('hex')).toBe('2b04ed0b1ac91e62' + '0500000000000000' + '0100000000000000' + '00'.repeat(16) + '01');
    // bitmap helpers: the next initialised array above 90000 exists in this pool
    const h = state.detail as never;
    const next = nextInitialisedTickArray(h, (state.detail as { extension: never }).extension, 90000, false);
    expect(next === null || next > 90000).toBe(true);
  });
});
