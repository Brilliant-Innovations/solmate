import fc from 'fast-check';
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, DEFAULT_FUNDING_POLICY, NATIVE_SOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, fundingCeilingVerdict, fundingClaimVerdict, toInstructionDataHex, validateFundingInstructions, validateFundingTransfer, type FundingTransfer } from './funding.js';
import type { Amount, MintAddress, SolanaAddress } from '../primitives.js';

const TRADING = 'TradingWa11et11111111111111111111111111111' as SolanaAddress;
const SOURCE = 'SourceWa11et111111111111111111111111111111' as SolanaAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ATA = 'AtaOfTradingWa11et111111111111111111111111' as SolanaAddress;
const OTHER = 'SomeOtherAddress11111111111111111111111111' as SolanaAddress;
const expected = { tradingWallet: TRADING, settlementMint: USDC, cluster: 'mainnet-beta' as const, settlementAta: ATA };
const sol: FundingTransfer = { sourceWallet: SOURCE, destinationTradingWallet: TRADING, destinationAta: null, fundingMint: NATIVE_SOL_MINT, requestedAmount: '50000000' as Amount, cluster: 'mainnet-beta' };
const usdc: FundingTransfer = { ...sol, destinationAta: ATA, fundingMint: USDC, requestedAmount: '250000000' as Amount };

