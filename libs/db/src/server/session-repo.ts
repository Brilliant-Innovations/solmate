import type { ActivityState, ActorKind, CapitalAuthority, ColdStartGate, ControlRequestKind, DeploymentProfile, Instant, Uuid } from '@sol-agent-trader/contracts';
import { writeAuditEvent } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Runtime-session reads and the operator control-request queue (blueprint §6.22A, §20.23, §23.3,
 * D60–D63). The machine in libs/risk decides; this module only loads facts, records gate results
 * and heartbeats, and resolves control requests with their audit rows. Reconciliation's pause is
 * written by `trading.record_reconciliation()` directly into the same `paused` column, so the
 * session row is the one source of truth the worker reads back every tick.
 */

export interface SessionRow {
  id: Uuid;
  accountId: Uuid | null;
  profile: DeploymentProfile;
  activityState: ActivityState;
  capitalAuthority: CapitalAuthority;
  paused: { active: boolean; reason: string | null; since: Instant | null; by: ActorKind | null };
  attended: boolean;
  lastPresenceHeartbeatAt: Instant | null;
  coldStartGates: ColdStartGate[];
  exposureAtLastTransition: { managedCount: number; offlineProtectedCount: number; unmanagedCount: number; unmanagedUsd: number | null };
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r['id'] as Uuid,
    accountId: (r['account_id'] as Uuid | null) ?? null,
    profile: r['profile'] as DeploymentProfile,
    activityState: r['activity_state'] as ActivityState,
    capitalAuthority: r['capital_authority'] as CapitalAuthority,
    paused: r['paused'] as SessionRow['paused'],
    attended: r['attended'] as boolean,
    lastPresenceHeartbeatAt: r['last_presence_heartbeat_at'] ? (new Date(r['last_presence_heartbeat_at'] as string).toISOString() as Instant) : null,
    coldStartGates: (r['cold_start_gates'] as ColdStartGate[]) ?? [],
    exposureAtLastTransition: r['exposure_at_last_transition'] as SessionRow['exposureAtLastTransition'],
  };
}

