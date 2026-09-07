import {
  instantToMs,
  UNAVAILABLE_REASONS,
  type AssetEligibility,
  type EligibilityPolicy,
  type EligibilityReason,
  type Instant,
  type MintChainState,
  type PriceImpactProbe,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';

/**
 * Deterministic eligibility engine (blueprint §7.2–7.4, D45; §31 "critical stale data fails
 * closed for entries", "hard token protocol-state security fields are verified from chain truth").
 *
 * Inputs are facts already gathered: the chain read (authoritative for protocol state), the
 * analytics security report (corroboration and analytics-only labels), the market overview and
 * route probes. Output is the §6.2 record plus the asset status it implies. Hard rejects are never
 * outweighed by the grade. Missing required data is a hard reject of the "unavailable" kind: the
 * asset is not eligible, but it is not marked unsafe either, so it is re-evaluated rather than
 * buried.
 */

export interface EligibilityInputs {
  id: Uuid;
  assetId: Uuid;
  chain: MintChainState;
  security: TokenSecurityReport | null;
  overview: TokenOverview | null;
  /** Route probes at the policy's standard sizes; empty when no probe adapter has run yet. */
  probes: readonly PriceImpactProbe[];
  /** Whether a route back to SOL/USDC was confirmed at probe time; null when no probe ran. */
  settlementRouteConfirmed: boolean | null;
  /** Persisted provider-independent exit route (§6.2, §14.6), when discovery found and verified one. */
  emergencyExitRouteSnapshotId?: Uuid | null;
  now: Instant;
  policy: EligibilityPolicy;
}

export type EligibilityOutcome = 'ELIGIBLE' | 'BLOCKED' | 'EVALUATING';

export interface EligibilityResult {
  record: AssetEligibility;
  outcome: EligibilityOutcome;
}

const GRADE_PENALTY: Partial<Record<EligibilityReason, number>> = {
  VOLUME_BELOW_FLOOR: 20,
  HOLDERS_BELOW_FLOOR: 15,
  TOKEN_AGE_BELOW_MIN: 15,
  TOKEN_AGE_UNKNOWN: 10,
  MUTABLE_METADATA: 5,
  MINT_CLOSE_AUTHORITY: 5,
  CREATOR_CONCENTRATION_HIGH: 15,
  TOP10_CONCENTRATION_HIGH: 15,
  ANALYTICS_CONCENTRATION_DISAGREES: 10,
  NOT_ON_JUP_STRICT_LIST: 5,
};

function pct(v: number | null): number | null {
  return v === null ? null : v / 100;
}

export function evaluateEligibility(input: EligibilityInputs): EligibilityResult {
  const { chain, security, overview, probes, policy, now } = input;
  const hard = new Set<EligibilityReason>();
  const soft = new Set<EligibilityReason>();
  const securityFlags = new Set<EligibilityReason>();
  const transferRestrictions = new Set<EligibilityReason>();

  // --- chain truth (authoritative) ---------------------------------------------------------------
  if (!chain.isInitialized) hard.add('MINT_NOT_INITIALIZED');
  if (chain.tokenProgram === 'UNKNOWN') hard.add('UNKNOWN_TOKEN_PROGRAM');
  if (chain.supply === '0') hard.add('SUPPLY_ZERO');
  if (chain.mintAuthority === 'PRESENT' && policy.rejectMintAuthority) hard.add('MINT_AUTHORITY_PRESENT');
  if (chain.mintAuthority === 'UNKNOWN' || chain.freezeAuthority === 'UNKNOWN') hard.add('AUTHORITY_UNKNOWN');
  if (chain.freezeAuthority === 'PRESENT') {
    transferRestrictions.add('FREEZE_AUTHORITY_PRESENT');
    if (policy.rejectFreezeAuthority) hard.add('FREEZE_AUTHORITY_PRESENT');
  }
  if (chain.nonTransferable) {
    transferRestrictions.add('NON_TRANSFERABLE');
    hard.add('NON_TRANSFERABLE');
  }
  if (chain.defaultAccountFrozen) {
    transferRestrictions.add('DEFAULT_ACCOUNT_FROZEN');
    hard.add('DEFAULT_ACCOUNT_FROZEN');
  }
  if (chain.paused) {
    transferRestrictions.add('MINT_PAUSED');
    hard.add('MINT_PAUSED');
  }
  if (chain.permanentDelegate !== null) {
    securityFlags.add('PERMANENT_DELEGATE');
    if (policy.rejectPermanentDelegate) hard.add('PERMANENT_DELEGATE');
  }
  if (chain.transferHookProgram !== null) {
    securityFlags.add('TRANSFER_HOOK');
    if (policy.rejectTransferHook) hard.add('TRANSFER_HOOK');
  }
  if (chain.transferFeeBps !== null && chain.transferFeeBps > policy.maxTransferFeeBps) {
    transferRestrictions.add('TRANSFER_FEE_ABOVE_MAX');
    hard.add('TRANSFER_FEE_ABOVE_MAX');
  }
  if (chain.mintCloseAuthority) soft.add('MINT_CLOSE_AUTHORITY');
  if (policy.denylist.includes(chain.mintAddress)) hard.add('DENYLISTED');

  // --- analytics corroboration (D45): present, fresh, and not contradicting chain -----------------
  let analyticsMismatch = false;
  if (!security) hard.add('SECURITY_DATA_UNAVAILABLE');
  else {
    if (instantToMs(now) - instantToMs(security.observedAt) > policy.maxSecurityAgeMs) hard.add('SECURITY_DATA_STALE');
    if (security.fakeToken === true) {
      securityFlags.add('SECURITY_FAKE_TOKEN');
      hard.add('SECURITY_FAKE_TOKEN');
    }
    const contradicts =
      (security.freezeable === true && chain.freezeAuthority === 'NONE') ||
      (security.isToken2022 === true && chain.tokenProgram === 'TOKEN') ||
      (security.isToken2022 === false && chain.tokenProgram === 'TOKEN_2022') ||
      (security.nonTransferable === true && !chain.nonTransferable) ||
      (security.transferFeeEnabled === true && chain.transferFeeBps === null);
    const analyticsTop10 = pct(security.top10HolderPercent);
    const concentrationDisagrees = analyticsTop10 !== null && chain.concentration !== null && Math.abs(analyticsTop10 - chain.concentration.top10) > policy.concentrationMismatchTolerance;
    // A security flag the chain contradicts is a hard mismatch. A different concentration figure is
    // not: the provider counts holders its own way while the chain figure is holder-only top-N over
    // the largest accounts; it is recorded and graded, and the chain figure alone drives the policy.
    if (contradicts) {
      analyticsMismatch = true;
      hard.add('CHAIN_ANALYTICS_MISMATCH');
    }
    if (concentrationDisagrees) soft.add('ANALYTICS_CONCENTRATION_DISAGREES');
    if (security.mutableMetadata === true) soft.add('MUTABLE_METADATA');
    if (security.creatorPercentage !== null && security.creatorPercentage > policy.maxCreatorPercentage) soft.add('CREATOR_CONCENTRATION_HIGH');
    if (security.jupStrictList === false) soft.add('NOT_ON_JUP_STRICT_LIST');
    // §7.2: minimum token age is a required gate, not a grade penalty, unless the policy overrides it.
    const ageBucket = policy.allowYoungAssets ? soft : hard;
    if (security.creationAt === null) ageBucket.add('TOKEN_AGE_UNKNOWN');
    else if (instantToMs(now) - instantToMs(security.creationAt) < policy.minTokenAgeMs) ageBucket.add('TOKEN_AGE_BELOW_MIN');
  }

  // --- concentration policy on chain figures (unknown = not eligible, not unsafe) --------------------
  if (chain.concentration === null) hard.add('CONCENTRATION_UNAVAILABLE');
  else if (chain.concentration.top10 > policy.maxTop10Fraction) hard.add('TOP10_CONCENTRATION_ABOVE_MAX');
  else if (chain.concentration.top10 > policy.softTop10Fraction) soft.add('TOP10_CONCENTRATION_HIGH');

  // --- market structure ------------------------------------------------------------------------------
  const liquidity = overview?.liquidityUsd ?? null;
  const volume24h = overview?.windows.h24.volumeUsd ?? null;
  const holders = overview?.holderCount ?? null;
  if (!overview || liquidity === null) hard.add('MARKET_DATA_UNAVAILABLE');
  else if (liquidity < policy.minLiquidityUsd) hard.add('LIQUIDITY_BELOW_FLOOR');
  if (volume24h !== null && volume24h < policy.minVolume24hUsd) soft.add('VOLUME_BELOW_FLOOR');
  if (holders !== null && holders < policy.minHolderCount) soft.add('HOLDERS_BELOW_FLOOR');

  // --- exit route (§7.3 "cannot demonstrate exit route" is a hard reject) ---------------------------
  const probesAtStandardSizes = policy.probeSizesUsd.map((size) => probes.find((p) => p.sizeUsd === size) ?? null);
  const routeUnavailable = probes.length === 0 || input.settlementRouteConfirmed === null || probesAtStandardSizes.some((p) => p === null);
  const jupiterRouteAvailable = !routeUnavailable && probesAtStandardSizes.every((p) => p !== null && p.routeFound);
  const settlementRouteConfirmed = input.settlementRouteConfirmed === true;
  if (routeUnavailable) hard.add('ROUTE_PROBE_UNAVAILABLE');
  else {
    if (!jupiterRouteAvailable || !settlementRouteConfirmed) hard.add('NO_EXIT_ROUTE');
    // A routed probe whose impact could not be measured is unavailable data, not a 100 % impact.
    if (probesAtStandardSizes.some((p) => p !== null && p.routeFound && p.impactBps === null)) hard.add('ROUTE_PROBE_UNAVAILABLE');
    if (probesAtStandardSizes.some((p) => p !== null && p.routeFound && p.impactBps !== null && p.impactBps > policy.maxImpactBps)) hard.add('PRICE_IMPACT_ABOVE_MAX');
  }

  // --- grade and outcome ----------------------------------------------------------------------------
  let grade = 100;
  for (const r of soft) grade -= GRADE_PENALTY[r] ?? 0;
  grade = Math.max(0, Math.min(100, grade));
  const hardReject = hard.size > 0;
  const eligible = !hardReject;
  const onlyUnavailable = hardReject && [...hard].every((r) => UNAVAILABLE_REASONS.includes(r));
  const outcome: EligibilityOutcome = eligible ? 'ELIGIBLE' : onlyUnavailable ? 'EVALUATING' : 'BLOCKED';

  const record: AssetEligibility = {
    id: input.id,
    assetId: input.assetId,
    evaluatedAt: now,
    policyVersion: policy.version,
    eligible,
    hardReject,
    rejectionReasons: [...hard, ...soft],
    grade: hardReject && !onlyUnavailable ? 0 : grade,
    liquidityUsd: liquidity,
    volume24hUsd: volume24h,
    holderCount: holders,
    concentration: chain.concentration ? { ...chain.concentration, analyticsMismatch } : null,
    mintAuthority: chain.mintAuthority,
    freezeAuthority: chain.freezeAuthority,
    token2022:
      chain.tokenProgram === 'TOKEN_2022'
        ? {
            extensions: chain.extensions,
            transferFeeBps: chain.transferFeeBps,
            transferHook: chain.transferHookProgram !== null,
            permanentDelegate: chain.permanentDelegate !== null,
            swapCompatibility: chain.transferHookProgram !== null || chain.nonTransferable ? 'INCOMPATIBLE' : 'UNKNOWN',
            triggerCompatibility: 'UNKNOWN',
          }
        : null,
    securityFlags: [...securityFlags],
    transferRestrictions: [...transferRestrictions],
    jupiterRouteAvailable,
    settlementRouteConfirmed,
    priceImpactProbes: [...probes],
    insiderMetrics: security
      ? { creatorPercentage: security.creatorPercentage, ownerPercentage: security.ownerPercentage, top10UserPercent: security.top10UserPercent, preMarketHolderCount: security.preMarketHolderCount, source: 'BIRDEYE' }
      : null,
    emergencyExitRouteSnapshotId: input.emergencyExitRouteSnapshotId ?? null,
    freshness: { securityProviderAt: security?.observedAt ?? null, chainReadAt: chain.readAt, chainSlot: chain.slot },
  };
  return { record, outcome };
}
