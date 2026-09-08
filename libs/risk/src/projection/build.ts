import { addAmounts, amountToBigInt, bigIntToAmount, instantToMs, signPayload, type Amount, type CorrelationClusterSet, type EligibilitySummaryEntry, type FreshnessRequirements, type FreshnessSummaryEntry, type Instant, type MintAddress, type OpenLotSummary, type RiskPolicy, type RiskStateProjection, type Sequence, type Sha256Hex, type SignedRiskStateProjection, type SigningKeyPair, type Slot, type StrategySleeve, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { cohortUsage, type ActiveMembership, type OpenExposure } from '../cohorts/exposure.js';

/**
 * Risk state projection builder (blueprint §6.14A, §13.6, D21, D52; ADR-0009 P1; execution plan M7
 * "worker state projector emitting signed/sequenced RiskStateProjection"). Pure over facts the
 * worker already holds: the projection is an input to authorization, never authorization itself.
 * Pending exposure (authorized, submitted, provisional, reorg-pending) is counted as spent so two
 * authorizations cannot share the same remaining capacity; signer-dependent exposure is every lot
 * whose protection depends on our signer (MONITORED_EXIT); the authorizer independently re-reads
 * chain truth and refuses a projection that claims more than the chain holds.
 */

export interface ProjectionFacts {
  sequence: Sequence;
  asOf: Instant;
  chainSlot: Slot;
  release: { id: Uuid; digest: Sha256Hex };
  policyVersion: VersionId;
  sourceDigests: { source: string; digest: Sha256Hex }[];
  settlementMint: MintAddress;
  custody: { custodyAccountId: Uuid; mint: MintAddress; amount: Amount }[];
  settlementAvailableBaseUnits: Amount;
  gasReserveLamports: Amount;
  /** Exposure-increasing intents not yet terminal plus provisional attempts (ADR-0009 P1). */
  pendingExposureBaseUnits: Amount;
  sleeves: readonly StrategySleeve[];
  openLots: readonly OpenLotSummary[];
  equityBaseUnits: Amount;
  exposureUsd: number | null;
  dayStartEquity: Amount | null;
  rollingHighEquity: Amount | null;
  consecutiveLosses: number;
  circuitBreakerTripped: boolean;
  memberships: readonly ActiveMembership[];
  clusterSet: CorrelationClusterSet | null;
  policy: Pick<RiskPolicy, 'maxCohortExposureFraction' | 'maxClusterExposureFraction'>;
  eligibility: readonly EligibilitySummaryEntry[];
  freshness: readonly FreshnessSummaryEntry[];
  capital: { ceilingUsd: number; recognizedUsd: number | null };
}

const fraction = (part: bigint, whole: bigint): number => (whole <= 0n ? (part > 0n ? 1 : 0) : Number((part * 1_000_000n) / whole) / 1_000_000);
const drawdown = (from: Amount | null, equity: Amount): number => {
  if (!from || amountToBigInt(from) <= 0n) return 0;
  const f = amountToBigInt(from);
  const e = amountToBigInt(equity);
  return e >= f ? 0 : Math.min(1, Number(((f - e) * 1_000_000n) / f) / 1_000_000);
};
const remaining = (cap: Amount, used: Amount): Amount => (amountToBigInt(cap) > amountToBigInt(used) ? bigIntToAmount(amountToBigInt(cap) - amountToBigInt(used)) : bigIntToAmount(0n));

export function buildRiskStateProjection(f: ProjectionFacts): RiskStateProjection {
  const lotExposure = f.openLots.reduce((acc, l) => acc + amountToBigInt(l.costBasisBaseUnits), 0n);
  const signerDependent = f.openLots.filter((l) => l.protectionMode === 'MONITORED_EXIT' || !l.providerProtectionActive).reduce((acc, l) => acc + amountToBigInt(l.costBasisBaseUnits), 0n);
  const exposures: OpenExposure[] = f.openLots.map((l) => ({ assetId: l.assetId, costBasis: l.costBasisBaseUnits }));
  const equity = amountToBigInt(f.equityBaseUnits);
  const cohortCapacity = [...cohortUsage(exposures, f.memberships, f.equityBaseUnits).entries()].map(([id, u]) => ({ id, usedFraction: Math.min(1, u.usedFraction), capFraction: f.policy.maxCohortExposureFraction })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const clusterCapacity = (f.clusterSet?.clusters ?? []).map((c) => {
    const members = new Set(c.assetIds);
    const part = exposures.filter((e) => members.has(e.assetId)).reduce((acc, e) => acc + amountToBigInt(e.costBasis), 0n);
    return { id: c.clusterId, usedFraction: Math.min(1, fraction(part, equity)), capFraction: f.policy.maxClusterExposureFraction };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const recognized = f.capital.recognizedUsd;
  return {
    sequence: f.sequence,
    asOf: f.asOf,
    chainSlot: f.chainSlot,
    releaseId: f.release.id,
    releaseDigest: f.release.digest,
    policyVersion: f.policyVersion,
    sourceDigests: [...f.sourceDigests].sort((a, b) => (a.source < b.source ? -1 : 1)),
    settlementMint: f.settlementMint,
    custody: [...f.custody].sort((a, b) => (`${a.custodyAccountId}|${a.mint}` < `${b.custodyAccountId}|${b.mint}` ? -1 : 1)),
    settlementAvailableBaseUnits: f.settlementAvailableBaseUnits,
    gasReserveLamports: f.gasReserveLamports,
    aggregateNonSettlementExposureBaseUnits: addAmounts(bigIntToAmount(lotExposure), f.pendingExposureBaseUnits),
    exposureUsd: f.exposureUsd,
    signerDependentExposureBaseUnits: bigIntToAmount(signerDependent),
    sleeves: f.sleeves.filter((s) => s.active).map((s) => ({ sleeveId: s.id, strategyVersionId: s.strategyVersionId, committedBaseUnits: s.committedBaseUnits, capBaseUnits: s.capitalCapBaseUnits, riskRemainingBaseUnits: remaining(s.riskBudgetBaseUnits, s.riskUsedBaseUnits) })),
    openLots: [...f.openLots].sort((a, b) => (a.lotId < b.lotId ? -1 : 1)),
    drawdown: { dailyFraction: drawdown(f.dayStartEquity, f.equityBaseUnits), rollingFraction: drawdown(f.rollingHighEquity, f.equityBaseUnits), circuitBreakerTripped: f.circuitBreakerTripped, consecutiveLosses: f.consecutiveLosses },
    cohortCapacity,
    clusterCapacity,
    eligibilitySummary: [...f.eligibility].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
    freshnessSummary: [...f.freshness].sort((a, b) => (a.dataClass < b.dataClass ? -1 : 1)),
    capitalAttestation: { ceilingUsd: f.capital.ceilingUsd, recognizedUsd: recognized ?? 0, reattestRequired: recognized !== null && recognized > f.capital.ceilingUsd },
  };
}

export async function signProjection(projection: RiskStateProjection, key: SigningKeyPair, signedAt: Instant): Promise<SignedRiskStateProjection> {
  return signPayload(projection, key, signedAt);
}

/** Freshness per data class from provider health, using the freshness requirements the strategies' speed tier demands. */
export function freshnessSummaryFrom(feeds: readonly { provider: string; lastSuccessAt: Instant | null }[], requirements: FreshnessRequirements, providerFor: (dataClass: string) => string | null, now: Instant): FreshnessSummaryEntry[] {
  const byProvider = new Map(feeds.map((x) => [x.provider, x.lastSuccessAt]));
  return requirements.requirements.map((r) => {
    const provider = providerFor(r.dataClass);
    const last = provider ? (byProvider.get(provider) ?? null) : null;
    const ageMs = last ? Math.max(0, instantToMs(now) - instantToMs(last)) : null;
    return { dataClass: r.dataClass, ageMs, fresh: ageMs !== null && ageMs <= r.freshMaxAgeMs };
  });
}
