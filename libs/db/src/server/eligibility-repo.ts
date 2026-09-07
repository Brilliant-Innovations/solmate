import type { AssetEligibility, AssetStatus, Instant, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Eligibility persistence (blueprint §6.2, §7.4). Records are append-only (trigger); the asset's
 * status is the derived, mutable pointer. Both are written in one transaction so a status can
 * never disagree with the latest record.
 */

export interface AssetForEvaluation {
  id: Uuid;
  mintAddress: string;
  status: AssetStatus;
  lastEvaluatedAt: Instant | null;
}

/** Assets due for (re-)evaluation: never evaluated first, then oldest evaluation first (§7.4 periodic refresh). */
export async function listAssetsForEvaluation(sql: Sql, opts: { limit: number; reevaluateAfter: Instant }): Promise<AssetForEvaluation[]> {
  const rows = await sql<{ id: string; mint_address: string; status: AssetStatus; last_evaluated_at: string | null }[]>`
    select a.id, a.mint_address, a.status, e.last_evaluated_at
    from core.assets a
    left join lateral (
      select max(evaluated_at) as last_evaluated_at from core.asset_eligibility x where x.asset_id = a.id
    ) e on true
    where a.status in ('DISCOVERED', 'EVALUATING', 'ELIGIBLE')
      and (e.last_evaluated_at is null or e.last_evaluated_at < ${opts.reevaluateAfter})
    order by e.last_evaluated_at asc nulls first, a.first_observed_at desc
    limit ${opts.limit}`;
  return rows.map((r) => ({ id: r.id as Uuid, mintAddress: r.mint_address, status: r.status, lastEvaluatedAt: r.last_evaluated_at ? (new Date(r.last_evaluated_at).toISOString() as Instant) : null }));
}

/** Appends the record and moves the asset to `status` atomically. */
export async function recordEligibility(sql: Sql, record: AssetEligibility, status: AssetStatus): Promise<void> {
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    await txSql`
      insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, volume_24h_usd, holder_count,
        concentration, mint_authority, freeze_authority, token2022, security_flags, transfer_restrictions, jupiter_route_available, settlement_route_confirmed, price_impact_probes,
        insider_metrics, emergency_exit_route_snapshot_id, freshness)
      values (${record.id}, ${record.assetId}, ${record.evaluatedAt}, ${record.policyVersion}, ${record.eligible}, ${record.hardReject}, ${record.rejectionReasons}, ${record.grade},
        ${record.liquidityUsd}, ${record.volume24hUsd}, ${record.holderCount}, ${record.concentration ? txSql.json(asJson(record.concentration)) : null}, ${record.mintAuthority}, ${record.freezeAuthority},
        ${record.token2022 ? txSql.json(asJson(record.token2022)) : null}, ${record.securityFlags}, ${record.transferRestrictions}, ${record.jupiterRouteAvailable}, ${record.settlementRouteConfirmed},
        ${txSql.json(asJson(record.priceImpactProbes))}, ${record.insiderMetrics ? txSql.json(asJson(record.insiderMetrics)) : null}, ${record.emergencyExitRouteSnapshotId}, ${txSql.json(asJson(record.freshness))})`;
    const updated = await txSql<{ id: string }[]>`update core.assets set status = ${status} where id = ${record.assetId} and status <> 'RETIRED' returning id`;
    if (updated.length === 0) throw new Error(`asset ${record.assetId} not found or retired`);
  });
}

export async function latestEligibility(sql: Sql, assetId: Uuid): Promise<AssetEligibility | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from core.asset_eligibility where asset_id = ${assetId} order by evaluated_at desc limit 1`;
  if (!r) return null;
  const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;
  const freshness = r['freshness'] as { securityProviderAt: string | null; chainReadAt: string; chainSlot: number };
  return {
    id: r['id'] as Uuid,
    assetId: r['asset_id'] as Uuid,
    evaluatedAt: iso(r['evaluated_at']),
    policyVersion: r['policy_version'] as AssetEligibility['policyVersion'],
    eligible: r['eligible'] as boolean,
    hardReject: r['hard_reject'] as boolean,
    rejectionReasons: r['rejection_reasons'] as AssetEligibility['rejectionReasons'],
    grade: r['grade'] as number | null,
    liquidityUsd: r['liquidity_usd'] as number | null,
    volume24hUsd: r['volume_24h_usd'] as number | null,
    holderCount: r['holder_count'] as number | null,
    concentration: r['concentration'] as AssetEligibility['concentration'],
    mintAuthority: r['mint_authority'] as AssetEligibility['mintAuthority'],
    freezeAuthority: r['freeze_authority'] as AssetEligibility['freezeAuthority'],
    token2022: r['token2022'] as AssetEligibility['token2022'],
    securityFlags: r['security_flags'] as AssetEligibility['securityFlags'],
    transferRestrictions: r['transfer_restrictions'] as AssetEligibility['transferRestrictions'],
    jupiterRouteAvailable: r['jupiter_route_available'] as boolean,
    settlementRouteConfirmed: r['settlement_route_confirmed'] as boolean,
    priceImpactProbes: r['price_impact_probes'] as AssetEligibility['priceImpactProbes'],
    insiderMetrics: r['insider_metrics'] as AssetEligibility['insiderMetrics'],
    emergencyExitRouteSnapshotId: r['emergency_exit_route_snapshot_id'] as Uuid | null,
    freshness: { securityProviderAt: freshness.securityProviderAt, chainReadAt: freshness.chainReadAt, chainSlot: freshness.chainSlot } as AssetEligibility['freshness'],
  };
}
