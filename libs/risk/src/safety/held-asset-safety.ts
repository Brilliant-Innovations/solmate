import {
  instantToMs,
  type Amount,
  type Bps,
  type EmergencyExitRouteSnapshot,
  type ExitCompatibility,
  type HeldAssetSafety,
  type Instant,
  type MintChainState,
  type PositionSafetyState,
  type PriceImpactProbe,
  type SafetyBaseline,
  type SafetyPolicy,
  type SafetyReason,
  type SafetyTrigger,
  type TokenOverview,
  type TokenSecurityReport,
  type Uuid,
} from '@sol-agent-trader/contracts';

/**
 * Held-asset safety engine (blueprint §7.5, D34, §14.6; §31 "held-asset safety/executability is
 * continuously revalidated"; M4 exit gate "entry ineligibility never by itself disables the
 * independent exit-compatibility path").
 *
 * Two pure functions. `exitCompatibility` takes route facts and the chain state only: there is no
 * parameter through which an entry-eligibility decision could reach it, so ineligibility cannot
 * make a held asset unsellable by construction. `evaluateHeldAssetSafety` grades the position
 * from chain truth, the baseline it was entered or last evaluated at, market structure and the
 * exit paths, escalating to CRITICAL_EXIT only for facts that make holding unsafe or exit
 * impossible. Analytics staleness alone never escalates past DEGRADED.
 */

export interface ExitFacts {
  chain: MintChainState;
  /** Sell probe for the whole position through the primary (Jupiter) route; null when it could not be quoted. */
  primarySellProbe: PriceImpactProbe | null;
  emergencySnapshot: EmergencyExitRouteSnapshot | null;
  /** Result of re-reading the snapshot's pool on chain: true = still owned by the expected program. */
  emergencyPoolVerified: boolean | null;
  now: Instant;
  policy: SafetyPolicy;
}

export function exitCompatibility(facts: ExitFacts): ExitCompatibility {
  const { chain, primarySellProbe, emergencySnapshot, emergencyPoolVerified, now, policy } = facts;
  const token2022Compatible = chain.tokenProgram === 'TOKEN' || (chain.transferHookProgram === null && !chain.nonTransferable && !chain.defaultAccountFrozen && !chain.paused);
  const primaryRouteAvailable = primarySellProbe?.routeFound === true && !chain.paused && !chain.nonTransferable && !chain.defaultAccountFrozen;
  const snapshotAge = emergencySnapshot ? Math.max(0, instantToMs(now) - instantToMs(emergencySnapshot.lastRefreshedAt)) : null;
  const emergencyRouteAvailable =
    emergencySnapshot !== null && emergencyPoolVerified === true && snapshotAge !== null && snapshotAge <= policy.maxEmergencySnapshotAgeMs && emergencySnapshot.token2022Compatible && token2022Compatible;
  return {
    primaryRouteAvailable,
    primaryImpactBps: primarySellProbe?.routeFound ? primarySellProbe.impactBps : null,
    emergencyRouteAvailable,
    emergencySnapshotAgeMs: snapshotAge,
    token2022Compatible,
    canReduceNow: primaryRouteAvailable || emergencyRouteAvailable,
  };
}

export interface SafetyInputs extends ExitFacts {
  id: Uuid;
  positionId: Uuid;
  assetId: Uuid;
  positionQuantity: Amount;
  previousState: PositionSafetyState | null;
  baseline: SafetyBaseline;
  overview: TokenOverview | null;
  security: TokenSecurityReport | null;
  triggers: SafetyTrigger[];
}

const SEVERITY: Record<PositionSafetyState, number> = { NORMAL: 0, DEGRADED: 1, EXIT_RECOMMENDED: 2, CRITICAL_EXIT: 3 };
const CRITICAL: ReadonlySet<SafetyReason> = new Set(['MINT_PAUSED', 'NON_TRANSFERABLE_NOW', 'DEFAULT_ACCOUNT_FROZEN_NOW', 'FREEZE_AUTHORITY_ADDED', 'TRANSFER_HOOK_ADDED', 'PERMANENT_DELEGATE_ADDED', 'NO_EXIT_PATH']);
const EXIT_RECOMMENDED: ReadonlySet<SafetyReason> = new Set(['NO_PRIMARY_EXIT_ROUTE', 'SELL_IMPACT_ABOVE_MAX', 'LIQUIDITY_COLLAPSE', 'TRANSFER_FEE_RAISED']);

export function baselineFromChainState(chain: MintChainState, liquidityUsd: number | null, emergencyPoolAddress: string | null, source: SafetyBaseline['source']): SafetyBaseline {
  return {
    source,
    freezeAuthorityPresent: chain.freezeAuthority === 'PRESENT',
    transferHook: chain.transferHookProgram !== null,
    permanentDelegate: chain.permanentDelegate !== null,
    transferFeeBps: chain.transferFeeBps,
    liquidityUsd,
    top10: chain.concentration?.top10 ?? null,
    emergencyPoolAddress,
  };
}