const le = (value: bigint, width: number): Uint8Array => {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

/** System `Transfer`: u32 discriminator 2, then u64 lamports. */
const systemTransferData = (lamports: bigint) => toInstructionDataHex(concat(le(2n, 4), le(lamports, 8)));
/** SPL `TransferChecked`: byte 12, u64 amount, u8 decimals. */
const transferCheckedData = (amount: bigint, decimals = 6) => toInstructionDataHex(concat([12], le(amount, 8), [decimals]));
/** ATA `CreateIdempotent`: a single byte 1. */
const createAtaData = () => toInstructionDataHex(Uint8Array.from([1]));
/** ComputeBudget `SetComputeUnitPrice`: byte 3, u64 micro-lamports. */
const priorityFeeData = (microLamports: bigint) => toInstructionDataHex(concat([3], le(microLamports, 8)));

describe('typed funding guard (§20.18, §32 funding substitution)', () => {
  it('accepts the reviewed SOL and USDC transfers to the configured destination', () => {
    expect(validateFundingTransfer(sol, expected)).toEqual({ ok: true });
    expect(validateFundingTransfer(usdc, expected)).toEqual({ ok: true });
    expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(50_000_000n) }], sol)).toEqual({ ok: true });
    expect(validateFundingInstructions([
      { programAddress: COMPUTE_BUDGET_PROGRAM, accountAddresses: [], data: priorityFeeData(1_000n) },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM, accountAddresses: [SOURCE, ATA, TRADING, USDC, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: createAtaData() },
      { programAddress: TOKEN_PROGRAM, accountAddresses: [OTHER, USDC, ATA, SOURCE], data: transferCheckedData(250_000_000n) },
    ], usdc)).toEqual({ ok: true });
  });

  it('refuses a substituted destination, mint, cluster, ATA or an extra instruction', () => {
    expect(validateFundingTransfer({ ...sol, destinationTradingWallet: OTHER }, expected)).toEqual({ ok: false, reasons: ['DESTINATION_MISMATCH'] });
    expect(validateFundingTransfer({ ...sol, cluster: 'devnet' }, expected)).toEqual({ ok: false, reasons: ['CLUSTER_MISMATCH'] });
    expect(validateFundingTransfer({ ...usdc, fundingMint: OTHER as unknown as MintAddress }, expected)).toEqual({ ok: false, reasons: ['MINT_NOT_ALLOWED'] });
    expect(validateFundingTransfer({ ...usdc, destinationAta: OTHER }, expected)).toEqual({ ok: false, reasons: ['ATA_MISMATCH'] });
    expect(validateFundingTransfer({ ...sol, sourceWallet: TRADING }, expected)).toEqual({ ok: false, reasons: ['SOURCE_IS_TRADING_WALLET'] });
    expect(validateFundingTransfer({ ...sol, requestedAmount: '0' as Amount }, expected)).toEqual({ ok: false, reasons: ['AMOUNT_INVALID'] });
    expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, OTHER], data: systemTransferData(50_000_000n) }], sol)).toEqual({ ok: false, reasons: ['TRANSFER_DESTINATION_MISMATCH'] });
    expect(validateFundingInstructions([
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(50_000_000n) },
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, OTHER], data: systemTransferData(50_000_000n) },
    ], sol).ok).toBe(false);
    expect(validateFundingInstructions([{ programAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accountAddresses: [], data: '' }], sol)).toEqual({ ok: false, reasons: ['UNKNOWN_PROGRAM', 'NO_TRANSFER'] });
    expect(validateFundingInstructions([], sol)).toEqual({ ok: false, reasons: ['NO_TRANSFER'] });
  });

  // The attack the guard exists to stop, and the one it used to miss: every account address the
  // guard checks is correct and only the encoded amount differs (review 2026-09-09, M-1).
  it('refuses a transfer whose encoded amount is not the reviewed amount, with every address correct', () => {
    expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(5_000_000_000n) }], sol)).toEqual({ ok: false, reasons: ['AMOUNT_MISMATCH'] });
    expect(validateFundingInstructions([{ programAddress: TOKEN_PROGRAM, accountAddresses: [OTHER, USDC, ATA, SOURCE], data: transferCheckedData(999_000_000n) }], usdc)).toEqual({ ok: false, reasons: ['AMOUNT_MISMATCH'] });
  });

  it('never accepts an amount other than the reviewed one (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 63n }), (lamports) => {
        fc.pre(lamports !== 50_000_000n);
        const v = validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(lamports) }], sol);
        return !v.ok && v.reasons.includes('AMOUNT_MISMATCH');
      }),
    );
  });

  it('refuses malformed instruction data rather than reading past it', () => {
    for (const data of ['', '02', '0c', '0200000000000000', 'ff'.repeat(12)]) {
      expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data }], sol).ok).toBe(false);
    }
    expect(validateFundingInstructions([{ programAddress: ASSOCIATED_TOKEN_PROGRAM, accountAddresses: [SOURCE, ATA, TRADING, USDC, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: '00' }, { programAddress: TOKEN_PROGRAM, accountAddresses: [OTHER, USDC, ATA, SOURCE], data: transferCheckedData(250_000_000n) }], usdc)).toEqual({ ok: false, reasons: ['INSTRUCTION_DATA_INVALID'] });
  });

  it('bounds the priority fee a compute-budget instruction may set', () => {
    const over = BigInt(DEFAULT_FUNDING_POLICY.maxPriorityFeeMicroLamports) + 1n;
    expect(validateFundingInstructions([
      { programAddress: COMPUTE_BUDGET_PROGRAM, accountAddresses: [], data: priorityFeeData(over) },
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(50_000_000n) },
    ], sol)).toEqual({ ok: false, reasons: ['PRIORITY_FEE_ABOVE_MAX'] });
    // An unknown compute-budget discriminator is data the guard cannot read, so it refuses.
    expect(validateFundingInstructions([
      { programAddress: COMPUTE_BUDGET_PROGRAM, accountAddresses: [], data: '07' },
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING], data: systemTransferData(50_000_000n) },
    ], sol)).toEqual({ ok: false, reasons: ['INSTRUCTION_DATA_INVALID'] });
  });

  it('never accepts a transfer whose destination is not the configured wallet (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{43}$/), (dest) => {
        fc.pre(dest !== TRADING);
        const v = validateFundingTransfer({ ...sol, destinationTradingWallet: dest as SolanaAddress }, expected);
        return !v.ok && v.reasons.includes('DESTINATION_MISMATCH');
      }),
    );
  });

  it('labels a funding that crosses the attested ceiling (D56) without refusing it', () => {
    expect(fundingCeilingVerdict({ recognizedUsd: 4_900, addUsd: 200, ceilingUsd: 5_000 })).toEqual({ exceeds: true, projectedUsd: 5_100 });
    expect(fundingCeilingVerdict({ recognizedUsd: 1_000, addUsd: 200, ceilingUsd: 5_000 })).toEqual({ exceeds: false, projectedUsd: 1_200 });
    expect(fundingCeilingVerdict({ recognizedUsd: null, addUsd: 200, ceilingUsd: null })).toEqual({ exceeds: false, projectedUsd: null });
  });
});
describe('funding claim against chain truth (§20.18, review M-2, M-3)', () => {
  const claim = { sourceWallet: SOURCE, destinationTradingWallet: TRADING, destinationAta: ATA, fundingMint: USDC, requestedAmount: '250000000' };
  const inflow = { kind: 'TOKEN' as const, fromOwner: SOURCE as string, toOwner: TRADING as string, toTokenAccount: ATA as string, mint: USDC as string, amount: '250000000' };
  const owned = new Set<string>([TRADING, ATA]);

  it('confirms the movement the operator actually reviewed', () => {
    expect(fundingClaimVerdict(claim, inflow, owned)).toEqual({ kind: 'EXPECTED' });
    expect(fundingClaimVerdict({ ...claim, destinationAta: null, fundingMint: NATIVE_SOL_MINT, requestedAmount: '50000000' }, { kind: 'SOL', fromOwner: SOURCE, toOwner: TRADING, toTokenAccount: null, mint: null, amount: '50000000' }, owned)).toEqual({ kind: 'EXPECTED' });
  });

  it('refuses a claim whose amount is not what the chain moved, and leaves the event unconfirmed', () => {
    expect(fundingClaimVerdict(claim, { ...inflow, amount: '999000000' }, owned)).toEqual({ kind: 'REFUSED', reason: 'FUNDING_AMOUNT_MISMATCH' });
    expect(fundingClaimVerdict(claim, { ...inflow, amount: 'not-a-number' }, owned)).toEqual({ kind: 'REFUSED', reason: 'FUNDING_AMOUNT_MISMATCH' });
  });

  it('refuses to call a movement out of one of our own addresses external funding (§31)', () => {
    const ownSource = new Set<string>([...owned, SOURCE as string]);
    expect(fundingClaimVerdict(claim, inflow, ownSource)).toEqual({ kind: 'REFUSED', reason: 'FUNDING_SOURCE_IS_OWNED' });
  });

  it('leaves a movement the claim does not describe to the ordinary classifier', () => {
    expect(fundingClaimVerdict(claim, { ...inflow, fromOwner: OTHER }, owned)).toEqual({ kind: 'NOT_THIS_MOVEMENT' });
    expect(fundingClaimVerdict(claim, { ...inflow, toTokenAccount: OTHER, toOwner: OTHER }, owned)).toEqual({ kind: 'NOT_THIS_MOVEMENT' });
    expect(fundingClaimVerdict(claim, { ...inflow, mint: OTHER }, owned)).toEqual({ kind: 'NOT_THIS_MOVEMENT' });
  });

  it('never confirms an amount other than the reviewed one (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 63n }), (amount) => {
        fc.pre(amount !== 250_000_000n);
        return fundingClaimVerdict(claim, { ...inflow, amount: amount.toString() }, owned).kind === 'REFUSED';
      }),
    );
  });
});
