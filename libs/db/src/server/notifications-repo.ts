import { toInstant, type AlertSeverity, type Instant, type NotificationChannel, type Uuid } from '@sol-agent-trader/contracts';
import { writeAuditEvent } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Notifications persistence (blueprint §6.16D, §20.20, D42). Rows are the operator-visible alerts;
 * deliveries are the per-channel attempts with their confirmation or error, so "was the operator
 * told" is answerable from the database. The dead-man pause is written together with its audit row.
 */

export interface OpenNotificationRow {
  id: Uuid;
  alertClass: string;
  severity: AlertSeverity;
  summary: string;
  affected: Record<string, unknown>;
  raisedAt: Instant;
  acknowledgedAt: Instant | null;
  escalationLevel: number;
  lastEscalatedAt: Instant | null;
  deadManActionTaken: string | null;
}

const iso = (v: unknown): Instant => toInstant(new Date(v as string));

export async function listOpenNotifications(sql: Sql): Promise<OpenNotificationRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select n.*, (select max(d.attempted_at) from ops.notification_deliveries d where d.notification_id = n.id and d.escalation_level = n.escalation_level and n.escalation_level > 0) as last_escalated_at
    from ops.notifications n where n.resolved_at is null order by n.raised_at asc`;
  return rows.map((r) => ({
    id: r['id'] as Uuid,
    alertClass: r['alert_class'] as string,
    severity: r['severity'] as AlertSeverity,
    summary: r['summary'] as string,
    affected: (r['affected'] as Record<string, unknown>) ?? {},
    raisedAt: iso(r['raised_at']),
    acknowledgedAt: r['acknowledged_at'] ? iso(r['acknowledged_at']) : null,
    escalationLevel: Number(r['escalation_level'] ?? 0),
    lastEscalatedAt: r['last_escalated_at'] ? iso(r['last_escalated_at']) : null,
    deadManActionTaken: (r['dead_man_action_taken'] as string | null) ?? null,
  }));
}

export async function raiseNotification(sql: Sql, n: { id: Uuid; severity: AlertSeverity; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant; deadManDeadline: Instant | null; resolvedAt?: Instant | null }): Promise<void> {
  await sql`
    insert into ops.notifications (id, severity, alert_class, summary, affected, raised_at, automated_response, dead_man_deadline, resolved_at)
    values (${n.id}, ${n.severity}, ${n.alertClass}, ${n.summary}, ${sql.json(asJson(n.affected))}, ${n.raisedAt}, ${n.automatedResponse}, ${n.deadManDeadline}, ${n.resolvedAt ?? null})`;
}

/** Resolves every open notification of a class whose condition cleared; returns the ids resolved. */
export async function resolveNotifications(sql: Sql, alertClass: string, at: Instant): Promise<Uuid[]> {
  const rows = await sql<{ id: string }[]>`update ops.notifications set resolved_at = ${at} where alert_class = ${alertClass} and resolved_at is null returning id`;
  return rows.map((r) => r.id as Uuid);
}

export interface DeliveryRow {
  notificationId: Uuid;
  channel: NotificationChannel;
  escalationLevel: number;
  attemptedAt: Instant;
  confirmedAt: Instant | null;
  error: string | null;
}

export async function deliveriesFor(sql: Sql, notificationIds: readonly Uuid[]): Promise<DeliveryRow[]> {
  if (notificationIds.length === 0) return [];
  const rows = await sql<{ notification_id: string; channel: NotificationChannel; escalation_level: number; attempted_at: string; confirmed_at: string | null; error: string | null }[]>`
    select notification_id, channel, escalation_level, attempted_at, confirmed_at, error from ops.notification_deliveries where notification_id = any(${[...notificationIds]}::uuid[])`;
  return rows.map((r) => ({ notificationId: r.notification_id as Uuid, channel: r.channel, escalationLevel: Number(r.escalation_level), attemptedAt: iso(r.attempted_at), confirmedAt: r.confirmed_at ? iso(r.confirmed_at) : null, error: r.error }));
}

export async function recordDelivery(sql: Sql, d: DeliveryRow): Promise<void> {
  await sql`
    insert into ops.notification_deliveries (notification_id, channel, escalation_level, attempted_at, confirmed_at, error)
    values (${d.notificationId}, ${d.channel}, ${d.escalationLevel}, ${d.attemptedAt}, ${d.confirmedAt}, ${d.error})`;
}

export async function escalateNotification(sql: Sql, id: Uuid, level: number): Promise<void> {
  await sql`update ops.notifications set escalation_level = ${level} where id = ${id} and resolved_at is null`;
}

/**
 * Dead-man rule (§20.20): the runtime applies PAUSE_NEW_ENTRIES to every running session, records
 * the action on the notification and audits it, in one transaction. Never EMERGENCY_CLOSE_ALL.
 */
export async function applyDeadManPause(sql: Sql, input: { notificationId: Uuid; alertClass: string; at: Instant; actorRef: string }): Promise<{ pausedSessions: Uuid[] }> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [n] = await t<{ id: string }[]>`update ops.notifications set dead_man_action_taken = 'PAUSE_NEW_ENTRIES' where id = ${input.notificationId} and dead_man_action_taken is null and resolved_at is null returning id`;
    if (!n) return { pausedSessions: [] };
    const reason = `DEAD_MAN:${input.alertClass}`;
    const sessions = await t<{ id: string }[]>`
      update ops.runtime_sessions
        set paused = jsonb_build_object('active', true, 'reason', ${reason}, 'since', ${input.at}::timestamptz, 'by', 'WORKER')
      where activity_state <> 'OFF' and not coalesce((paused ->> 'active')::boolean, false)
      returning id`;
    for (const s of sessions) {
      await writeAuditEvent(t, { actor: 'WORKER', actorRef: input.actorRef, actionClass: 'RUNTIME_PAUSE', entity: { type: 'runtime_session', id: s.id }, beforeSummary: { paused: false }, afterSummary: { paused: true, reason, notificationId: input.notificationId }, liveImpacting: true });
    }
    return { pausedSessions: sessions.map((s) => s.id as Uuid) };
  }) as Promise<{ pausedSessions: Uuid[] }>;
}

export async function lastHeartbeatAt(sql: Sql): Promise<Instant | null> {
  const [r] = await sql<{ raised_at: string | null }[]>`select max(raised_at) as raised_at from ops.notifications where alert_class = 'SYSTEM_ALIVE'`;
  return r?.raised_at ? iso(r.raised_at) : null;
}

export async function blockingFeeds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ provider: string }[]>`select provider from ops.provider_health where effect_on_entries = 'BLOCK' order by provider`;
  return rows.map((r) => r.provider);
}

export async function activeSessionCount(sql: Sql): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ops.runtime_sessions where activity_state <> 'OFF'`;
  return r?.n ?? 0;
}

/** Operator acknowledgement (§20.20): recorded once, by whom and when; a resolved or already acknowledged alert is left alone. */
export async function acknowledgeNotification(sql: Sql, id: Uuid, by: Uuid, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`update ops.notifications set acknowledged_at = ${at}, acknowledged_by = ${by} where id = ${id} and acknowledged_at is null and resolved_at is null returning id`;
  return rows.length > 0;
}