export function evaluateHeldAssetSafety(input: SafetyInputs): HeldAssetSafety {
  const { chain, baseline, overview, security, policy, now } = input;
  const reasons = new Set<SafetyReason>();
  const compat = exitCompatibility(input);

  // --- chain truth: what changed since the baseline, and what is unsafe outright ------------------
  if (chain.paused) reasons.add('MINT_PAUSED');
  if (chain.nonTransferable) reasons.add('NON_TRANSFERABLE_NOW');
  if (chain.defaultAccountFrozen) reasons.add('DEFAULT_ACCOUNT_FROZEN_NOW');
  if (chain.freezeAuthority === 'PRESENT' && !baseline.freezeAuthorityPresent) reasons.add('FREEZE_AUTHORITY_ADDED');
  if (chain.transferHookProgram !== null && !baseline.transferHook) reasons.add('TRANSFER_HOOK_ADDED');
  if (chain.permanentDelegate !== null && !baseline.permanentDelegate) reasons.add('PERMANENT_DELEGATE_ADDED');
  if (chain.transferFeeBps !== null && chain.transferFeeBps - (baseline.transferFeeBps ?? 0) > policy.transferFeeRaiseBps) reasons.add('TRANSFER_FEE_RAISED');
  if (instantToMs(now) - instantToMs(chain.readAt) > policy.maxChainReadAgeMs) reasons.add('CHAIN_READ_STALE');

  // --- exit paths -------------------------------------------------------------------------------------
  if (!compat.canReduceNow) reasons.add('NO_EXIT_PATH');
  else if (!compat.primaryRouteAvailable) reasons.add('NO_PRIMARY_EXIT_ROUTE');
  if (compat.primaryImpactBps !== null && compat.primaryImpactBps > policy.maxSellImpactBps) reasons.add('SELL_IMPACT_ABOVE_MAX');
  if (!input.emergencySnapshot) reasons.add('EMERGENCY_ROUTE_MISSING');
  else {
    if (compat.emergencySnapshotAgeMs !== null && compat.emergencySnapshotAgeMs > policy.maxEmergencySnapshotAgeMs) reasons.add('EMERGENCY_ROUTE_STALE');
    if (input.emergencyPoolVerified === false) reasons.add('EMERGENCY_POOL_CHANGED');
    const pool = input.emergencySnapshot.hops[0]?.poolAddress ?? null;
    if (baseline.emergencyPoolAddress !== null && pool !== null && pool !== baseline.emergencyPoolAddress) reasons.add('EMERGENCY_POOL_CHANGED');
  }

  // --- market structure vs baseline ------------------------------------------------------------------
  const liquidity = overview?.liquidityUsd ?? null;
  if (liquidity === null) reasons.add('MARKET_DATA_UNAVAILABLE');
  else if (baseline.liquidityUsd !== null && baseline.liquidityUsd > 0) {
    const drop = 1 - liquidity / baseline.liquidityUsd;
    if (drop >= policy.liquidityCollapseFraction) reasons.add('LIQUIDITY_COLLAPSE');
    else if (drop >= policy.liquidityDropFraction) reasons.add('LIQUIDITY_DROP');
  }
  const top10 = chain.concentration?.top10 ?? null;
  if (top10 !== null && baseline.top10 !== null && top10 - baseline.top10 > policy.concentrationShockDelta) reasons.add('CONCENTRATION_SHOCK');

  // --- analytics: never more than DEGRADED on its own ------------------------------------------------
  if (!security) reasons.add('SECURITY_DATA_UNAVAILABLE');
  else {
    if (instantToMs(now) - instantToMs(security.observedAt) > policy.maxSecurityAgeMs) reasons.add('SECURITY_DATA_STALE');
    if (security.fakeToken === true) reasons.add('SECURITY_PROVIDER_ALERT');
  }
  if (input.triggers.includes('PROVIDER_ALERT')) reasons.add('SECURITY_PROVIDER_ALERT');

  let state: PositionSafetyState = 'NORMAL';
  for (const r of reasons) {
    const s: PositionSafetyState = CRITICAL.has(r) ? 'CRITICAL_EXIT' : EXIT_RECOMMENDED.has(r) ? 'EXIT_RECOMMENDED' : 'DEGRADED';
    if (SEVERITY[s] > SEVERITY[state]) state = s;
  }

  return {
    id: input.id,
    positionId: input.positionId,
    assetId: input.assetId,
    evaluatedAt: now,
    policyVersion: policy.version,
    state,
    previousState: input.previousState,
    reasons: [...reasons],
    triggers: input.triggers.length > 0 ? input.triggers : ['PERIODIC'],
    exitCompatibility: compat,
    positionQuantity: input.positionQuantity,
    chainSlot: chain.slot,
    liquidityUsd: liquidity,
    observed: {
      freezeAuthorityPresent: chain.freezeAuthority === 'PRESENT',
      transferHook: chain.transferHookProgram !== null,
      permanentDelegate: chain.permanentDelegate !== null,
      transferFeeBps: chain.transferFeeBps as Bps | null,
      liquidityUsd: liquidity,
      top10,
      emergencyPoolAddress: input.emergencySnapshot?.hops[0]?.poolAddress ?? null,
    },
    baseline,
  };
}
