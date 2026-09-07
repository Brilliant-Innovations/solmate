import type { Amount, EmergencyExitRouteSnapshot, HeldAssetSafety, Instant, MintAddress, PositionSafetyState, SafetyBaseline, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Held-asset safety persistence (blueprint §7.5, D34). Evaluations are append-only; the position's
 * safety_state pointer moves in the same transaction through trading.record_position_safety().
 */

export interface OpenPosition {
  id: Uuid;
  assetId: Uuid;
  mint: MintAddress;
  quantity: Amount;
  safetyState: PositionSafetyState;
}

export async function listOpenPositions(sql: Sql, limit: number): Promise<OpenPosition[]> {
  const rows = await sql<{ id: string; asset_id: string; mint: string; quantity: string; safety_state: PositionSafetyState }[]>`
    select id, asset_id, mint, quantity, safety_state from trading.positions
    where status <> 'CLOSED' and quantity <> '0'
    order by opened_at asc limit ${limit}`;
  return rows.map((r) => ({ id: r.id as Uuid, assetId: r.asset_id as Uuid, mint: r.mint as MintAddress, quantity: r.quantity as Amount, safetyState: r.safety_state }));
}

export async function recordPositionSafety(sql: Sql, evaluation: HeldAssetSafety): Promise<void> {
  await sql`select trading.record_position_safety(${sql.json(asJson(evaluation))})`;
}

/** Baseline for the next evaluation: the previous evaluation's observed facts. */
export async function previousSafetyBaseline(sql: Sql, positionId: Uuid): Promise<{ baseline: SafetyBaseline; state: PositionSafetyState; evaluatedAt: Instant } | null> {
  const [r] = await sql<{ observed: Omit<SafetyBaseline, 'source'>; state: PositionSafetyState; evaluated_at: string }[]>`
    select observed, state, evaluated_at from trading.position_safety_evaluations where position_id = ${positionId} order by evaluated_at desc limit 1`;
  if (!r) return null;
  return { baseline: { source: 'PREVIOUS_SAFETY', ...r.observed }, state: r.state, evaluatedAt: new Date(r.evaluated_at).toISOString() as Instant };
}

export async function latestEmergencySnapshot(sql: Sql, assetId: Uuid): Promise<EmergencyExitRouteSnapshot | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from core.emergency_exit_route_snapshots where asset_id = ${assetId} order by last_refreshed_at desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    assetId: r['asset_id'] as Uuid,
    hops: r['hops'] as EmergencyExitRouteSnapshot['hops'],
    settlementMint: r['settlement_mint'] as MintAddress,
    poolStateRef: r['pool_state_ref'] as string,
    lastRefreshedAt: new Date(r['last_refreshed_at'] as string).toISOString() as Instant,
    lastRefreshSlot: Number(r['last_refresh_slot']) as EmergencyExitRouteSnapshot['lastRefreshSlot'],
    capacity: r['capacity'] as EmergencyExitRouteSnapshot['capacity'],
    token2022Compatible: r['token2022_compatible'] as boolean,
    lastDryRun: r['last_dry_run'] as EmergencyExitRouteSnapshot['lastDryRun'],
  };
}