/** The newest session for the account that is not OFF; null when none is running. */
export async function findOpenSession(sql: Sql, accountId: Uuid): Promise<SessionRow | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from ops.runtime_sessions where account_id = ${accountId} and activity_state <> 'OFF' order by created_at desc limit 1`;
  return r ? rowToSession(r) : null;
}

export async function loadSession(sql: Sql, id: Uuid): Promise<SessionRow | null> {
  const [r] = await sql<Record<string, unknown>[]>`select * from ops.runtime_sessions where id = ${id}`;
  return r ? rowToSession(r) : null;
}

export async function saveColdStartGates(sql: Sql, id: Uuid, gates: ColdStartGate[]): Promise<void> {
  await sql`update ops.runtime_sessions set cold_start_gates = ${sql.json(asJson(gates))} where id = ${id}`;
}

/** Operator presence heartbeat (attended profiles); written by operator tooling or the web app, read by the session role. */
export async function recordPresence(sql: Sql, id: Uuid, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`update ops.runtime_sessions set last_presence_heartbeat_at = ${at} where id = ${id} and activity_state <> 'OFF' returning id`;
  return rows.length > 0;
}

export interface ColdStartFactRows {
  reconciliations: { accountId: string; status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE' }[];
  blockingFeeds: string[];
  universeRefreshedAt: Instant | null;
  eligibleAssets: number;
  trackedAssets: number;
  warmAssets: number;
  openPositions: number;
  positionsWithStaleSafety: number;
}

/** Stored facts the cold-start gates read (D63); no provider is called here. */
export async function coldStartFacts(sql: Sql, now: Instant, opts: { requiredFeatures: string[]; featureWindowMs: number; safetyMaxAgeMs: number }): Promise<ColdStartFactRows> {
  const featureSince = new Date(Date.parse(now) - opts.featureWindowMs).toISOString();
  const safetySince = new Date(Date.parse(now) - opts.safetyMaxAgeMs).toISOString();
  const recon = await sql<{ account_id: string; status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE' }[]>`
    select distinct on (r.account_id) r.account_id, r.status from trading.custody_reconciliations r join trading.accounts a on a.id = r.account_id
    where a.mode = 'LIVE' order by r.account_id, r.evaluated_at desc`;
  const feeds = await sql<{ provider: string }[]>`select provider from ops.provider_health where effect_on_entries = 'BLOCK' order by provider`;
  const [universe] = await sql<{ refreshed: string | null; eligible: number }[]>`
    select (select max(evaluated_at) from core.asset_eligibility) as refreshed, (select count(*)::int from core.assets where status = 'ELIGIBLE') as eligible`;
  const [warm] = await sql<{ tracked: number; warm: number }[]>`
    with latest as (
      select distinct on (asset_id) asset_id, features from signals.feature_snapshots where as_of >= ${featureSince} order by asset_id, as_of desc
    )
    select count(*)::int as tracked,
      count(*) filter (where (select bool_and(jsonb_typeof(features -> f) = 'number') from unnest(${opts.requiredFeatures}::text[]) f))::int as warm
    from latest`;
  const [safety] = await sql<{ open: number; stale: number }[]>`
    select count(*)::int as open,
      count(*) filter (where not exists (select 1 from trading.position_safety_evaluations e where e.position_id = p.id and e.evaluated_at >= ${safetySince}))::int as stale
    from trading.positions p where p.status <> 'CLOSED' and p.quantity <> 0`;
  return {
    reconciliations: recon.map((r) => ({ accountId: r.account_id, status: r.status })),
    blockingFeeds: feeds.map((f) => f.provider),
    universeRefreshedAt: universe?.refreshed ? (new Date(universe.refreshed).toISOString() as Instant) : null,
    eligibleAssets: universe?.eligible ?? 0,
    trackedAssets: warm?.tracked ?? 0,
    warmAssets: warm?.warm ?? 0,
    openPositions: safety?.open ?? 0,
    positionsWithStaleSafety: safety?.stale ?? 0,
  };
}

/** What blocks OFF (D61): open lots and executions still in flight for the account. */
export async function windDownFacts(sql: Sql, accountId: Uuid): Promise<{ openLots: number; inFlightExecutions: number }> {
  const [lots] = await sql<{ n: number }[]>`select count(*)::int as n from trading.position_lots l join trading.positions p on p.id = l.position_id where p.account_id = ${accountId} and l.status = 'OPEN' and l.quantity <> 0`;
  const [inflight] = await sql<{ n: number }[]>`
    select (select count(*) from trading.intents i where i.account_id = ${accountId} and i.lifecycle_state = 'EXECUTING')::int
      + (select count(*) from trading.order_attempts oa join trading.intents i on i.id = oa.intent_id where i.account_id = ${accountId} and oa.state in ('SIGNED_NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED_PROVISIONAL', 'REORG_PENDING'))::int as n`;
  return { openLots: lots?.n ?? 0, inFlightExecutions: inflight?.n ?? 0 };
}

export interface PendingControlRequest {
  id: Uuid;
  requestedBy: Uuid;
  kind: ControlRequestKind;
  payload: Record<string, unknown>;
  createdAt: Instant;
}

export async function listPendingControlRequests(sql: Sql, kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]> {
  const rows = await sql<{ id: string; requested_by: string; kind: ControlRequestKind; payload: Record<string, unknown>; created_at: string }[]>`
    select id, requested_by, kind, payload, created_at from ops.control_requests where state = 'PENDING' and kind = any(${kinds}::enums.control_request_kind[]) order by created_at asc limit ${limit}`;
  return rows.map((r) => ({ id: r.id as Uuid, requestedBy: r.requested_by as Uuid, kind: r.kind, payload: r.payload, createdAt: new Date(r.created_at).toISOString() as Instant }));
}

/** A step-up assertion verified for exactly this request and still inside its validity window. */
export async function stepUpVerifiedFor(sql: Sql, requestId: Uuid, now: Instant): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ops.step_up_assertions where control_request_id = ${requestId} and verified and expires_at > ${now}`;
  return (r?.n ?? 0) > 0;
}

/** Resolves the request and audits the decision in one transaction; a request is resolved once. */
export async function resolveControlRequest(sql: Sql, id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const rows = await t<{ id: string; kind: string }[]>`
      update ops.control_requests set state = ${state}, resolution = ${t.json(asJson(resolution))}, resolved_at = ${at} where id = ${id} and state = 'PENDING' returning id, kind`;
    if (rows.length === 0) return false;
    await writeAuditEvent(t, { actor: 'WORKER', actorRef: 'session', actionClass: 'CONTROL_REQUEST_RESOLVED', entity: { type: 'control_request', id }, beforeSummary: { state: 'PENDING', kind: rows[0]!.kind }, afterSummary: { state, ...resolution } });
    return true;
  });
}

/** The entry gate the paper roles read: the open session's activity, pause and authority, or null when no session runs. */
export async function sessionEntryGate(sql: Sql, accountId: Uuid): Promise<{ activity: ActivityState; paused: boolean; authority: CapitalAuthority; attended: boolean } | null> {
  const s = await findOpenSession(sql, accountId);
  return s ? { activity: s.activityState, paused: s.paused.active, authority: s.capitalAuthority, attended: s.attended } : null;
}
