import fc from 'fast-check';
import {
  addMs,
  DEFAULT_ELIGIBILITY_POLICY,
  DEFAULT_SAFETY_POLICY,
  toInstant,
  type AssetEligibility,
  type EmergencyExitRouteSnapshot,
  type MintChainState,
  type PriceImpactProbe,
  type SafetyBaseline,
  type TokenOverview,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { entryAllowed } from '../policy/eligibility-gate.js';
import { baselineFromChainState, evaluateHeldAssetSafety, exitCompatibility, type SafetyInputs } from './held-asset-safety.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 16, 0, 0));
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintChainState['mintAddress'];
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const ids = { id: '33333333-3333-4333-8333-333333333333' as Uuid, positionId: '44444444-4444-4444-8444-444444444444' as Uuid, assetId: '22222222-2222-4222-8222-222222222222' as Uuid };

const chain = (over: Partial<MintChainState> = {}): MintChainState => ({
  mintAddress: MINT, readAt: NOW, slot: 500 as never, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never, tokenProgram: 'TOKEN', isInitialized: true, decimals: 6, supply: '1000000000' as never,
  mintAuthority: 'NONE', freezeAuthority: 'NONE', extensions: [], transferFeeBps: null, maxTransferFee: null, transferHookProgram: null, permanentDelegate: null, defaultAccountFrozen: false, nonTransferable: false,
  mintCloseAuthority: false, paused: false, largestAccounts: [], concentration: { source: 'CHAIN', chainSlot: 500 as never, top1: 0.05, top5: 0.1, top10: 0.2, top20: 0.25, analyticsMismatch: false, programControlledFraction: null, excludedAccounts: null }, concentrationUnavailableReason: null, ...over,
});
const probe = (over: Partial<PriceImpactProbe> = {}): PriceImpactProbe => ({ sizeUsd: 1000, inputAmount: '1000000' as never, impactBps: 40 as never, routeFound: true, probedAt: NOW, ...over });
const snapshot = (over: Partial<EmergencyExitRouteSnapshot> = {}): EmergencyExitRouteSnapshot => ({
  id: '55555555-5555-4555-8555-555555555555' as Uuid, assetId: ids.assetId, hops: [{ program: 'RAYDIUM_CLMM', programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as never, poolAddress: POOL as never, inputMint: MINT, outputMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as never }],
  settlementMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as never, poolStateRef: 'x', lastRefreshedAt: NOW, lastRefreshSlot: 499 as never, capacity: [], token2022Compatible: true, lastDryRun: null, ...over,
});
const overview = (liquidityUsd: number | null): TokenOverview => ({
  mintAddress: MINT, symbol: 'JUP', name: 'Jupiter', decimals: 6, priceUsd: 1, liquidityUsd, marketCapUsd: null, fdvUsd: null, holderCount: null, numberMarkets: null, lastTradeAt: NOW, providerUpdatedAt: NOW, observedAt: NOW,
  windows: Object.fromEntries(['m30', 'h1', 'h2', 'h4', 'h8', 'h24'].map((w) => [w, { volumeUsd: null, buyVolumeUsd: null, sellVolumeUsd: null, tradeCount: null, buyCount: null, sellCount: null, uniqueWallets: null, priceChangePct: null }])) as never,
});
const baseline = (over: Partial<SafetyBaseline> = {}): SafetyBaseline => ({ source: 'ENTRY_ELIGIBILITY', freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: null, liquidityUsd: 100_000, top10: 0.2, emergencyPoolAddress: POOL, ...over });
const security = (over: Partial<NonNullable<SafetyInputs['security']>> = {}): NonNullable<SafetyInputs['security']> => ({
  mintAddress: MINT, provider: 'BIRDEYE', observedAt: NOW, creatorAddress: null, creatorPercentage: null, ownerPercentage: null, top10HolderPercent: null, top10UserPercent: null, metaplexUpdateAuthorityPercent: null, mutableMetadata: null, freezeable: false,
  freezeAuthority: null, transferFeeEnabled: null, transferFeeBps: null, isToken2022: false, nonTransferable: false, jupStrictList: true, fakeToken: false, isTrueToken: true, creationAt: null, totalSupply: null, preMarketHolderCount: null, ...over,
});

const healthy = (over: Partial<SafetyInputs> = {}): SafetyInputs => ({
  ...ids, positionQuantity: '1000000' as never, previousState: 'NORMAL', baseline: baseline(), chain: chain(), primarySellProbe: probe(), primaryQuoteUnavailable: false, previousUnknownRouteCycles: 0, emergencySnapshot: snapshot(), emergencyPoolVerified: true,
  overview: overview(100_000), security: security(), triggers: ['PERIODIC'], now: NOW, policy: DEFAULT_SAFETY_POLICY, ...over,
});

describe('exit compatibility (D34; M4 exit gate: entry ineligibility never disables the exit path)', () => {
  it('is a function of route facts and chain state only: an ineligible-for-entry asset still reduces', () => {
    const facts = { chain: chain({ mintAuthority: 'PRESENT' }), primarySellProbe: probe(), primaryQuoteUnavailable: false, previousUnknownRouteCycles: 0, emergencySnapshot: snapshot(), emergencyPoolVerified: true, now: NOW, policy: DEFAULT_SAFETY_POLICY };
    const compat = exitCompatibility(facts);
    expect(compat).toEqual({ primaryRouteAvailable: true, primaryImpactBps: 40, emergencyRouteAvailable: true, emergencySnapshotAgeMs: 0, token2022Compatible: true, canReduceNow: true });
    // The same asset is refused for entry by the eligibility gate; that verdict has no path into exitCompatibility.
    const ineligible: AssetEligibility = { id: ids.id, assetId: ids.assetId, evaluatedAt: NOW, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version, eligible: false, hardReject: true, rejectionReasons: ['MINT_AUTHORITY_PRESENT'], grade: 0, liquidityUsd: null, volume24hUsd: null, holderCount: null, concentration: null, mintAuthority: 'PRESENT', freezeAuthority: 'NONE', token2022: null, securityFlags: [], transferRestrictions: [], jupiterRouteAvailable: true, settlementRouteConfirmed: true, priceImpactProbes: [], insiderMetrics: null, emergencyExitRouteSnapshotId: null, freshness: { securityProviderAt: null, chainReadAt: NOW, chainSlot: 500 as never } };
    expect(entryAllowed(ineligible, NOW, DEFAULT_ELIGIBILITY_POLICY).allowed).toBe(false);
    expect(compat.canReduceNow).toBe(true);
  });

  it('property: canReduceNow is exactly "primary route found (and token movable) or a fresh, verified, compatible emergency route"', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 12 * 3_600_000 }), fc.boolean(), (routeFound, hasSnapshot, verified, ageMs, paused) => {
        const compat = exitCompatibility({ chain: chain({ paused, tokenProgram: paused ? 'TOKEN_2022' : 'TOKEN' }), primarySellProbe: probe({ routeFound }), primaryQuoteUnavailable: false, previousUnknownRouteCycles: 0, emergencySnapshot: hasSnapshot ? snapshot({ lastRefreshedAt: addMs(NOW, -ageMs) }) : null, emergencyPoolVerified: hasSnapshot ? verified : null, now: NOW, policy: DEFAULT_SAFETY_POLICY });
        const primary = routeFound && !paused;
        const emergency = hasSnapshot && verified && ageMs <= DEFAULT_SAFETY_POLICY.maxEmergencySnapshotAgeMs && !paused;
        expect(compat.primaryRouteAvailable).toBe(primary);
        expect(compat.emergencyRouteAvailable).toBe(emergency);
        expect(compat.canReduceNow).toBe(primary || emergency);
      }),
    );
  });
});

