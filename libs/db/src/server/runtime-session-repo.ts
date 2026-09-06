import type { ActivityState, ActorKind, CapitalAuthority, DeploymentProfile, Instant } from '@sol-agent-trader/contracts';
import { writeAuditEvent, type AuditEventRow } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Persistence for ops.runtime_sessions transitions (blueprint §6.22A, D60). The pure machine in
 * libs/risk decides whether a transition is valid; this repository records the decided result and
 * its audit row in one transaction, so a mode change can never be persisted without being audited
 * (P0 acceptance "mode changes audited"). It performs no policy of its own.
 */

export interface RuntimeSessionCreate {
  accountId: string | null;
  profile: DeploymentProfile;
  attended: boolean;
  capitalAuthority?: CapitalAuthority;
}

export interface PersistedTransition {
  sessionId: string;
  from: ActivityState;
  to: ActivityState;
  at: Instant;
  actor: ActorKind;
  actorRef: string;
  reason: string | null;
  /** Full post-transition values the machine produced. */
  after: {
    activityState: ActivityState;
    capitalAuthority: CapitalAuthority;
    paused: { active: boolean; reason: string | null; since: Instant | null; by: ActorKind | null };
    exposureAtLastTransition: { managedCount: number; offlineProtectedCount: number; unmanagedCount: number; unmanagedUsd: number | null };
  };
  authorityEvidence?: string | null;
}

export async function createRuntimeSession(sql: Sql, s: RuntimeSessionCreate): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into ops.runtime_sessions (account_id, profile, attended, capital_authority)
    values (${s.accountId}, ${s.profile}, ${s.attended}, ${s.capitalAuthority ?? 'OBSERVE'})
    returning id`;
  if (!row) throw new Error('runtime session insert returned no row');
  return row.id;
}

/** Applies an already-validated transition and its audit row atomically. */
export async function persistRuntimeTransition(sql: Sql, t: PersistedTransition): Promise<AuditEventRow> {
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    const transition = { from: t.from, to: t.to, at: t.at, actor: t.actor, actorRef: t.actorRef, reason: t.reason };
    const updated = await txSql<{ id: string }[]>`
      update ops.runtime_sessions
      set activity_state = ${t.after.activityState},
          capital_authority = ${t.after.capitalAuthority},
          paused = ${txSql.json(asJson(t.after.paused))},
          exposure_at_last_transition = ${txSql.json(asJson(t.after.exposureAtLastTransition))},
          transitions = transitions || ${txSql.json(asJson(transition))}::jsonb,
          actual_start_at = case when ${t.to} = 'STARTING' and actual_start_at is null then ${t.at}::timestamptz else actual_start_at end,
          actual_end_at = case when ${t.to} = 'OFF' then ${t.at}::timestamptz else actual_end_at end
      where id = ${t.sessionId}
      returning id`;
    if (updated.length === 0) throw new Error(`runtime session ${t.sessionId} not found`);
    return writeAuditEvent(txSql, {
      actor: t.actor,
      actorRef: t.actorRef,
      actionClass: 'RUNTIME_TRANSITION',
      entity: { type: 'runtime_session', id: t.sessionId },
      beforeSummary: { activityState: t.from },
      afterSummary: { activityState: t.to, capitalAuthority: t.after.capitalAuthority, paused: t.after.paused.active },
      authorityEvidence: t.authorityEvidence ?? null,
      liveImpacting: t.after.capitalAuthority === 'LIVE_APPROVAL' || t.after.capitalAuthority === 'LIVE_AUTO',
    });
  });
}
