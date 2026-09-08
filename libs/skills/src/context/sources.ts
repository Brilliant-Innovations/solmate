import type { AssetEligibility, Candidate, FeatureSnapshot, HeldAssetSafety, Instant, IntelligenceEvent, MarketSnapshot, Uuid } from '@sol-agent-trader/contracts';

/**
 * Point-in-time reads the context builder and the read tools depend on (blueprint §11.4, §18.3,
 * INV-13). Every read takes `asOf` and must return only what was first seen or observed at or
 * before it; the worker binds these to repositories, tests bind fakes. Nothing here can write.
 */

export interface PositionFacts {
  id: Uuid;
  accountId: Uuid;
  assetId: Uuid;
  symbol: string;
  quantity: string;
  averageEntryPrice: number | null;
  costBasisBaseUnits: string;
  markPrice: number | null;
  markAt: Instant | null;
  unrealizedPnlBaseUnits: string | null;
  stop: { model: string; level: number | null; distanceFraction: number } | null;
  target: { policy: string; level: number | null } | null;
  unreviewedStop: number | null;
  protectionMode: string | null;
  safetyState: string;
  reviewState: string;
  reviewStateSince: Instant;
  openedAt: Instant;
  lastReviewedCycleId: Uuid | null;
  thesis: string | null;
  invalidation: string | null;
  expectedHorizonEndsAt: Instant | null;
}

export interface OnchainFacts {
  assetId: Uuid;
  asOf: Instant;
  /** Net flow of tracked (smart-money) wallets over recent windows, in settlement USD; own wallets excluded (§18.3). */
  smartMoneyNetFlowUsd: Record<string, number | null>;
  trackedWalletsAccumulating: number;
  trackedWalletsDistributing: number;
  holderCount: number | null;
  topHolderConcentration: number | null;
  ownWalletActivityExcluded: true;
}

export interface PortfolioFacts {
  accountId: Uuid;
  asOf: Instant;
  settlementMint: string;
  equityBaseUnits: string;
  exposureAtCostBaseUnits: string;
  openPositions: { id: Uuid; assetId: Uuid; costBasis: string }[];
  cohortUsage: Record<string, string>;
  clusterUsage: Record<string, string>;
  sleeves: { strategyVersionId: string; capitalCapBaseUnits: string; committedBaseUnits: string; riskBudgetBaseUnits: string; riskUsedBaseUnits: string }[];
  dayDrawdownFraction: number | null;
  entriesPaused: boolean;
  feedsBlockEntries: boolean;
}

export interface ExecutionPreviewFacts {
  assetId: Uuid;
  asOf: Instant;
  side: 'BUY' | 'SELL';
  /** The deterministic size the risk core would use; the model never chooses it. */
  notionalBaseUnits: string;
  quoteAt: Instant;
  expectedPriceImpactBps: number | null;
  expectedSlippageBps: number | null;
  routeHops: number | null;
  routeLabels: string[];
  quoteAgeMs: number;
  stale: boolean;
}

export interface ContextSources {
  candidate(candidateId: Uuid, asOf: Instant): Promise<Candidate | null>;
  position(positionId: Uuid, asOf: Instant): Promise<PositionFacts | null>;
  featureSnapshotAt(assetId: Uuid, asOf: Instant): Promise<FeatureSnapshot | null>;
  marketSnapshotAt(assetId: Uuid, asOf: Instant): Promise<MarketSnapshot | null>;
  eligibilityAt(assetId: Uuid, asOf: Instant): Promise<AssetEligibility | null>;
  safetyAt(positionId: Uuid, asOf: Instant): Promise<HeldAssetSafety | null>;
  eventsVisibleAt(assetId: Uuid, asOf: Instant, limit: number): Promise<IntelligenceEvent[]>;
  onchainAt(assetId: Uuid, asOf: Instant): Promise<OnchainFacts | null>;
  portfolioAt(accountId: Uuid, asOf: Instant): Promise<PortfolioFacts>;
  executionPreview(assetId: Uuid, side: 'BUY' | 'SELL', asOf: Instant): Promise<ExecutionPreviewFacts | null>;
  cohortPeers(assetId: Uuid, asOf: Instant): Promise<Uuid[]>;
}
