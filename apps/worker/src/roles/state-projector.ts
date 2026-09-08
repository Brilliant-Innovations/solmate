import { addAmounts, instantToMs, type Amount, type Clock, type CorrelationClusterSet, type CustodyReconciliation, type EligibilitySummaryEntry, type FreshnessRequirements, type Instant, type MintAddress, type OpenLotSummary, type Release, type RiskPolicy, type Sequence, type Sha256Hex, type SignedRiskStateProjection, type SigningKeyPair, type Slot, type StrategySleeve, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { PaperBook } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { buildRiskStateProjection, freshnessSummaryFrom, signProjection, type ActiveMembership } from '@sol-agent-trader/risk';

/**
 * Worker role `state-projector` (blueprint §6.14A, §13.6, D21, D52; ADR-0009 P1; execution plan
 * M7). Each tick assembles the account's risk state from what the worker already records (paper
 * book and sleeves, open lots with their protection, the newest custody reconciliation, held-asset
 * eligibility, provider freshness, cohort and cluster capacity, the strategy Release), signs it
 * with the projection key the worker alone holds, and appends it with the next sequence. The
 * risk-authorizer verifies signature, sequence, age, Release and, for live entries, chain truth.
 */

export interface StateProjectorRepo {
  book(now: Instant): Promise<PaperBook>;
  sleeves(): Promise<StrategySleeve[]>;
  openLots(): Promise<OpenLotSummary[]>;
  latestReconciliation(): Promise<Pick<CustodyReconciliation, 'evaluatedAt' | 'chainSlot' | 'status' | 'balances'> | null>;
  heldAssetEligibility(): Promise<EligibilitySummaryEntry[]>;
  feedHealth(): Promise<{ provider: string; lastSuccessAt: Instant | null }[]>;
  cohorts(now: Instant): Promise<{ memberships: ActiveMembership[]; clusterSet: CorrelationClusterSet | null }>;
  nextSequence(): Promise<Sequence>;
  insert(envelope: SignedRiskStateProjection): Promise<void>;
}

export interface StateProjectorDeps {
  repo: StateProjectorRepo;
  key: SigningKeyPair;
  clock: Clock;
  logger: Logger;
  account: { id: Uuid; settlementMint: MintAddress; settlementDecimals: number; startingCapital: Amount; virtualSolLamports: Amount };
  release: Release;
  policy: Pick<RiskPolicy, 'version' | 'maxCohortExposureFraction' | 'maxClusterExposureFraction'>;
  freshness: FreshnessRequirements;
  providerFor: (dataClass: string) => string | null;
  config: { reconciliationMaxAgeMs: number };
}

export interface StateProjectorReport {
  sequence: Sequence;
  chainSlot: Slot;
  lots: number;
  sleeves: number;
  custody: number;
  reconciliationAgeMs: number | null;
  reconciliationStatus: string | null;
  exposureBaseUnits: Amount;
  pendingBaseUnits: Amount;
  payloadHash: Sha256Hex;
}

export async function runStateProjectorCycle(deps: StateProjectorDeps): Promise<StateProjectorReport> {
  const now = deps.clock.now();
  const [book, sleeves, lots, recon, eligibility, feeds, cohorts, sequence] = await Promise.all([
    deps.repo.book(now),
    deps.repo.sleeves(),
    deps.repo.openLots(),
    deps.repo.latestReconciliation(),
    deps.repo.heldAssetEligibility(),
    deps.repo.feedHealth(),
    deps.repo.cohorts(now),
    deps.repo.nextSequence(),
  ]);
  const reconAgeMs = recon ? Math.max(0, instantToMs(now) - instantToMs(recon.evaluatedAt)) : null;
  const reconFresh = recon !== null && reconAgeMs !== null && reconAgeMs <= deps.config.reconciliationMaxAgeMs && recon.status !== 'UNAVAILABLE';
  // Custody as the chain last showed it; a stale or unavailable reconciliation projects no custody, so a live authorization cannot rest on it.
  const custody = reconFresh ? recon.balances.filter((b) => b.custodyAccountId !== null && b.mint !== null && b.observed !== null).map((b) => ({ custodyAccountId: b.custodyAccountId as Uuid, mint: b.mint as MintAddress, amount: b.observed as Amount })) : [];
  const equity = addAmounts(book.settlementBalance, book.markValue);
  const decimals = 10 ** deps.account.settlementDecimals;
  const usd = (a: Amount) => Number(BigInt(a)) / decimals;
  const sourceDigests = [{ source: 'release', digest: deps.release.digest }];
  const projection = buildRiskStateProjection({
    sequence,
    asOf: now,
    chainSlot: (reconFresh && recon.chainSlot !== null ? recon.chainSlot : 0) as Slot,
    release: { id: deps.release.id, digest: deps.release.digest },
    policyVersion: deps.policy.version,
    sourceDigests,
    settlementMint: deps.account.settlementMint,
    custody,
    settlementAvailableBaseUnits: book.settlementBalance,
    gasReserveLamports: addAmounts(deps.account.virtualSolLamports),
    pendingExposureBaseUnits: book.pendingExposure,
    sleeves,
    openLots: lots,
    equityBaseUnits: equity,
    exposureUsd: usd(book.markValue),
    dayStartEquity: book.dayStartEquity,
    rollingHighEquity: book.rollingHighEquity,
    consecutiveLosses: book.consecutiveLosses,
    circuitBreakerTripped: false,
    memberships: cohorts.memberships,
    clusterSet: cohorts.clusterSet,
    policy: deps.policy,
    eligibility,
    freshness: freshnessSummaryFrom(feeds, deps.freshness, deps.providerFor, now),
    capital: { ceilingUsd: usd(deps.account.startingCapital), recognizedUsd: usd(equity) },
  });
  const envelope = await signProjection(projection, deps.key, now);
  await deps.repo.insert(envelope);
  const report: StateProjectorReport = { sequence, chainSlot: projection.chainSlot, lots: lots.length, sleeves: projection.sleeves.length, custody: custody.length, reconciliationAgeMs: reconAgeMs, reconciliationStatus: recon?.status ?? null, exposureBaseUnits: projection.aggregateNonSettlementExposureBaseUnits, pendingBaseUnits: book.pendingExposure, payloadHash: envelope.payloadHash };
  deps.logger.info('state_projection', { ...report, keyId: envelope.keyId, release: deps.release.digest.slice(0, 12), policy: deps.policy.version, reattestRequired: projection.capitalAttestation.reattestRequired, signerDependent: projection.signerDependentExposureBaseUnits });
  return report;
}

export type { VersionId };
