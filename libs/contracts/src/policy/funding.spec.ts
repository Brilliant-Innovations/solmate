import fc from 'fast-check';
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, NATIVE_SOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, fundingCeilingVerdict, validateFundingInstructions, validateFundingTransfer, type FundingTransfer } from './funding.js';
import type { Amount, MintAddress, SolanaAddress } from '../primitives.js';

const TRADING = 'TradingWa11et11111111111111111111111111111' as SolanaAddress;
const SOURCE = 'SourceWa11et111111111111111111111111111111' as SolanaAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ATA = 'AtaOfTradingWa11et111111111111111111111111' as SolanaAddress;
const OTHER = 'SomeOtherAddress11111111111111111111111111' as SolanaAddress;
const expected = { tradingWallet: TRADING, settlementMint: USDC, cluster: 'mainnet-beta' as const, settlementAta: ATA };
const sol: FundingTransfer = { sourceWallet: SOURCE, destinationTradingWallet: TRADING, destinationAta: null, fundingMint: NATIVE_SOL_MINT, requestedAmount: '50000000' as Amount, cluster: 'mainnet-beta' };
const usdc: FundingTransfer = { ...sol, destinationAta: ATA, fundingMint: USDC, requestedAmount: '250000000' as Amount };

describe('typed funding guard (§20.18, §32 funding substitution)', () => {
  it('accepts the reviewed SOL and USDC transfers to the configured destination', () => {
    expect(validateFundingTransfer(sol, expected)).toEqual({ ok: true });
    expect(validateFundingTransfer(usdc, expected)).toEqual({ ok: true });
    expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING] }], sol)).toEqual({ ok: true });
    expect(validateFundingInstructions([
      { programAddress: COMPUTE_BUDGET_PROGRAM, accountAddresses: [] },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM, accountAddresses: [SOURCE, ATA, TRADING, USDC, SYSTEM_PROGRAM, TOKEN_PROGRAM] },
      { programAddress: TOKEN_PROGRAM, accountAddresses: [OTHER, USDC, ATA, SOURCE] },
    ], usdc)).toEqual({ ok: true });
  });

  it('refuses a substituted destination, mint, cluster, ATA or an extra instruction', () => {
    expect(validateFundingTransfer({ ...sol, destinationTradingWallet: OTHER }, expected)).toEqual({ ok: false, reasons: ['DESTINATION_MISMATCH'] });
    expect(validateFundingTransfer({ ...sol, cluster: 'devnet' }, expected)).toEqual({ ok: false, reasons: ['CLUSTER_MISMATCH'] });
    expect(validateFundingTransfer({ ...usdc, fundingMint: OTHER as unknown as MintAddress }, expected)).toEqual({ ok: false, reasons: ['MINT_NOT_ALLOWED'] });
    expect(validateFundingTransfer({ ...usdc, destinationAta: OTHER }, expected)).toEqual({ ok: false, reasons: ['ATA_MISMATCH'] });
    expect(validateFundingTransfer({ ...sol, sourceWallet: TRADING }, expected)).toEqual({ ok: false, reasons: ['SOURCE_IS_TRADING_WALLET'] });
    expect(validateFundingTransfer({ ...sol, requestedAmount: '0' as Amount }, expected)).toEqual({ ok: false, reasons: ['AMOUNT_INVALID'] });
    expect(validateFundingInstructions([{ programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, OTHER] }], sol)).toEqual({ ok: false, reasons: ['TRANSFER_DESTINATION_MISMATCH'] });
    expect(validateFundingInstructions([
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, TRADING] },
      { programAddress: SYSTEM_PROGRAM, accountAddresses: [SOURCE, OTHER] },
    ], sol).ok).toBe(false);
    expect(validateFundingInstructions([{ programAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accountAddresses: [] }], sol)).toEqual({ ok: false, reasons: ['UNKNOWN_PROGRAM', 'NO_TRANSFER'] });
    expect(validateFundingInstructions([], sol)).toEqual({ ok: false, reasons: ['NO_TRANSFER'] });
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
