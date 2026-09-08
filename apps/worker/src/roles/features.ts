import { randomUUID } from 'node:crypto';
import { addMs, instantToMs, type AssetEligibility, type Candle, type Clock, type FeatureEngineSpec, type FeatureSnapshot, type Instant, type MarketRegime, type MarketRegimePolicy, type Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { classifyRegime, computeFeatures, marketSessionsAt, relativeStrength, type UniverseAsset } from '@sol-agent-trader/signals';

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
  /** ACTIVE taxonomy memberships (§6.3) for cohort relative strength and rotation detection. */
  listActiveMemberships(): Promise<{ assetId: Uuid; cohortName: string }[]>;
  /** SOL reference 1h return at or shortly before asOf (§8.4); null when the reference series is cold. */
  solReferenceReturn1h(asOf: Instant): Promise<number | null>;
}

export interface FeaturesDeps {
  repo: FeaturesRepo;
  clock: Clock;
  logger: Logger;
  spec: FeatureEngineSpec;
  regimePolicy: MarketRegimePolicy;
  config: { batchSize: number };
}

export interface FeaturesCycleReport {
  assets: number;
  computed: number;
  skippedCurrent: number;
  warm: number;
  cold: number;
  regime: MarketRegime | null;
  errors: { assetId: Uuid; error: string }[];
}

const MINUTE = 60_000;

/** The last closed 1m bucket boundary at or before `now`: the point in time every vector is computed for. */
export function featureAsOf(now: Instant): Instant {
  return addMs(now, -(instantToMs(now) % MINUTE)) as Instant;
}

export async function runFeaturesCycle(deps: FeaturesDeps): Promise<FeaturesCycleReport> {
  const report: FeaturesCycleReport = { assets: 0, computed: 0, skippedCurrent: 0, warm: 0, cold: 0, regime: null, errors: [] };
  const pending: { snapshot: FeatureSnapshot; warm: boolean }[] = [];
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
      pending.push({ snapshot, warm: warmup.ready });
      report.computed++;
      if (warmup.ready) report.warm++;
      else report.cold++;
    } catch (err) {
      report.errors.push({ assetId: asset.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Cross-asset pass (§8.4, §8.5): regime and relative strength over this minute's warm vectors, then persist.
  const num = (s: FeatureSnapshot, n: string): number | null => (typeof s.features[n] === 'number' ? (s.features[n] as number) : null);
  const [memberships, solReturn1h] = await Promise.all([deps.repo.listActiveMemberships(), deps.repo.solReferenceReturn1h(asOf)]);
  const cohortsOf = new Map<Uuid, string[]>();
  for (const m of memberships) cohortsOf.set(m.assetId, [...(cohortsOf.get(m.assetId) ?? []), m.cohortName]);
  const universe: UniverseAsset[] = pending.map(({ snapshot }) => ({ assetId: snapshot.assetId, ret1h: num(snapshot, 'ret_1h'), relVolume60: num(snapshot, 'rel_volume_60'), cohorts: cohortsOf.get(snapshot.assetId) ?? [] }));
  const regime = classifyRegime({ sol: { ret1h: solReturn1h }, assets: universe, policy: deps.regimePolicy });
  const rs = relativeStrength(universe);
  report.regime = regime.regime;
  for (const { snapshot } of pending) {
    const r = rs.get(snapshot.assetId);
    const labelled: FeatureSnapshot = { ...snapshot, regime: regime.regime, features: { ...snapshot.features, rs_universe_1h: r?.rsUniverse1h ?? null, rs_cohort_1h: r?.rsCohort1h ?? null } };
    try {
      await deps.repo.insertFeatureSnapshot(labelled);
    } catch (err) {
      report.errors.push({ assetId: snapshot.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('features_cycle', { asOf, assets: report.assets, computed: report.computed, skippedCurrent: report.skippedCurrent, warm: report.warm, cold: report.cold, regime: regime.regime, regimeFacts: regime.facts, errors: report.errors.length, engine: deps.spec.version, regimePolicy: deps.regimePolicy.version });
  for (const e of report.errors) deps.logger.warn('features_asset_failed', { assetId: e.assetId, error: e.error });
  return report;
}
