import { toInstant, type DeploymentProfile, type Instant, type ReadinessBinding, type ReadinessRow, type ReadinessRowId, type ReadinessStrategyClass, type ReadinessVerdict, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/** Live Readiness persistence (§29, ADR-0010 §5): append-only rows and verdict snapshots. */

export async function insertReadinessRow(sql: Sql, r: ReadinessRow): Promise<void> {
  await sql`
    insert into ops.readiness_rows (id, row_id, kind, verdict, strategy_class, profile, binding, detail, evidence_ref, recorded_by, evaluated_at, expires_at)
    values (${r.id}, ${r.rowId}, ${r.kind}, ${r.verdict}, ${r.strategyClass}, ${r.binding.profile}, ${sql.json(asJson(r.binding))}, ${sql.json(asJson(r.detail))}, ${r.evidenceRef}, ${r.recordedBy}, ${r.evaluatedAt}, ${r.expiresAt})`;
}

function rowOf(r: Record<string, unknown>): ReadinessRow {
  return {
    id: r['id'] as Uuid,
    rowId: r['row_id'] as ReadinessRowId,
    kind: r['kind'] as ReadinessRow['kind'],
    verdict: r['verdict'] as ReadinessRow['verdict'],
    strategyClass: r['strategy_class'] as ReadinessStrategyClass,
    binding: r['binding'] as ReadinessBinding,
    detail: (r['detail'] as ReadinessRow['detail']) ?? {},
    evidenceRef: (r['evidence_ref'] as string | null) ?? null,
    recordedBy: r['recorded_by'] as string,
    evaluatedAt: toInstant(new Date(r['evaluated_at'] as string)),
    expiresAt: r['expires_at'] ? toInstant(new Date(r['expires_at'] as string)) : null,
  };
}

/** The newest row per row id for a profile and strategy class: what a verdict is computed from. */
export async function latestReadinessRows(sql: Sql, profile: DeploymentProfile, strategyClass: ReadinessStrategyClass): Promise<ReadinessRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select distinct on (row_id) * from ops.readiness_rows where profile = ${profile} and strategy_class = ${strategyClass} order by row_id, evaluated_at desc`;
  return rows.map(rowOf);
}

export async function readinessRowHistory(sql: Sql, rowId: ReadinessRowId, profile: DeploymentProfile, limit = 20): Promise<ReadinessRow[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from ops.readiness_rows where row_id = ${rowId} and profile = ${profile} order by evaluated_at desc limit ${limit}`;
  return rows.map(rowOf);
}

export async function insertReadinessVerdict(sql: Sql, v: ReadinessVerdict): Promise<void> {
  await sql`
    insert into ops.readiness_verdicts (id, name, profile, strategy_class, release_id, verdict, rows, missing, stale, failed, not_applicable, enabled_capabilities, binding, policy_version, computed_at)
    values (${v.id}, ${v.name}, ${v.profile}, ${v.strategyClass}, ${v.releaseId}, ${v.verdict}, ${sql.json(asJson(v.rows))}, ${v.missing}, ${v.stale}, ${v.failed}, ${v.notApplicable}, ${v.enabledCapabilities}, ${sql.json(asJson(v.binding))}, ${v.policyVersion}, ${v.computedAt})`;
}

export async function latestReadinessVerdict(sql: Sql, name: ReadinessVerdict['name'], profile: DeploymentProfile, strategyClass: ReadinessStrategyClass): Promise<ReadinessVerdict | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from ops.readiness_verdicts where name = ${name} and profile = ${profile} and strategy_class = ${strategyClass} order by computed_at desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    name: r['name'] as ReadinessVerdict['name'],
    profile: r['profile'] as DeploymentProfile,
    strategyClass: r['strategy_class'] as ReadinessStrategyClass,
    releaseId: (r['release_id'] as Uuid | null) ?? null,
    verdict: r['verdict'] as ReadinessVerdict['verdict'],
    rows: r['rows'] as ReadinessVerdict['rows'],
    missing: r['missing'] as ReadinessRowId[],
    stale: r['stale'] as ReadinessRowId[],
    failed: r['failed'] as ReadinessRowId[],
    notApplicable: r['not_applicable'] as ReadinessRowId[],
    enabledCapabilities: r['enabled_capabilities'] as ReadinessVerdict['enabledCapabilities'],
    binding: r['binding'] as ReadinessBinding,
    policyVersion: r['policy_version'] as VersionId,
    computedAt: toInstant(new Date(r['computed_at'] as string)),
  };
}

/** Facts the worker's COMPUTED rows read; each is a plain query so the role stays testable with a fake. */
export async function latestPresence(sql: Sql, accountId: Uuid): Promise<{ attended: boolean; lastPresenceHeartbeatAt: Instant | null; activity: string } | null> {
  const [r] = await sql<{ attended: boolean; last_presence_heartbeat_at: string | null; activity_state: string }[]>`
    select attended, last_presence_heartbeat_at, activity_state from ops.runtime_sessions where account_id = ${accountId} and activity_state <> 'OFF' order by actual_start_at desc nulls last limit 1`;
  if (!r) return null;
  return { attended: r.attended, lastPresenceHeartbeatAt: r.last_presence_heartbeat_at ? toInstant(new Date(r.last_presence_heartbeat_at)) : null, activity: r.activity_state };
}
