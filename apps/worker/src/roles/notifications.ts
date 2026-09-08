import { randomUUID } from 'node:crypto';
import { addMs, type Clock, type Instant, type NotificationChannel, type NotificationPolicy, type Uuid, type WalletReservePolicy } from '@sol-agent-trader/contracts';
import type { DeliveryRow, OpenNotificationRow } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { deadManDue, deriveAlerts, escalationDue, heartbeatDue, type AlertFacts, type DesiredAlert } from '@sol-agent-trader/risk';
import type { NotificationSender, OutboundNotification } from '../notifications/channels.js';

/**
 * Worker role `notifications` (blueprint §20.20, D35, D42; execution plan M8a). Every cycle:
 * derive the alerts the facts warrant, raise what is new and resolve what cleared; deliver every
 * open alert on the channels its severity maps to, recording each attempt; escalate unacknowledged
 * CRITICAL alerts on the policy schedule; apply the dead-man `PAUSE_NEW_ENTRIES` (never a close)
 * when a listed class stays unacknowledged; and deliver `SYSTEM_ALIVE` while a session is active
 * so silence is observable. Alerts raised elsewhere (the reconciliation SQL, passkey registration)
 * are delivered and escalated here too.
 */

export interface NotificationsRepo {
  facts(): Promise<AlertFacts & { sessionActive: boolean }>;
  listOpen(): Promise<OpenNotificationRow[]>;
  raise(n: { id: Uuid; severity: DesiredAlert['severity']; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant; deadManDeadline: Instant | null; resolvedAt?: Instant | null }): Promise<void>;
  resolve(alertClass: string, at: Instant): Promise<Uuid[]>;
  deliveries(ids: readonly Uuid[]): Promise<DeliveryRow[]>;
  recordDelivery(d: DeliveryRow): Promise<void>;
  escalate(id: Uuid, level: number): Promise<void>;
  applyDeadManPause(input: { notificationId: Uuid; alertClass: string; at: Instant; actorRef: string }): Promise<{ pausedSessions: Uuid[] }>;
  lastHeartbeatAt(): Promise<Instant | null>;
}

export interface NotificationsDeps {
  repo: NotificationsRepo;
  senders: readonly NotificationSender[];
  policy: NotificationPolicy;
  reservePolicy: WalletReservePolicy;
  presenceTimeoutMs: number;
  clock: Clock;
  logger: Logger;
  newId?: () => Uuid;
}

export interface NotificationsReport {
  raised: string[];
  resolved: string[];
  deliveries: { attempted: number; confirmed: number; failed: number };
  escalated: string[];
  deadManPaused: { alertClass: string; sessions: number }[];
  heartbeat: boolean;
  criticalUnderDelivered: string[];
}

/** Classes this role owns end to end: raised from facts and resolved when the fact clears. Others are delivered and escalated only. */
const OWNED = new Set(['CUSTODY_RECONCILIATION_MISMATCH', 'RECONCILIATION_UNAVAILABLE', 'CHAIN_ENTRIES_BLOCKED', 'RESERVE_BELOW_THRESHOLD', 'OPERATOR_ABSENT_WITH_EXPOSURE', 'PROVIDER_FEED_BLOCKING', 'EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS', 'SIGNER_UNAVAILABLE_WITH_EXPOSURE']);

