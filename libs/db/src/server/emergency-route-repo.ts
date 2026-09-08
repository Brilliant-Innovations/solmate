import type { EmergencyExitRouteSnapshot, Instant, MintAddress, Uuid } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';

/**
 * Emergency-route dry-run reads (§14.6; plan M8b). Targets are every asset with an open position
 * on the account plus every asset whose latest eligibility record is ELIGIBLE: those are the
 * assets an emergency close or a LIVE_AUTO entry could touch. Snapshots stay append-only; a
 * dry-run writes a new row through the eligibility repo's insert.
 */

export interface DryRunTarget {
  assetId: Uuid;
  mint: MintAddress;
  decimals: number;
  held: boolean;
  /** Most recent dry-run time across the asset's snapshots, to schedule the oldest first. */
  lastDryRunAt: Instant | null;
}

export async function dryRunTargets(sql: Sql, accountId: Uuid, limit: number): Promise<DryRunTarget[]> {
  const rows = await sql<{ asset_id: string; mint: string; decimals: number; held: boolean; last_dry_run_at: string | null }[]>`
    with held as (
      select distinct p.asset_id from trading.positions p where p.account_id = ${accountId} and p.status <> 'CLOSED'
    ), eligible as (
      select a.id as asset_id from core.assets a
      join lateral (select eligible from core.asset_eligibility y where y.asset_id = a.id order by evaluated_at desc limit 1) e on true
      where e.eligible and a.status <> 'RETIRED'
    ), targets as (
      select asset_id, true as held from held
      union
      select asset_id, false as held from eligible where asset_id not in (select asset_id from held)
    )
    select t.asset_id, a.mint_address as mint, a.decimals, t.held,
      (select max((s.last_dry_run ->> 'at')::timestamptz) from core.emergency_exit_route_snapshots s where s.asset_id = t.asset_id) as last_dry_run_at
    from targets t join core.assets a on a.id = t.asset_id
    order by t.held desc, last_dry_run_at asc nulls first, t.asset_id
    limit ${limit}`;
  return rows.map((r) => ({ assetId: r.asset_id as Uuid, mint: r.mint as MintAddress, decimals: Number(r.decimals), held: r.held, lastDryRunAt: r.last_dry_run_at ? (new Date(r.last_dry_run_at).toISOString() as Instant) : null }));
}

export async function latestEmergencySnapshots(sql: Sql, assetIds: readonly Uuid[]): Promise<Map<Uuid, EmergencyExitRouteSnapshot>> {
  const out = new Map<Uuid, EmergencyExitRouteSnapshot>();
  if (assetIds.length === 0) return out;
  const rows = await sql<Record<string, unknown>[]>`
    select distinct on (asset_id) * from core.emergency_exit_route_snapshots where asset_id in ${sql([...assetIds])} order by asset_id, last_refreshed_at desc`;
  for (const r of rows) {
    out.set(r['asset_id'] as Uuid, {
      id: r['id'] as Uuid,
      assetId: r['asset_id'] as Uuid,
      hops: r['hops'] as EmergencyExitRouteSnapshot['hops'],
      settlementMint: r['settlement_mint'] as MintAddress,
      poolStateRef: r['pool_state_ref'] as string,
      lastRefreshedAt: new Date(r['last_refreshed_at'] as string).toISOString() as Instant,
      lastRefreshSlot: Number(r['last_refresh_slot']) as EmergencyExitRouteSnapshot['lastRefreshSlot'],
      capacity: r['capacity'] as EmergencyExitRouteSnapshot['capacity'],
      token2022Compatible: r['token2022_compatible'] as boolean,
      lastDryRun: (r['last_dry_run'] as EmergencyExitRouteSnapshot['lastDryRun']) ?? null,
    });
  }
  return out;
}
