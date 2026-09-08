import { addAmounts, amountToBigInt, compareAmounts, instantToMs, type Amount, type Bps, type Instant, type MintAddress, type Quote, type SolanaAddress, type SolanaCluster, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { cohortPeersOf, eligibilityAt, featureSnapshotAt, listActiveMemberships, listEventsVisibleAt, marketSnapshotAt, onchainFlowAt, paperBook, positionContextAt, safetyAt, entryHealth, latestClusterSet, type Sql } from '@sol-agent-trader/db/server';
import { NoRouteError } from '@sol-agent-trader/execution';
import { cohortUsage, clusterForAsset } from '@sol-agent-trader/risk';
import type { ContextSources, ExecutionPreviewFacts, OnchainFacts, PortfolioFacts, PositionFacts } from '@sol-agent-trader/skills';

/**
 * Repository-bound point-in-time sources for the Trading Skill (blueprint §11.4, §18.3; INV-13).
 * Every read goes through the as-of queries in libs/db; the paper book and the execution preview
 * are live reads (they describe the account now, which is what the deterministic risk core will
 * also see). Nothing here writes.
 */
export interface RepoSourcesDeps {
  sql: Sql;
  account: { id: Uuid; settlementMint: MintAddress; settlementDecimals: number; startingCapital: Amount };
  taker: SolanaAddress;
  cluster: SolanaCluster;
  quotes: { quote(request: { inputMint: MintAddress; outputMint: MintAddress; inputAmount: Amount; maxSlippageBps: Bps; taker: SolanaAddress; cluster: SolanaCluster; requestedAt: Instant }): Promise<{ quote: Quote }> };
  policy: { maxPositionValueBaseUnits: Amount; maxSlippageBps: Bps; maxQuoteAgeMs: number };
  taxonomyVersion: VersionId;
  clusterWindowMs: number;
  assetMint(assetId: Uuid): Promise<MintAddress | null>;
}

export function createRepoContextSources(d: RepoSourcesDeps): ContextSources {
  const { sql } = d;
  return {
    async candidate(candidateId, asOf) {
      const [r] = await sql<Record<string, unknown>[]>`select * from signals.candidates where id = ${candidateId} and discovered_at <= ${asOf}`;
      if (!r) return null;
      return {
        id: r['id'] as Uuid, assetId: r['asset_id'] as Uuid, discoveredAt: new Date(r['discovered_at'] as string).toISOString() as Instant, triggerFamily: r['trigger_family'] as never, triggerDetails: r['trigger_details'] as Record<string, unknown>, scannerScore: Number(r['scanner_score']), status: r['status'] as never,
        featureSnapshotId: r['feature_snapshot_id'] as Uuid, eligibilityEvaluationId: r['eligibility_evaluation_id'] as Uuid, expiresAt: new Date(r['expires_at'] as string).toISOString() as Instant, deterministicRejectionReason: (r['deterministic_rejection_reason'] as never) ?? null, dedupeKey: r['dedupe_key'] as string, strategyVersionIds: (r['strategy_version_ids'] as VersionId[]) ?? [],
      };
    },
    async position(positionId, asOf): Promise<PositionFacts | null> {
      const p = await positionContextAt(sql, positionId, asOf);
      if (!p) return null;
      return { ...p };
    },
    featureSnapshotAt: (assetId, asOf) => featureSnapshotAt(sql, assetId, asOf),
    marketSnapshotAt: (assetId, asOf) => marketSnapshotAt(sql, assetId, asOf),
    eligibilityAt: (assetId, asOf) => eligibilityAt(sql, assetId, asOf),
    safetyAt: (positionId, asOf) => safetyAt(sql, positionId, asOf),
    eventsVisibleAt: (assetId, asOf, limit) => listEventsVisibleAt(sql, assetId, asOf, limit),
    async onchainAt(assetId, asOf): Promise<OnchainFacts | null> {
      const mint = await d.assetMint(assetId);
      if (!mint) return null;
      const flow = await onchainFlowAt(sql, assetId, mint, asOf);
      const usd = (v: string): number | null => (v === '0' ? 0 : Number(amountToBigInt(v as Amount)) / 10 ** d.account.settlementDecimals);
      return { assetId, asOf, smartMoneyNetFlowUsd: { h1: usd(flow.netQuoteFlow.h1), h4: usd(flow.netQuoteFlow.h4), h24: usd(flow.netQuoteFlow.h24) }, trackedWalletsAccumulating: flow.buyers.h24, trackedWalletsDistributing: flow.sellers.h24, holderCount: null, topHolderConcentration: null, ownWalletActivityExcluded: true };
    },
    async portfolioAt(accountId, asOf): Promise<PortfolioFacts> {
      const [book, health, memberships, clusterSet] = await Promise.all([paperBook(sql, accountId, d.account.settlementMint, d.account.startingCapital, asOf), entryHealth(sql), listActiveMemberships(sql, d.taxonomyVersion), latestClusterSet(sql, asOf, d.clusterWindowMs)]);
      const equity = addAmounts(book.settlementBalance, book.markValue);
      const open = book.openPositions.map((p) => ({ assetId: p.assetId, costBasis: p.costBasis }));
      const cohorts: Record<string, string> = {};
      for (const [name, u] of cohortUsage(open, memberships, equity)) cohorts[name] = u.usedFraction.toFixed(6);
      const clusters: Record<string, string> = {};
      for (const p of book.openPositions) {
        const c = clusterForAsset(p.assetId, open, clusterSet, equity);
        if (c) clusters[c.id] = c.usedFraction.toFixed(6);
      }
      const dd = book.dayStartEquity && amountToBigInt(book.dayStartEquity) > 0n ? Math.max(0, Number(amountToBigInt(book.dayStartEquity) - amountToBigInt(equity)) / Number(amountToBigInt(book.dayStartEquity))) : null;
      return {
        accountId, asOf, settlementMint: d.account.settlementMint, equityBaseUnits: equity, exposureAtCostBaseUnits: book.exposureAtCost, openPositions: book.openPositions.map((p) => ({ id: p.id, assetId: p.assetId, costBasis: p.costBasis })), cohortUsage: cohorts, clusterUsage: clusters,
        sleeves: book.sleeves.map((s) => ({ strategyVersionId: s.strategyVersionId, capitalCapBaseUnits: s.capitalCapBaseUnits, committedBaseUnits: s.committedBaseUnits, riskBudgetBaseUnits: s.riskBudgetBaseUnits, riskUsedBaseUnits: s.riskUsedBaseUnits })),
        dayDrawdownFraction: dd, entriesPaused: health.entriesPaused, feedsBlockEntries: health.feedsBlockEntries,
      };
    },
    async executionPreview(assetId, side, asOf): Promise<ExecutionPreviewFacts | null> {
      const mint = await d.assetMint(assetId);
      if (!mint) return null;
      let inputMint: MintAddress;
      let outputMint: MintAddress;
      let inputAmount: Amount;
      if (side === 'BUY') {
        const book = await paperBook(sql, d.account.id, d.account.settlementMint, d.account.startingCapital, asOf);
        inputMint = d.account.settlementMint;
        outputMint = mint;
        inputAmount = compareAmounts(d.policy.maxPositionValueBaseUnits, book.settlementBalance) < 0 ? d.policy.maxPositionValueBaseUnits : book.settlementBalance;
      } else {
        const [pos] = await sql<{ id: string; quantity: string }[]>`select id, quantity::text as quantity from trading.positions where asset_id = ${assetId} and account_id = ${d.account.id} and status <> 'CLOSED' order by opened_at desc limit 1`;
        if (!pos) return null;
        inputMint = mint;
        outputMint = d.account.settlementMint;
        inputAmount = pos.quantity as Amount;
      }
      if (amountToBigInt(inputAmount) <= 0n) return null;
      try {
        const { quote } = await d.quotes.quote({ inputMint, outputMint, inputAmount, maxSlippageBps: d.policy.maxSlippageBps, taker: d.taker, cluster: d.cluster, requestedAt: asOf });
        const quoteAgeMs = Math.max(0, instantToMs(asOf) - instantToMs(quote.quotedAt));
        return { assetId, asOf, side, notionalBaseUnits: inputAmount, quoteAt: quote.quotedAt, expectedPriceImpactBps: quote.priceImpactBps, expectedSlippageBps: quote.slippageBps, routeHops: quote.routeProgramIds.length, routeLabels: [quote.routerLabel ?? 'unknown', ...quote.routeProgramIds], quoteAgeMs, stale: quoteAgeMs > d.policy.maxQuoteAgeMs };
      } catch (err) {
        if (err instanceof NoRouteError) return { assetId, asOf, side, notionalBaseUnits: inputAmount, quoteAt: asOf, expectedPriceImpactBps: null, expectedSlippageBps: null, routeHops: 0, routeLabels: [], quoteAgeMs: 0, stale: false };
        throw err;
      }
    },
    cohortPeers: (assetId) => cohortPeersOf(sql, assetId, d.taxonomyVersion),
  };
}

