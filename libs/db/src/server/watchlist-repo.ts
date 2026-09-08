import type { Instant, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Watchlist and research-refresh storage (§20.4, §20.27). Written only by the worker's watchlist
 * role after it validated the operator's control request; the browser reads under RLS. Watching
 * an asset changes attention, never eligibility or execution permission.
 */

export interface WatchRow {
  id: Uuid;
  assetId: Uuid;
  reason: string;
  note: string | null;
  alertRules: Record<string, unknown>;
  addedBy: Uuid;
  addedAt: Instant;
}

export async function assetIdByMint(sql: Sql, mint: string): Promise<Uuid | null> {
  const [r] = await sql<{ id: string }[]>`select id from core.assets where mint_address = ${mint}`;
  return r ? (r.id as Uuid) : null;
}

export async function assetExists(sql: Sql, id: Uuid): Promise<boolean> {
  const [r] = await sql<{ id: string }[]>`select id from core.assets where id = ${id}`;
  return !!r;
}

/** Adds an active watch; a second active watch on the same asset reports ALREADY_WATCHED. */
export async function addWatch(sql: Sql, w: { assetId: Uuid; reason: string; note: string | null; alertRules: Record<string, unknown>; addedBy: Uuid; at: Instant }): Promise<{ ok: true; id: Uuid } | { ok: false; reason: 'ALREADY_WATCHED' }> {
  try {
    const [r] = await sql<{ id: string }[]>`
      insert into intelligence.watchlist (asset_id, reason, note, alert_rules, added_by, added_at)
      values (${w.assetId}, ${w.reason}, ${w.note}, ${sql.json(asJson(w.alertRules))}, ${w.addedBy}, ${w.at})
      returning id`;
    return { ok: true, id: r!.id as Uuid };
  } catch (err) {
    if (err instanceof Error && /23505|duplicate key/.test(err.message)) return { ok: false, reason: 'ALREADY_WATCHED' };
    throw err;
  }
}

/** Dated removal by the requesting operator; false when the watch is unknown or already removed. */
export async function removeWatch(sql: Sql, id: Uuid, by: Uuid, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`update intelligence.watchlist set removed_by = ${by}, removed_at = ${at} where id = ${id} and removed_at is null returning id`;
  return rows.length > 0;
}

/** Marks the asset due for eligibility re-evaluation on the next cycle; the evaluation itself is unchanged and cannot be bypassed. */
export async function requestResearchRefresh(sql: Sql, assetId: Uuid, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`update core.assets set research_refresh_requested_at = ${at} where id = ${assetId} and status <> 'RETIRED' returning id`;
  return rows.length > 0;
}
