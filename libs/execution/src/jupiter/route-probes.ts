import {
  type Amount,
  type Bps,
  type DirectPoolProgram,
  type EligibilityPolicy,
  type EmergencyExitRouteSnapshot,
  type Instant,
  type JupiterQuoteClient,
  type MintAddress,
  type PriceImpactProbe,
  type Quote,
  type QuoteRequest,
  type QuoteRoutePlan,
  type Slot,
  type SolanaAddress,
  type SolanaCluster,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { NoRouteError } from './quote-client.js';
import { DIRECT_POOL_LABELS, DIRECT_POOL_PROGRAMS, programForLabel } from './programs.js';

/**
 * Route and price-impact probes at the policy's standard sizes (blueprint §7.2, §7.3 "cannot
 * demonstrate exit route" is a hard reject) and provider-independent emergency-route discovery
 * (§14.6, D45 "liquidity/exitability is proven by direct pool state plus executable route probes").
 *
 * Entry impact is measured buying the token with the first settlement mint; exit is confirmed by
 * quoting the token back to a settlement mint. The emergency snapshot restricts the router to the
 * five direct-pool families and single-hop routes, so what is persisted is a concrete pool the
 * emergency adapter can drive without Jupiter. The pool's owner program is verified on chain by
 * the caller through `verifyPool`, never assumed from the label.
 */

/** A taker is required by the quote contract; probes do not sign, so any valid address serves. */
export const PROBE_TAKER = '11111111111111111111111111111111' as SolanaAddress;

export interface ProbeTarget {
  mintAddress: MintAddress;
  decimals: number;
  priceUsd: number;
}

export interface ProbeOutcome {
  probes: PriceImpactProbe[];
  /** True when the token could be routed to a settlement mint at the largest size that found a buy route. */
  settlementRouteConfirmed: boolean;
  settlementMint: MintAddress | null;
  errors: string[];
}

const USDC_DECIMALS = 6;

function baseUnits(value: number, decimals: number): Amount {
  // Round, not floor: 1 / 1e-9 * 1e6 is 999999999999999.9 in binary floating point.
  const scaled = Math.round(value * 10 ** decimals);
  return String(Math.max(1, scaled)) as Amount;
}

/** Token base units worth `sizeUsd` at `priceUsd`; null when the price cannot size a probe (zero, negative, absurd). */
export function tokenAmountForUsd(sizeUsd: number, target: ProbeTarget): Amount | null {
  if (!(target.priceUsd > 0) || !Number.isFinite(target.priceUsd) || !(sizeUsd > 0)) return null;
  const units = (sizeUsd / target.priceUsd) * 10 ** target.decimals;
  if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER) return null;
  return baseUnits(sizeUsd / target.priceUsd, target.decimals);
}

export async function runRouteProbes(client: JupiterQuoteClient, target: ProbeTarget, policy: EligibilityPolicy, cluster: SolanaCluster, now: Instant): Promise<ProbeOutcome> {
  const settlement = policy.settlementMints[0] as MintAddress;
  const probes: PriceImpactProbe[] = [];
  const errors: string[] = [];
  let largestRoutedSize = 0;

  for (const sizeUsd of policy.probeSizesUsd) {
    const inputAmount = baseUnits(sizeUsd, USDC_DECIMALS);
    const request: QuoteRequest = { inputMint: settlement, outputMint: target.mintAddress, inputAmount, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster, requestedAt: now };
    try {
      const { quote } = await client.quote(request);
      probes.push({ sizeUsd, inputAmount, impactBps: quote.priceImpactBps, routeFound: true, probedAt: now });
      largestRoutedSize = Math.max(largestRoutedSize, sizeUsd);
    } catch (err) {
      if (err instanceof NoRouteError) probes.push({ sizeUsd, inputAmount, impactBps: null, routeFound: false, probedAt: now });
      else {
        errors.push(`buy@${sizeUsd}: ${err instanceof Error ? err.message : String(err)}`);
        return { probes, settlementRouteConfirmed: false, settlementMint: null, errors };
      }
    }
  }

  // Exit confirmation: the token back to a settlement mint at the largest routed size.
  let settlementRouteConfirmed = false;
  let settlementMint: MintAddress | null = null;
  if (largestRoutedSize > 0) {
    const sellAmount = tokenAmountForUsd(largestRoutedSize, target);
    if (sellAmount === null) {
      errors.push('sell: price cannot size the probe');
      return { probes, settlementRouteConfirmed: false, settlementMint: null, errors };
    }
    for (const mint of policy.settlementMints) {
      const request: QuoteRequest = { inputMint: target.mintAddress, outputMint: mint as MintAddress, inputAmount: sellAmount, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster, requestedAt: now };
      try {
        await client.quote(request);
        settlementRouteConfirmed = true;
        settlementMint = mint as MintAddress;
        break;
      } catch (err) {
        if (!(err instanceof NoRouteError)) {
          errors.push(`sell→${mint.slice(0, 6)}: ${err instanceof Error ? err.message : String(err)}`);
          return { probes, settlementRouteConfirmed: false, settlementMint: null, errors };
        }
      }
    }
  }
  return { probes, settlementRouteConfirmed, settlementMint, errors };
}

