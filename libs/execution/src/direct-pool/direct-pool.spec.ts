import type { DirectPoolHop, MintAddress, SolanaAddress } from '@sol-agent-trader/contracts';
import { base58Decode } from '@sol-agent-trader/solana-hard-state';
import type { SimulationOutcome, SimulationReader } from '../simulate/client.js';
import { decodeTransaction, fromBase64 } from '../tx/codec.js';
import { TOKEN_PROGRAM } from '../validate/programs.js';
import { anchorDiscriminator, associatedTokenAddress, createProgramAddress, findProgramAddress, isOnCurve, utf8 } from './bytes.js';
import { buildEmergencyExit, classifyDryRun, compileLegacyMessage, runEmergencyDryRun } from './dry-run.js';
import { MAINNET_POOL_FIXTURES } from './fixtures/mainnet-pools.js';
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
    const state = adapter.decode(ammHop, accounts, CTX);
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
    const unsupported = await runEmergencyDryRun({ hop: { ...cpmmHop, program: 'METEORA_DLMM' }, user: WALLET, amountIn: 1n, slippageBps: 300, policy, reader, now: NOW });
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
