import type { AssetStatus, FeatureSnapshot, Instant, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Feature-snapshot persistence (blueprint §6.8). Rows are immutable (trigger); one snapshot per
 * asset per `as_of` is the convention the worker keeps by aligning `as_of` to the closed minute.
 */

export interface AssetForFeatures {
  id: Uuid;
  mintAddress: string;
  status: AssetStatus;
  lastFeatureAsOf: Instant | null;
}

/** Assets worth a feature vector: eligible or still evaluating, with their last snapshot time. */
export async function listAssetsForFeatures(sql: Sql, limit: number): Promise<AssetForFeatures[]> {
  const rows = await sql<{ id: string; mint_address: string; status: AssetStatus; last_as_of: string | null }[]>`
    select a.id, a.mint_address, a.status, f.last_as_of
    from core.assets a
    left join lateral (select max(as_of) as last_as_of from signals.feature_snapshots x where x.asset_id = a.id) f on true
    where a.status in ('ELIGIBLE', 'EVALUATING')
    order by a.status = 'ELIGIBLE' desc, f.last_as_of asc nulls first
    limit ${limit}`;
  return rows.map((r) => ({ id: r.id as Uuid, mintAddress: r.mint_address, status: r.status, lastFeatureAsOf: r.last_as_of ? (new Date(r.last_as_of).toISOString() as Instant) : null }));
}

export async function insertFeatureSnapshot(sql: Sql, s: FeatureSnapshot): Promise<void> {
  await sql`
    insert into signals.feature_snapshots (id, asset_id, as_of, feature_engine_version, provenance, market_snapshot_id, features, regime, market_sessions, self_influence_suppressed)
    values (${s.id}, ${s.assetId}, ${s.asOf}, ${s.featureEngineVersion}, ${s.provenance}, ${s.marketSnapshotId}, ${sql.json(asJson(s.features))}, ${s.regime}, ${s.marketSessions}, ${s.selfInfluenceSuppressed})`;
}

export async function latestFeatureSnapshot(sql: Sql, assetId: Uuid): Promise<FeatureSnapshot | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from signals.feature_snapshots where asset_id = ${assetId} order by as_of desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    assetId: r['asset_id'] as Uuid,
    asOf: new Date(r['as_of'] as string).toISOString() as Instant,
    featureEngineVersion: r['feature_engine_version'] as FeatureSnapshot['featureEngineVersion'],
    provenance: r['provenance'] as FeatureSnapshot['provenance'],
    marketSnapshotId: r['market_snapshot_id'] as Uuid | null,
    features: r['features'] as FeatureSnapshot['features'],
    regime: r['regime'] as FeatureSnapshot['regime'],
    marketSessions: r['market_sessions'] as FeatureSnapshot['marketSessions'],
    selfInfluenceSuppressed: r['self_influence_suppressed'] as boolean,
  };
}

/** The most recent market snapshot at or before `asOf`, to link the feature vector to what it was derived from. */
export async function latestMarketSnapshotId(sql: Sql, assetId: Uuid, asOf: Instant): Promise<Uuid | null> {
  const [r] = await sql<{ id: string }[]>`
    select id from market.snapshots where asset_id = ${assetId} and as_of <= ${asOf} order by as_of desc limit 1`;
  return r ? (r.id as Uuid) : null;
}