export interface DiscoveredEmergencyRoute {
  program: DirectPoolProgram;
  programId: SolanaAddress;
  poolAddress: SolanaAddress;
  settlementMint: MintAddress;
  capacity: EmergencyExitRouteSnapshot['capacity'];
  contextSlot: Slot | null;
}

/**
 * Finds a single-hop direct-pool route from the token to a settlement mint and quotes capacity at
 * every probe size through that restriction. Returns null when no supported pool routes the pair.
 */
export async function discoverEmergencyRoute(client: JupiterQuoteClient, target: ProbeTarget, policy: EligibilityPolicy, cluster: SolanaCluster, now: Instant): Promise<DiscoveredEmergencyRoute | null> {
  const options = { onlyDirectRoutes: true, dexes: [...DIRECT_POOL_LABELS] };
  const smallest = Math.min(...policy.probeSizesUsd);
  const smallestAmount = tokenAmountForUsd(smallest, target);
  if (smallestAmount === null) return null;
  for (const mint of policy.settlementMints) {
    const settlementMint = mint as MintAddress;
    let first: { quote: Quote; route: QuoteRoutePlan };
    try {
      first = await client.quote({ inputMint: target.mintAddress, outputMint: settlementMint, inputAmount: smallestAmount, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster, requestedAt: now }, options);
    } catch (err) {
      if (err instanceof NoRouteError) continue;
      throw err;
    }
    const hop = first.route.hops[0];
    if (!hop || first.route.hops.length !== 1) continue;
    const known = programForLabel(hop.label);
    if (!known) continue;

    const capacity: EmergencyExitRouteSnapshot['capacity'] = [];
    for (const sizeUsd of policy.probeSizesUsd) {
      const inputAmount = tokenAmountForUsd(sizeUsd, target);
      if (inputAmount === null) continue;
      try {
        const { quote, route } = await client.quote({ inputMint: target.mintAddress, outputMint: settlementMint, inputAmount, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster, requestedAt: now }, options);
        // Capacity counts only when the router still uses the same pool at this size.
        if (route.hops.length === 1 && route.hops[0]?.ammKey === hop.ammKey && quote.priceImpactBps !== null) capacity.push({ inputAmount, expectedOutputAmount: quote.expectedOutputAmount, impactBps: quote.priceImpactBps });
      } catch (err) {
        if (!(err instanceof NoRouteError)) throw err;
      }
    }
    return { program: known.program, programId: DIRECT_POOL_PROGRAMS[known.program].programId as SolanaAddress, poolAddress: hop.ammKey, settlementMint, capacity, contextSlot: first.route.contextSlot };
  }
  return null;
}

/** Assembles the §6.2 snapshot once the pool's owner program has been verified on chain. */
export function buildEmergencySnapshot(input: {
  id: Uuid;
  assetId: Uuid;
  mintAddress: MintAddress;
  route: DiscoveredEmergencyRoute;
  poolStateRef: string;
  verifiedAtSlot: Slot;
  token2022Compatible: boolean;
  now: Instant;
}): EmergencyExitRouteSnapshot {
  return {
    id: input.id,
    assetId: input.assetId,
    hops: [{ program: input.route.program, programId: input.route.programId, poolAddress: input.route.poolAddress, inputMint: input.mintAddress, outputMint: input.route.settlementMint }],
    settlementMint: input.route.settlementMint,
    poolStateRef: input.poolStateRef,
    lastRefreshedAt: input.now,
    lastRefreshSlot: input.verifiedAtSlot,
    capacity: input.route.capacity,
    token2022Compatible: input.token2022Compatible,
    lastDryRun: null,
  };
}
