import { type CohortTaxonomyPolicy, type CorrelationClusterSet, type Instant, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Cohort taxonomy and correlation clusters (blueprint §6.3, D23). Installing a taxonomy version is
 * idempotent: cohort rows are keyed by (name, version) and MANUAL memberships by (asset, cohort,
 * effective version). Only mints that exist in `core.assets` receive memberships; the rest wait
 * for discovery. LLM suggestions never pass through here as ACTIVE (the table forbids it).
 */

export interface InstalledTaxonomy {
  version: VersionId;
  cohorts: number;
  memberships: number;
  unknownMints: number;
}

export async function installTaxonomy(sql: Sql, taxonomy: CohortTaxonomyPolicy): Promise<InstalledTaxonomy> {
  const cohortIds = new Map<string, Uuid>();
  for (const c of taxonomy.cohorts) {
    const [row] = await sql<{ id: Uuid }[]>`
      insert into core.risk_cohorts (name, kind, version_id, active) values (${c.name}, 'TAXONOMY', ${taxonomy.version}, true)
      on conflict (name, version_id) do update set active = true returning id`;
    cohortIds.set(c.name, row!.id);
  }
  const mints = taxonomy.memberships.map((m) => m.mint);
  const assets = await sql<{ id: Uuid; mint_address: string }[]>`select id, mint_address from core.assets where mint_address = any(${mints}::text[])`;
  const byMint = new Map(assets.map((a) => [a.mint_address, a.id]));
  let memberships = 0;
  let unknownMints = 0;
  for (const m of taxonomy.memberships) {
    const assetId = byMint.get(m.mint);
    const cohortId = cohortIds.get(m.cohort);
    if (!cohortId) throw new Error(`taxonomy ${taxonomy.version} lists unknown cohort ${m.cohort}`);
    if (!assetId) {
      unknownMints++;
      continue;
    }
    const [exists] = await sql<{ n: number }[]>`select count(*)::int as n from core.asset_cohort_memberships where asset_id = ${assetId} and cohort_id = ${cohortId} and effective_version = ${taxonomy.version} and source = 'MANUAL'`;
    if (exists && exists.n > 0) continue;
    await sql`insert into core.asset_cohort_memberships (asset_id, cohort_id, source, effective_version, confidence, approval_state) values (${assetId}, ${cohortId}, 'MANUAL', ${taxonomy.version}, ${m.confidence}, 'ACTIVE')`;
    memberships++;
  }
  return { version: taxonomy.version, cohorts: taxonomy.cohorts.length, memberships, unknownMints };
}

export interface ActiveMembershipRow {
  assetId: Uuid;
  cohortId: Uuid;
  cohortName: string;
  effectiveVersion: VersionId;
}

/** ACTIVE memberships of active cohorts for one taxonomy version (the risk core's cohort inputs). */
export async function listActiveMemberships(sql: Sql, version: VersionId): Promise<ActiveMembershipRow[]> {
  const rows = await sql<{ asset_id: Uuid; cohort_id: Uuid; name: string; effective_version: VersionId }[]>`
    select m.asset_id, m.cohort_id, c.name, m.effective_version
    from core.asset_cohort_memberships m join core.risk_cohorts c on c.id = m.cohort_id
    where m.approval_state = 'ACTIVE' and c.active and c.version_id = ${version} and m.source <> 'LLM_SUGGESTION'
    order by m.asset_id, c.name`;
  return rows.map((r) => ({ assetId: r.asset_id, cohortId: r.cohort_id, cohortName: r.name, effectiveVersion: r.effective_version }));
}

export async function insertClusterSet(sql: Sql, set: CorrelationClusterSet): Promise<'INSERTED' | 'EXISTS'> {
  const rows = await sql<{ id: Uuid }[]>`
    insert into risk.correlation_clusters (id, version_id, window_start, window_end, calculated_at, method, clusters)
    values (${set.id}, ${set.versionId}, ${set.windowStart}, ${set.windowEnd}, ${set.calculatedAt}, ${set.method}, ${sql.json(asJson(set.clusters))})
    on conflict (version_id) do nothing returning id`;
  return rows.length ? 'INSERTED' : 'EXISTS';
}

/** The newest cluster set whose window ended within `maxAgeMs` of `now`; older sets are stale and read as no clusters. */
export async function latestClusterSet(sql: Sql, now: Instant, maxAgeMs: number): Promise<CorrelationClusterSet | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select id, version_id, window_start, window_end, calculated_at, method, clusters from risk.correlation_clusters
    where window_end >= ${new Date(new Date(now).getTime() - maxAgeMs).toISOString()} order by window_end desc, calculated_at desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  const iso = (v: unknown) => new Date(v as string).toISOString() as Instant;
  return { id: r['id'] as Uuid, versionId: r['version_id'] as VersionId, windowStart: iso(r['window_start']), windowEnd: iso(r['window_end']), calculatedAt: iso(r['calculated_at']), method: r['method'] as string, clusters: r['clusters'] as CorrelationClusterSet['clusters'] };
}

/** Assets with 1m candles inside the window (the clustering universe), newest activity first. */
export async function listAssetsWithCandles(sql: Sql, from: Instant, to: Instant, limit: number): Promise<{ assetId: Uuid; candles: number }[]> {
  const rows = await sql<{ asset_id: Uuid; n: number }[]>`
    select asset_id, count(*)::int as n from market.candles where resolution = '1m' and bucket_time between ${from} and ${to}
    group by asset_id order by n desc, asset_id limit ${limit}`;
  return rows.map((r) => ({ assetId: r.asset_id, candles: r.n }));
}
