import { randomUUID } from 'node:crypto';
import { addMs, instantToMs, type AssetEligibility, type Candle, type Clock, type FeatureEngineSpec, type FeatureSnapshot, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { computeFeatures, marketSessionsAt } from '@sol-agent-trader/signals';

/**
 * Worker role `features` (blueprint §6.8, §8.1–8.3, D62, D63; execution plan M5a). For every
 * eligible or evaluating asset, once per closed minute: load the closed 1m candles the engine's
 * lookbacks need, the latest eligibility record (liquidity, probes, sell route) and the market
 * snapshot the vector derives from, compute the versioned feature vector point-in-time and persist
 * it immutably. Warm-up state is reported per asset so STARTING can refuse candidate scoring
 * until every required indicator has its history (D63). Self-influence suppression is wired from
 * the position book once fills exist (M5a paper adapter); until then it is false.
 */

export interface FeaturesRepo {
  listAssetsForFeatures(limit: number): Promise<{ id: Uuid; mintAddress: string; lastFeatureAsOf: Instant | null }[]>;
  loadCandles(assetId: Uuid, resolution: '1m', from: Instant, to: Instant): Promise<Candle[]>;
  latestEligibility(assetId: Uuid): Promise<Pick<AssetEligibility, 'liquidityUsd' | 'priceImpactProbes' | 'settlementRouteConfirmed'> | null>;
  latestMarketSnapshotId(assetId: Uuid, asOf: Instant): Promise<Uuid | null>;
  insertFeatureSnapshot(snapshot: FeatureSnapshot): Promise<void>;
}

export interface FeaturesDeps {
  repo: FeaturesRepo;
  clock: Clock;
  logger: Logger;
  spec: FeatureEngineSpec;
  config: { batchSize: number };
}

export interface FeaturesCycleReport {
  assets: number;
  computed: number;
  skippedCurrent: number;
  warm: number;
  cold: number;
  errors: { assetId: Uuid; error: string }[];
}

const MINUTE = 60_000;

/** The last closed 1m bucket boundary at or before `now`: the point in time every vector is computed for. */
export function featureAsOf(now: Instant): Instant {
  return addMs(now, -(instantToMs(now) % MINUTE)) as Instant;
}

export async function runFeaturesCycle(deps: FeaturesDeps): Promise<FeaturesCycleReport> {
  const report: FeaturesCycleReport = { assets: 0, computed: 0, skippedCurrent: 0, warm: 0, cold: 0, errors: [] };
  const now = deps.clock.now();
  const asOf = featureAsOf(now);
  const lookback = Math.max(...Object.values(deps.spec.lookbackBuckets)) + 2;
  const assets = await deps.repo.listAssetsForFeatures(deps.config.batchSize);
  report.assets = assets.length;

  for (const asset of assets) {
    if (asset.lastFeatureAsOf !== null && instantToMs(asset.lastFeatureAsOf) >= instantToMs(asOf)) {
      report.skippedCurrent++;
      continue;
    }
    try {
      const candles = await deps.repo.loadCandles(asset.id, '1m', addMs(asOf, -lookback * MINUTE), asOf);
      if (candles.length === 0) {
        report.cold++;
        continue;
      }
      const [eligibility, marketSnapshotId] = await Promise.all([deps.repo.latestEligibility(asset.id), deps.repo.latestMarketSnapshotId(asset.id, asOf)]);
      const { snapshot, warmup } = computeFeatures({
        id: randomUUID() as Uuid,
        assetId: asset.id,
        asOf,
        provenance: 'LIVE',
        candles1m: candles,
        overview: null,
        eligibility,
        marketSnapshotId,
        marketSessions: marketSessionsAt(asOf),
        selfInfluenceSuppressed: false,
        spec: deps.spec,
      });
      await deps.repo.insertFeatureSnapshot(snapshot);
      report.computed++;
      if (warmup.ready) report.warm++;
      else report.cold++;
    } catch (err) {
      report.errors.push({ assetId: asset.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('features_cycle', { asOf, assets: report.assets, computed: report.computed, skippedCurrent: report.skippedCurrent, warm: report.warm, cold: report.cold, errors: report.errors.length, engine: deps.spec.version });
  for (const e of report.errors) deps.logger.warn('features_asset_failed', { assetId: e.assetId, error: e.error });
  return report;
}