describe('held-asset safety engine (§7.5 states)', () => {
  it('a healthy held asset is NORMAL with no reasons', () => {
    const r = evaluateHeldAssetSafety(healthy());
    expect(r.state).toBe('NORMAL');
    expect(r.reasons).toEqual([]);
    expect(r.observed.emergencyPoolAddress).toBe(POOL);
    expect(r.policyVersion).toBe('safety-v1');
  });

  it.each([
    ['mint paused', { chain: chain({ paused: true, tokenProgram: 'TOKEN_2022' }) }, 'MINT_PAUSED'],
    ['non-transferable now', { chain: chain({ nonTransferable: true, tokenProgram: 'TOKEN_2022' }) }, 'NON_TRANSFERABLE_NOW'],
    ['freeze authority added', { chain: chain({ freezeAuthority: 'PRESENT' }) }, 'FREEZE_AUTHORITY_ADDED'],
    ['transfer hook added', { chain: chain({ transferHookProgram: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as never, tokenProgram: 'TOKEN_2022' }) }, 'TRANSFER_HOOK_ADDED'],
    ['permanent delegate added', { chain: chain({ permanentDelegate: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as never, tokenProgram: 'TOKEN_2022' }) }, 'PERMANENT_DELEGATE_ADDED'],
    ['no exit path at all', { primarySellProbe: probe({ routeFound: false }), emergencySnapshot: null }, 'NO_EXIT_PATH'],
  ] as const)('CRITICAL_EXIT: %s', (_l, over, reason) => {
    const r = evaluateHeldAssetSafety(healthy(over as Partial<SafetyInputs>));
    expect(r.state).toBe('CRITICAL_EXIT');
    expect(r.reasons).toContain(reason);
  });

  it.each([
    ['primary route gone but emergency route intact', { primarySellProbe: probe({ routeFound: false }) }, 'NO_PRIMARY_EXIT_ROUTE'],
    ['sell impact above max', { primarySellProbe: probe({ impactBps: 900 as never }) }, 'SELL_IMPACT_ABOVE_MAX'],
    ['liquidity collapse', { overview: overview(15_000) }, 'LIQUIDITY_COLLAPSE'],
    ['transfer fee raised', { chain: chain({ transferFeeBps: 250 as never, tokenProgram: 'TOKEN_2022' }), baseline: baseline({ transferFeeBps: 50 as never }) }, 'TRANSFER_FEE_RAISED'],
  ] as const)('EXIT_RECOMMENDED: %s', (_l, over, reason) => {
    const r = evaluateHeldAssetSafety(healthy(over as Partial<SafetyInputs>));
    expect(r.state).toBe('EXIT_RECOMMENDED');
    expect(r.reasons).toContain(reason);
    expect(r.exitCompatibility.canReduceNow).toBe(true);
  });

  it.each([
    ['emergency route missing', { emergencySnapshot: null }, 'EMERGENCY_ROUTE_MISSING'],
    ['emergency route stale', { emergencySnapshot: snapshot({ lastRefreshedAt: addMs(NOW, -7 * 3_600_000) }) }, 'EMERGENCY_ROUTE_STALE'],
    ['emergency pool no longer owned by the program', { emergencyPoolVerified: false }, 'EMERGENCY_POOL_CHANGED'],
    ['security stale', { security: security({ observedAt: addMs(NOW, -7 * 3_600_000) }) }, 'SECURITY_DATA_STALE'],
    ['security unavailable', { security: null }, 'SECURITY_DATA_UNAVAILABLE'],
    ['market data unavailable', { overview: null }, 'MARKET_DATA_UNAVAILABLE'],
    ['liquidity drop', { overview: overview(45_000) }, 'LIQUIDITY_DROP'],
    ['chain read stale', { chain: chain({ readAt: addMs(NOW, -3_600_000) }) }, 'CHAIN_READ_STALE'],
    ['concentration shock', { chain: chain({ concentration: { source: 'CHAIN', chainSlot: 500 as never, top1: 0.3, top5: 0.4, top10: 0.5, top20: 0.6, analyticsMismatch: false, programControlledFraction: null, excludedAccounts: null } }) }, 'CONCENTRATION_SHOCK'],
    ['provider alert trigger', { triggers: ['PROVIDER_ALERT'] as SafetyInputs['triggers'] }, 'SECURITY_PROVIDER_ALERT'],
  ] as const)('DEGRADED: %s', (_l, over, reason) => {
    const r = evaluateHeldAssetSafety(healthy(over as Partial<SafetyInputs>));
    expect(r.state).toBe('DEGRADED');
    expect(r.reasons).toContain(reason);
  });

  it('analytics problems never escalate past DEGRADED on their own, and the state is the maximum severity present', () => {
    const r = evaluateHeldAssetSafety(healthy({ security: null, overview: null }));
    expect(r.state).toBe('DEGRADED');
    const worst = evaluateHeldAssetSafety(healthy({ security: null, primarySellProbe: probe({ impactBps: 900 as never }), chain: chain({ paused: true, tokenProgram: 'TOKEN_2022' }) }));
    expect(worst.state).toBe('CRITICAL_EXIT');
    expect(worst.reasons).toEqual(expect.arrayContaining(['SECURITY_DATA_UNAVAILABLE', 'SELL_IMPACT_ABOVE_MAX', 'MINT_PAUSED']));
  });

  it('baselines come from chain state and carry forward for change detection', () => {
    const b = baselineFromChainState(chain({ transferFeeBps: 50 as never }), 100_000, POOL, 'PREVIOUS_SAFETY');
    expect(b).toEqual({ source: 'PREVIOUS_SAFETY', freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: 50, liquidityUsd: 100_000, top10: 0.2, emergencyPoolAddress: POOL });
    const r = evaluateHeldAssetSafety(healthy({ baseline: b, chain: chain({ transferFeeBps: 50 as never }) }));
    expect(r.state).toBe('NORMAL');
  });
});
describe('a quote that could not be obtained is not a route that does not exist (review R4-02, §21.2)', () => {
  it('provider unreachable with an emergency route: DEGRADED PRIMARY_ROUTE_UNKNOWN, never NO_EXIT_PATH; refused by the provider: NO_PRIMARY_EXIT_ROUTE', () => {
    const unknown = evaluateHeldAssetSafety(healthy({ primarySellProbe: null, primaryQuoteUnavailable: true }));
    expect(unknown.state).toBe('DEGRADED');
    expect(unknown.reasons).toContain('PRIMARY_ROUTE_UNKNOWN');
    expect(unknown.reasons).not.toContain('NO_EXIT_PATH');
    expect(unknown.exitCompatibility.canReduceNow).toBe(true);
    const refused = evaluateHeldAssetSafety(healthy({ primarySellProbe: probe({ routeFound: false, impactBps: null }) }));
    expect(refused.state).toBe('EXIT_RECOMMENDED');
    expect(refused.reasons).toContain('NO_PRIMARY_EXIT_ROUTE');
  });

  it('provider unreachable and no emergency route: DEGRADED until the policy streak, then EXIT_RECOMMENDED (alert), never CRITICAL_EXIT; a refused route with no emergency route is CRITICAL_EXIT', () => {
    const fresh = evaluateHeldAssetSafety(healthy({ primarySellProbe: null, primaryQuoteUnavailable: true, emergencySnapshot: null, previousUnknownRouteCycles: 0 }));
    expect(fresh.state).toBe('DEGRADED');
    expect(fresh.reasons).toEqual(expect.arrayContaining(['PRIMARY_ROUTE_UNKNOWN', 'EMERGENCY_ROUTE_MISSING']));
    const streak = evaluateHeldAssetSafety(healthy({ primarySellProbe: null, primaryQuoteUnavailable: true, emergencySnapshot: null, previousUnknownRouteCycles: DEFAULT_SAFETY_POLICY.maxUnknownRouteCycles - 1 }));
    expect(streak.state).toBe('EXIT_RECOMMENDED');
    expect(streak.reasons).toContain('EXIT_PATH_UNVERIFIED');
    expect(streak.reasons).not.toContain('NO_EXIT_PATH');
    const refused = evaluateHeldAssetSafety(healthy({ primarySellProbe: probe({ routeFound: false, impactBps: null }), emergencySnapshot: null }));
    expect(refused.state).toBe('CRITICAL_EXIT');
    expect(refused.reasons).toContain('NO_EXIT_PATH');
  });
});

