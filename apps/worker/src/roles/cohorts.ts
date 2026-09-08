import { randomUUID } from 'node:crypto';
import { addMs, instantToMs, toInstant, type Candle, type Clock, type CohortTaxonomyPolicy, type CorrelationClusterPolicy, type CorrelationClusterSet, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { clusterByCorrelation, clusterSetOf, sampledReturns } from '@sol-agent-trader/risk';

/**
 * Worker role `cohorts` (blueprint §6.3, §8.4, D23; execution plan M5b): installs the versioned
 * taxonomy once per start and recomputes the deterministic rolling correlation clusters on a
 * cadence from closed 1m candles. Nothing here consults a provider or an LLM; the cluster set is
 * a pure function of stored candles and the versioned policy, and each window is stored once.
 */

export interface CohortsRepo {
  installTaxonomy(taxonomy: CohortTaxonomyPolicy): Promise<{ version: string; cohorts: number; memberships: number; unknownMints: number }>;
  listAssetsWithCandles(from: Instant, to: Instant, limit: number): Promise<{ assetId: Uuid; candles: number }[]>;
  loadCandles(assetId: Uuid, resolution: '1m', from: Instant, to: Instant): Promise<Candle[]>;
  insertClusterSet(set: CorrelationClusterSet): Promise<'INSERTED' | 'EXISTS'>;
}

export interface CohortsDeps {
  repo: CohortsRepo;
  clock: Clock;
  logger: Logger;
  taxonomy: CohortTaxonomyPolicy;
  clusterPolicy: CorrelationClusterPolicy;
  config: { maxAssets: number };
}

export interface CohortsReport {
  windowEnd: Instant;
  assets: number;
  clustered: number;
  unclustered: number;
  clusters: number;
  pairs: number;
  stored: 'INSERTED' | 'EXISTS';
  errors: { assetId: Uuid; error: string }[];
}

const HOUR = 3_600_000;

/** Windows end on the hour so a recomputation inside the same hour finds its set already stored. */
export function clusterWindowEnd(now: Instant): Instant {
  return toInstant(Math.floor(instantToMs(now) / HOUR) * HOUR);
}

export async function installCohortTaxonomy(deps: Pick<CohortsDeps, 'repo' | 'logger' | 'taxonomy'>): Promise<void> {
  const r = await deps.repo.installTaxonomy(deps.taxonomy);
  deps.logger.info('cohort_taxonomy_installed', { version: r.version, cohorts: r.cohorts, newMemberships: r.memberships, unknownMints: r.unknownMints });
}

export async function runCohortsCycle(deps: CohortsDeps): Promise<CohortsReport> {
  const now = deps.clock.now();
  const windowEnd = clusterWindowEnd(now);
  const windowStart = addMs(windowEnd, -deps.clusterPolicy.windowMs);
  const assets = await deps.repo.listAssetsWithCandles(windowStart, windowEnd, deps.config.maxAssets);
  const inputs = [];
  const errors: CohortsReport['errors'] = [];
  for (const a of assets) {
    try {
      const candles = await deps.repo.loadCandles(a.assetId, '1m', windowStart, windowEnd);
      inputs.push({ assetId: a.assetId, returns: sampledReturns(candles.map((c) => ({ bucketTime: c.bucketTime, close: c.close })), deps.clusterPolicy.sampleMinutes) });
    } catch (err) {
      errors.push({ assetId: a.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const result = clusterByCorrelation(inputs, deps.clusterPolicy);
  const set = clusterSetOf(randomUUID() as Uuid, result, deps.clusterPolicy, windowEnd, now);
  const stored = await deps.repo.insertClusterSet(set);
  const report: CohortsReport = { windowEnd, assets: assets.length, clustered: result.clusters.reduce((n, c) => n + c.assetIds.length, 0), unclustered: result.unclustered.length, clusters: result.clusters.length, pairs: result.pairs, stored, errors };
  deps.logger.info('cohorts_cycle', { ...report, errors: errors.length, policy: deps.clusterPolicy.version, versionId: set.versionId });
  for (const e of errors) deps.logger.warn('cohorts_asset_failed', e);
  return report;
}
