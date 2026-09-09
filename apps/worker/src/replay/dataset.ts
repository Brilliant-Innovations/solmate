import { addMs, type Instant, type ReplayRun, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { listActiveMemberships, listCandlesByMint, listEligibilityBetween, listEventsBetween, listFeatureValuesByMint, listQuoteProbesBetween, listRecordedDecisionsBetween, listReplayUniverse, loadCandles, type Sql } from '@sol-agent-trader/db/server';
import type { ReplayDataset } from './types.js';

/**
 * Loads everything one run may read (blueprint §18.1 Level A/B inputs) into a frozen dataset.
 * Rows are loaded for the window plus the feature lookback; the engine's guard, not this loader,
 * decides what is visible at each simulated moment, so loading a little extra can never leak.
 */
export interface DatasetOptions {
  lookbackMs: number;
  taxonomyVersion: VersionId;
  solMint: string;
  /** Strategy versions whose live decisions are replayed as records (S1+). */
  recordedStrategyVersionIds: readonly VersionId[];
}

export async function loadReplayDataset(sql: Sql, run: ReplayRun, assetIds: readonly Uuid[] | null, opts: DatasetOptions): Promise<ReplayDataset> {
  const from = run.window.from;
  const to = run.window.datasetCutoff;
  const back = addMs(from, -opts.lookbackMs);
  const universe = await listReplayUniverse(sql, from, run.window.to, assetIds);
  const assets = universe.assets;
  const candles = new Map<Uuid, Awaited<ReturnType<typeof loadCandles>>>();
  const eligibility = new Map<Uuid, Awaited<ReturnType<typeof listEligibilityBetween>>>();
  const quoteProbes = new Map<Uuid, Awaited<ReturnType<typeof listQuoteProbesBetween>>>();
  for (const a of assets) {
    candles.set(a.id, await loadCandles(sql, a.id, '1m', back, to));
    eligibility.set(a.id, await listEligibilityBetween(sql, a.id, addMs(from, -86_400_000), to));
    quoteProbes.set(a.id, run.fidelity === 'B_CAPTURED' ? await listQuoteProbesBetween(sql, a.id, back, to) : []);
  }
  const [events, memberships, recorded, sol, solCandles] = await Promise.all([
    listEventsBetween(sql, addMs(from, -86_400_000), to),
    listActiveMemberships(sql, opts.taxonomyVersion),
    opts.recordedStrategyVersionIds.length ? listRecordedDecisionsBetween(sql, opts.recordedStrategyVersionIds, from, to) : Promise.resolve([]),
    listFeatureValuesByMint(sql, opts.solMint, 'ret_1h', back, to),
    // Network and priority fees are paid in SOL; without a price they cannot enter the reported
    // net P&L at all, which is how a modelled fee ended up charged to nothing (review 2026-09-09,
    // M-14). The window's mean SOL close is the honest, dataset-local conversion.
    listCandlesByMint(sql, opts.solMint, '1m', from, run.window.to),
  ]);
  const solCloses = solCandles.map((c) => c.close).filter((x) => x > 0);
  return {
    assets: assets.map((a) => ({ id: a.id, mint: a.mint as never, symbol: a.symbol, decimals: a.decimals, tokenProgram: a.tokenProgram })),
    candles,
    eligibility,
    quoteProbes,
    events,
    memberships: memberships.map((m) => ({ assetId: m.assetId, cohortId: m.cohortId, cohortName: m.cohortName })),
    recorded: recorded.map((r) => ({
      candidateId: r.candidateId,
      strategyVersionId: r.strategyVersionId,
      cycle: { id: r.cycle.id, state: r.cycle.state as never, startedAt: r.cycle.startedAt, verdict: r.cycle.verdict, reasonCodes: r.cycle.reasonCodes },
      proposal: r.proposal,
      review: r.review ? { verdict: r.review.verdict as never, objections: r.review.objections, confidence: r.review.confidence } : null,
      decidedAt: r.decidedAt,
    })),
    solReturn1h: new Map(sol.map((v) => [v.asOf as string, v.value] as [Instant, number])),
    universe: { requested: universe.requested, selected: assets.length, available: universe.available, truncated: universe.truncated, selectionRule: universe.selectionRule },
    solPriceSettlement: solCloses.length ? solCloses.reduce((a, b) => a + b, 0) / solCloses.length : null,
  };
}