export async function runNotificationsCycle(deps: NotificationsDeps): Promise<NotificationsReport> {
  const now = deps.clock.now();
  const newId = deps.newId ?? (() => randomUUID() as Uuid);
  const report: NotificationsReport = { raised: [], resolved: [], deliveries: { attempted: 0, confirmed: 0, failed: 0 }, escalated: [], deadManPaused: [], heartbeat: false, criticalUnderDelivered: [] };
  const facts = await deps.repo.facts();
  let open = await deps.repo.listOpen();

  // 1. Raise what the facts warrant and is not already open; resolve owned classes whose condition cleared.
  const desired = deriveAlerts(facts, deps.policy, deps.reservePolicy, deps.presenceTimeoutMs, now);
  const openClasses = new Set(open.map((n) => n.alertClass));
  for (const d of desired) {
    if (openClasses.has(d.alertClass)) continue;
    const deadMan = (deps.policy.deadManClasses as string[]).includes(d.alertClass);
    await deps.repo.raise({ id: newId(), severity: d.severity, alertClass: d.alertClass, summary: d.summary, affected: d.affected, automatedResponse: d.automatedResponse, raisedAt: now, deadManDeadline: deadMan ? addMs(now, deps.policy.deadManIntervalMs) : null });
    report.raised.push(d.alertClass);
    deps.logger[d.severity === 'CRITICAL' ? 'error' : d.severity === 'HIGH' ? 'warn' : 'info']('alert_raised', { alertClass: d.alertClass, severity: d.severity, summary: d.summary, automatedResponse: d.automatedResponse });
  }
  const desiredClasses = new Set<string>(desired.map((d) => d.alertClass));
  for (const cls of openClasses) {
    if (!OWNED.has(cls) || desiredClasses.has(cls)) continue;
    const ids = await deps.repo.resolve(cls, now);
    if (ids.length) {
      report.resolved.push(cls);
      deps.logger.info('alert_resolved', { alertClass: cls, count: ids.length });
    }
  }
  if (report.raised.length || report.resolved.length) open = await deps.repo.listOpen();

  // 2. Escalate unacknowledged CRITICAL alerts on schedule (a new level means a new delivery round).
  for (const n of open) {
    if (!escalationDue(n, deps.policy, now)) continue;
    await deps.repo.escalate(n.id, n.escalationLevel + 1);
    n.escalationLevel += 1;
    report.escalated.push(n.alertClass);
    deps.logger.error('alert_escalated', { notificationId: n.id, alertClass: n.alertClass, level: n.escalationLevel, raisedAt: n.raisedAt });
  }

  // 3. Dead-man rule: pause new entries when a listed CRITICAL class stays unacknowledged. Never a close.
  for (const n of open) {
    if (!deadManDue(n, deps.policy, now)) continue;
    const r = await deps.repo.applyDeadManPause({ notificationId: n.id, alertClass: n.alertClass, at: now, actorRef: 'notifications:dead-man' });
    n.deadManActionTaken = 'PAUSE_NEW_ENTRIES';
    report.deadManPaused.push({ alertClass: n.alertClass, sessions: r.pausedSessions.length });
    deps.logger.error('dead_man_pause_applied', { notificationId: n.id, alertClass: n.alertClass, pausedSessions: r.pausedSessions });
    await deps.repo.raise({ id: newId(), severity: 'HIGH', alertClass: 'DEAD_MAN_PAUSE_APPLIED', summary: `Dead-man rule: ${n.alertClass} unacknowledged for ${Math.round(deps.policy.deadManIntervalMs / 60_000)} min; PAUSE_NEW_ENTRIES applied to ${r.pausedSessions.length} session(s)`, affected: { assetId: null, strategyVersionId: null, positionId: null, system: 'notifications', sourceNotificationId: n.id }, automatedResponse: 'PAUSE_NEW_ENTRIES', raisedAt: now, deadManDeadline: null });
    open = await deps.repo.listOpen();
  }

  // 4. Heartbeat while a session is active or exposure exists. The row is resolved on insert: it is a delivery, not an open alert.
  const toDeliver: OpenNotificationRow[] = [...open];
  if (heartbeatDue({ sessionActive: facts.sessionActive, openPositions: facts.openPositions, lastHeartbeatAt: await deps.repo.lastHeartbeatAt() }, deps.policy, now)) {
    const heartbeat: OpenNotificationRow = { id: newId(), severity: 'INFO', alertClass: 'SYSTEM_ALIVE', summary: `SYSTEM_ALIVE: session ${facts.sessionActive ? 'active' : 'off'}, ${facts.openPositions} open position(s)`, affected: { system: 'heartbeat' }, raisedAt: now, acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null };
    await deps.repo.raise({ id: heartbeat.id, severity: 'INFO', alertClass: 'SYSTEM_ALIVE', summary: heartbeat.summary, affected: { assetId: null, strategyVersionId: null, positionId: null, system: 'heartbeat' }, automatedResponse: null, raisedAt: now, deadManDeadline: null, resolvedAt: now });
    report.heartbeat = true;
    toDeliver.push(heartbeat);
  }

  // 5. Deliver every open alert (and this cycle's heartbeat) on the channels its severity maps to, once per escalation level.
  const existing = await deps.repo.deliveries(toDeliver.map((n) => n.id));
  const done = new Set(existing.map((d) => `${d.notificationId}|${d.channel}|${d.escalationLevel}|${d.confirmedAt ? 'ok' : 'err'}`));
  for (const n of toDeliver) {
    const channels: NotificationChannel[] = deps.policy.channelsBySeverity[n.severity];
    let confirmed = existing.filter((d) => d.notificationId === n.id && d.confirmedAt !== null).map((d) => d.channel).filter((c, i, all) => all.indexOf(c) === i).length;
    for (const channel of channels) {
      if (done.has(`${n.id}|${channel}|${n.escalationLevel}|ok`)) continue;
      const sender = deps.senders.find((s) => s.channel === channel);
      const outbound: OutboundNotification = { id: n.id, severity: n.severity, alertClass: n.alertClass, summary: n.summary, escalationLevel: n.escalationLevel, raisedAt: n.raisedAt };
      const result = sender ? await sender.send(outbound) : { ok: false as const, error: 'CHANNEL_NOT_CONFIGURED' };
      report.deliveries.attempted++;
      if (result.ok) {
        report.deliveries.confirmed++;
        confirmed++;
      } else report.deliveries.failed++;
      await deps.repo.recordDelivery({ notificationId: n.id, channel, escalationLevel: n.escalationLevel, attemptedAt: now, confirmedAt: result.ok ? now : null, error: result.ok ? null : result.error });
      if (!result.ok && !done.has(`${n.id}|${channel}|${n.escalationLevel}|err`)) deps.logger.warn('notification_delivery_failed', { notificationId: n.id, alertClass: n.alertClass, channel, error: result.error });
    }
    if (n.severity === 'CRITICAL' && confirmed < deps.policy.criticalMinConfirmedChannels) {
      report.criticalUnderDelivered.push(n.alertClass);
      deps.logger.error('critical_alert_under_delivered', { notificationId: n.id, alertClass: n.alertClass, confirmedChannels: confirmed, required: deps.policy.criticalMinConfirmedChannels });
    }
  }
  if (report.raised.length || report.resolved.length || report.escalated.length || report.deadManPaused.length || report.deliveries.attempted) deps.logger.info('notifications_cycle', { ...report });
  return report;
}
