import fc from 'fast-check';
import {
  addMs,
  DEFAULT_ELIGIBILITY_POLICY,
  toInstant,
  UNAVAILABLE_REASONS,
  type MintChainState,
  type PriceImpactProbe,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { evaluateEligibility, type EligibilityInputs } from './engine.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintChainState['mintAddress'];
const ID = '33333333-3333-4333-8333-333333333333' as Uuid;
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;

const cleanChain = (over: Partial<MintChainState> = {}): MintChainState => ({
  mintAddress: MINT, readAt: NOW, slot: 100 as MintChainState['slot'], programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never, tokenProgram: 'TOKEN', isInitialized: true, decimals: 6,
  supply: '1000000000' as never, mintAuthority: 'NONE', freezeAuthority: 'NONE', extensions: [], transferFeeBps: null, maxTransferFee: null, transferHookProgram: null, permanentDelegate: null,
  defaultAccountFrozen: false, nonTransferable: false, mintCloseAuthority: false, paused: false, largestAccounts: [],
  concentration: { source: 'CHAIN', chainSlot: 100 as never, top1: 0.05, top5: 0.15, top10: 0.2, top20: 0.25, analyticsMismatch: false },
  ...over,
});
const freshSecurity = (over: Partial<TokenSecurityReport> = {}): TokenSecurityReport => ({
  mintAddress: MINT, provider: 'BIRDEYE', observedAt: NOW, creatorAddress: null, creatorPercentage: 1, ownerPercentage: null, top10HolderPercent: 22, top10UserPercent: null, metaplexUpdateAuthorityPercent: null,
  mutableMetadata: false, freezeable: false, freezeAuthority: null, transferFeeEnabled: false, transferFeeBps: null, isToken2022: false, nonTransferable: false, jupStrictList: true, fakeToken: false, isTrueToken: true,
  creationAt: addMs(NOW, -30 * 86_400_000), totalSupply: '1000000000', preMarketHolderCount: 0, ...over,
});
const healthyOverview = (over: Partial<TokenOverview> = {}): TokenOverview => ({
  mintAddress: MINT, symbol: 'X', name: 'X', decimals: 6, priceUsd: 1, liquidityUsd: 500_000, marketCapUsd: null, fdvUsd: null, holderCount: 5_000, numberMarkets: 3, lastTradeAt: NOW, providerUpdatedAt: NOW, observedAt: NOW,
  windows: Object.fromEntries(['m30', 'h1', 'h2', 'h4', 'h8', 'h24'].map((w) => [w, { volumeUsd: w === 'h24' ? 2_000_000 : null, buyVolumeUsd: null, sellVolumeUsd: null, tradeCount: null, buyCount: null, sellCount: null, uniqueWallets: null, priceChangePct: null }])) as never,
  ...over,
});
const goodProbes = (): PriceImpactProbe[] => DEFAULT_ELIGIBILITY_POLICY.probeSizesUsd.map((sizeUsd) => ({ sizeUsd, inputAmount: '1000000' as never, impactBps: 50 as never, routeFound: true, probedAt: NOW }));

const base = (over: Partial<EligibilityInputs> = {}): EligibilityInputs => ({ id: ID, assetId: ASSET, chain: cleanChain(), security: freshSecurity(), overview: healthyOverview(), probes: goodProbes(), settlementRouteConfirmed: true, now: NOW, policy: DEFAULT_ELIGIBILITY_POLICY, ...over });

describe('eligibility engine (§7.2–7.4, D45)', () => {
  it('a clean token with fresh corroboration, liquidity and a confirmed exit route is ELIGIBLE with full grade', () => {
    const r = evaluateEligibility(base());
    expect(r.outcome).toBe('ELIGIBLE');
    expect(r.record).toMatchObject({ eligible: true, hardReject: false, grade: 100, rejectionReasons: [], jupiterRouteAvailable: true, settlementRouteConfirmed: true, policyVersion: 'eligibility-v1' });
    expect(r.record.freshness).toEqual({ securityProviderAt: NOW, chainReadAt: NOW, chainSlot: 100 });
  });

  it.each([
    ['freeze authority present', { chain: cleanChain({ freezeAuthority: 'PRESENT' }) }, 'FREEZE_AUTHORITY_PRESENT'],
    ['mint authority present', { chain: cleanChain({ mintAuthority: 'PRESENT' }) }, 'MINT_AUTHORITY_PRESENT'],
    ['non-transferable', { chain: cleanChain({ nonTransferable: true, tokenProgram: 'TOKEN_2022' }) }, 'NON_TRANSFERABLE'],
    ['default frozen', { chain: cleanChain({ defaultAccountFrozen: true, tokenProgram: 'TOKEN_2022' }) }, 'DEFAULT_ACCOUNT_FROZEN'],
    ['permanent delegate', { chain: cleanChain({ permanentDelegate: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as never, tokenProgram: 'TOKEN_2022' }) }, 'PERMANENT_DELEGATE'],
    ['transfer hook', { chain: cleanChain({ transferHookProgram: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as never, tokenProgram: 'TOKEN_2022' }) }, 'TRANSFER_HOOK'],
    ['transfer fee above max', { chain: cleanChain({ transferFeeBps: 500 as never, tokenProgram: 'TOKEN_2022' }) }, 'TRANSFER_FEE_ABOVE_MAX'],
    ['unknown program', { chain: cleanChain({ tokenProgram: 'UNKNOWN' }) }, 'UNKNOWN_TOKEN_PROGRAM'],
    ['zero supply', { chain: cleanChain({ supply: '0' as never }) }, 'SUPPLY_ZERO'],
    ['paused', { chain: cleanChain({ paused: true, tokenProgram: 'TOKEN_2022' }) }, 'MINT_PAUSED'],
    ['top-10 above max', { chain: cleanChain({ concentration: { source: 'CHAIN', chainSlot: 100 as never, top1: 0.5, top5: 0.6, top10: 0.7, top20: 0.8, analyticsMismatch: false } }) }, 'TOP10_CONCENTRATION_ABOVE_MAX'],
    ['liquidity below floor', { overview: healthyOverview({ liquidityUsd: 100 }) }, 'LIQUIDITY_BELOW_FLOOR'],
    ['stale security data', { security: freshSecurity({ observedAt: addMs(NOW, -2 * 3_600_000) }) }, 'SECURITY_DATA_STALE'],
    ['fake token', { security: freshSecurity({ fakeToken: true }) }, 'SECURITY_FAKE_TOKEN'],
    ['no settlement route', { settlementRouteConfirmed: false }, 'NO_EXIT_ROUTE'],
    ['impact above max', { probes: goodProbes().map((p) => ({ ...p, impactBps: 900 as never })) }, 'PRICE_IMPACT_ABOVE_MAX'],
    ['denylisted', { policy: { ...DEFAULT_ELIGIBILITY_POLICY, denylist: [MINT] } }, 'DENYLISTED'],
  ] as const)('hard reject: %s → BLOCKED with grade 0', (_label, over, reason) => {
    const r = evaluateEligibility(base(over as Partial<EligibilityInputs>));
    expect(r.outcome).toBe('BLOCKED');
    expect(r.record.hardReject).toBe(true);
    expect(r.record.rejectionReasons).toContain(reason);
    expect(r.record.grade).toBe(0);
  });

  it('D45: analytics contradicting chain truth blocks entry and marks the mismatch', () => {
    const r = evaluateEligibility(base({ security: freshSecurity({ freezeable: true }) }));
    expect(r.outcome).toBe('BLOCKED');
    expect(r.record.rejectionReasons).toContain('CHAIN_ANALYTICS_MISMATCH');
    expect(r.record.concentration?.analyticsMismatch).toBe(true);
    const conc = evaluateEligibility(base({ security: freshSecurity({ top10HolderPercent: 60 }) }));
    expect(conc.record.rejectionReasons).toContain('CHAIN_ANALYTICS_MISMATCH');
    const within = evaluateEligibility(base({ security: freshSecurity({ top10HolderPercent: 30 }) }));
    expect(within.record.concentration?.analyticsMismatch).toBe(false);
  });

  it('missing required data fails closed as EVALUATING, never as ELIGIBLE and never as BLOCKED', () => {
    for (const over of [{ security: null }, { overview: null }, { probes: [] }, { settlementRouteConfirmed: null }] as Partial<EligibilityInputs>[]) {
      const r = evaluateEligibility(base(over));
      expect(r.outcome).toBe('EVALUATING');
      expect(r.record.eligible).toBe(false);
      expect(r.record.hardReject).toBe(true);
      expect(r.record.rejectionReasons.every((x) => UNAVAILABLE_REASONS.includes(x as never))).toBe(true);
    }
  });

  it('soft findings lower the grade without blocking', () => {
    const r = evaluateEligibility(base({ overview: healthyOverview({ holderCount: 10, windows: healthyOverview().windows }), security: freshSecurity({ mutableMetadata: true, creationAt: addMs(NOW, -3_600_000), jupStrictList: false }) }));
    expect(r.outcome).toBe('ELIGIBLE');
    expect(r.record.rejectionReasons.sort()).toEqual(['HOLDERS_BELOW_FLOOR', 'MUTABLE_METADATA', 'NOT_ON_JUP_STRICT_LIST', 'TOKEN_AGE_BELOW_MIN'].sort());
    expect(r.record.grade).toBe(100 - 15 - 5 - 5 - 15);
  });

  it('property: a hard reject is never eligible and an eligible record never carries a hard reason', () => {
    const chainArb = fc.record({
      mintAuthority: fc.constantFrom('NONE', 'PRESENT' as const),
      freezeAuthority: fc.constantFrom('NONE', 'PRESENT' as const),
      nonTransferable: fc.boolean(),
      top10: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(chainArb, fc.boolean(), fc.boolean(), (c, hasSecurity, hasRoute) => {
        const r = evaluateEligibility(
          base({
            chain: cleanChain({ mintAuthority: c.mintAuthority, freezeAuthority: c.freezeAuthority, nonTransferable: c.nonTransferable, concentration: { source: 'CHAIN', chainSlot: 100 as never, top1: 0, top5: 0, top10: c.top10, top20: c.top10, analyticsMismatch: false } }),
            security: hasSecurity ? freshSecurity({ top10HolderPercent: c.top10 * 100 }) : null,
            probes: hasRoute ? goodProbes() : [],
            settlementRouteConfirmed: hasRoute ? true : null,
          }),
        );
        expect(r.record.eligible).toBe(!r.record.hardReject);
        expect(r.outcome === 'ELIGIBLE').toBe(r.record.eligible);
        const unsafe = c.mintAuthority === 'PRESENT' || c.freezeAuthority === 'PRESENT' || c.nonTransferable || c.top10 > DEFAULT_ELIGIBILITY_POLICY.maxTop10Fraction;
        if (unsafe) expect(r.record.eligible).toBe(false);
        if (!hasSecurity || !hasRoute) expect(r.record.eligible).toBe(false);
      }),
    );
  });
});
