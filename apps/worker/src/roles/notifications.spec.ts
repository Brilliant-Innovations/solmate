import { addMs, DEFAULT_NOTIFICATION_POLICY, DEFAULT_WALLET_RESERVE_POLICY, fixedClock, fixtures, type Amount, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import type { DeliveryRow, OpenNotificationRow, PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import type { AlertFacts } from '@sol-agent-trader/risk';
import { inAppSender, telegramSender, unconfiguredSender, type NotificationSender } from '../notifications/channels.js';
import { runNotificationsCycle, type NotificationsDeps, type NotificationsRepo } from './notifications.js';

const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const policy = DEFAULT_NOTIFICATION_POLICY;
const quiet = (): AlertFacts & { sessionActive: boolean } => ({
  reconciliation: { status: 'CLEAN', evaluatedAt: addMs(T0, -30_000) },
  chainHealth: null,
  projection: { gasReserveLamports: '200000000' as Amount, settlementAvailableBaseUnits: '50000000' as Amount },
  presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -10_000) },
  openPositions: 1,
  blockingFeeds: [],
  executor: null,
  sessionActive: true,
});

class MemoryRepo implements NotificationsRepo {
  rows: OpenNotificationRow[] = [];
  resolvedIds: Uuid[] = [];
  deliveryRows: DeliveryRow[] = [];
  paused: { notificationId: Uuid; alertClass: string }[] = [];
  heartbeatAt: Instant | null = null;
  constructor(public factsValue: AlertFacts & { sessionActive: boolean }) {}
  async facts() { return this.factsValue; }
  async listOpen() { return this.rows.filter((r) => !this.resolvedIds.includes(r.id)).map((r) => ({ ...r })); }
  async raise(n: Parameters<NotificationsRepo['raise']>[0]) {
    if (n.alertClass === 'SYSTEM_ALIVE') this.heartbeatAt = n.raisedAt;
    if (n.resolvedAt) return;
    this.rows.push({ id: n.id, alertClass: n.alertClass, severity: n.severity, summary: n.summary, affected: n.affected, raisedAt: n.raisedAt, acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null });
  }
  async resolve(alertClass: string) { const ids = this.rows.filter((r) => r.alertClass === alertClass && !this.resolvedIds.includes(r.id)).map((r) => r.id); this.resolvedIds.push(...ids); return ids; }
  async deliveries(ids: readonly Uuid[]) { return this.deliveryRows.filter((d) => ids.includes(d.notificationId)); }
  async recordDelivery(d: DeliveryRow) { this.deliveryRows.push(d); }
  async escalate(id: Uuid, level: number) { const r = this.rows.find((x) => x.id === id)!; r.escalationLevel = level; r.lastEscalatedAt = null; }
  async applyDeadManPause(input: { notificationId: Uuid; alertClass: string }) { this.paused.push({ notificationId: input.notificationId, alertClass: input.alertClass }); const r = this.rows.find((x) => x.id === input.notificationId)!; r.deadManActionTaken = 'PAUSE_NEW_ENTRIES'; return { pausedSessions: ['s1' as Uuid] }; }
  async lastHeartbeatAt() { return this.heartbeatAt; }
  pending: PendingControlRequest[] = [];
  role: 'operator' | 'admin' | 'viewer' | null = 'operator';
  resolutions: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  async listPending() { return this.pending; }
  async operatorRole() { return this.role; }
  async acknowledge(id: Uuid, by: Uuid, at: Instant) { const r = this.rows.find((x) => x.id === id && x.acknowledgedAt === null && !this.resolvedIds.includes(x.id)); if (!r) return false; r.acknowledgedAt = at; void by; return true; }
  async resolveRequest(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>) { this.resolutions.push({ id, state, resolution }); return true; }
}
let n = 0;
const deps = (repo: MemoryRepo, over: Partial<NotificationsDeps> = {}): NotificationsDeps => ({ repo, senders: [inAppSender, unconfiguredSender('TELEGRAM'), unconfiguredSender('EMAIL')], policy, reservePolicy: DEFAULT_WALLET_RESERVE_POLICY, presenceTimeoutMs: 180_000, clock: fixedClock(T0), logger, newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-0000000000ee` as Uuid, ...over });
const okSender = (channel: NotificationSender['channel']): NotificationSender & { sent: string[] } => { const s = { channel, configured: true, sent: [] as string[], async send(x: { id: string }) { s.sent.push(x.id); return { ok: true as const }; } }; return s; };

describe('worker notifications role (§20.20, D35, D42)', () => {
  it('raises what the facts warrant, delivers on the severity channels recording every attempt, and resolves an owned alert when its condition clears', async () => {
    const repo = new MemoryRepo({ ...quiet(), reconciliation: { status: 'MISMATCH', evaluatedAt: T0, reasons: ['UNKNOWN_MOVEMENT'] }, blockingFeeds: ['BIRDEYE:CANDLES'] });
    const r1 = await runNotificationsCycle(deps(repo));
    expect(r1.raised).toEqual(['CUSTODY_RECONCILIATION_MISMATCH', 'PROVIDER_FEED_BLOCKING']);
    expect(r1.heartbeat).toBe(true);
    // CRITICAL → IN_APP + TELEGRAM + EMAIL (two unconfigured), NOTICE → IN_APP, heartbeat INFO → IN_APP
    expect(r1.deliveries).toEqual({ attempted: 5, confirmed: 3, failed: 2 });
    expect(r1.criticalUnderDelivered).toEqual(['CUSTODY_RECONCILIATION_MISMATCH']);
    expect(repo.deliveryRows.filter((d) => d.error === 'CHANNEL_NOT_CONFIGURED').map((d) => d.channel).sort()).toEqual(['EMAIL', 'TELEGRAM']);
    // second cycle, nothing changed: no new raise, no re-delivery of confirmed channels, failed ones retried, heartbeat not due
    const r2 = await runNotificationsCycle(deps(repo));
    expect(r2.raised).toEqual([]);
    expect(r2.heartbeat).toBe(false);
    expect(r2.deliveries).toEqual({ attempted: 2, confirmed: 0, failed: 2 });
    // condition clears: the owned alert resolves
    repo.factsValue = quiet();
    const r3 = await runNotificationsCycle(deps(repo));
    expect(r3.resolved.sort()).toEqual(['CUSTODY_RECONCILIATION_MISMATCH', 'PROVIDER_FEED_BLOCKING']);
    expect(await repo.listOpen()).toEqual([]);
  });

  it('escalates an unacknowledged CRITICAL after the interval and re-delivers at the new level; a configured second channel satisfies the CRITICAL rule', async () => {
    const repo = new MemoryRepo(quiet());
    repo.rows.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001' as Uuid, alertClass: 'UNABLE_TO_EXIT', severity: 'CRITICAL', summary: 'cannot exit', affected: {}, raisedAt: addMs(T0, -policy.escalationIntervalMs), acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null });
    const tg = okSender('TELEGRAM');
    const d = deps(repo, { senders: [inAppSender, tg, unconfiguredSender('EMAIL')] });
    const r = await runNotificationsCycle(d);
    expect(r.escalated).toEqual(['UNABLE_TO_EXIT']);
    expect(repo.rows[0]?.escalationLevel).toBe(1);
    expect(repo.deliveryRows.filter((x) => x.notificationId === repo.rows[0]!.id && x.escalationLevel === 1).map((x) => x.channel)).toEqual(['IN_APP', 'TELEGRAM', 'EMAIL']);
    expect(r.criticalUnderDelivered).toEqual([]);
    expect(tg.sent).toEqual([repo.rows[0]!.id]); // the CRITICAL alert only: the heartbeat is INFO and stays in-app
  });

  it('the dead-man rule pauses new entries once for a listed unacknowledged class, raises DEAD_MAN_PAUSE_APPLIED, and never fires for an acknowledged or unlisted alert', async () => {
    const repo = new MemoryRepo(quiet());
    repo.rows.push(
      { id: 'aaaaaaaa-0000-4000-8000-000000000002' as Uuid, alertClass: 'UNABLE_TO_EXIT', severity: 'CRITICAL', summary: 'cannot exit', affected: {}, raisedAt: addMs(T0, -policy.deadManIntervalMs), acknowledgedAt: null, escalationLevel: 1, lastEscalatedAt: addMs(T0, -1_000), deadManActionTaken: null },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003' as Uuid, alertClass: 'CHAIN_ENTRIES_BLOCKED', severity: 'HIGH', summary: 'halt', affected: {}, raisedAt: addMs(T0, -policy.deadManIntervalMs), acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null },
      { id: 'aaaaaaaa-0000-4000-8000-000000000004' as Uuid, alertClass: 'EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS', severity: 'CRITICAL', summary: 'exec down', affected: {}, raisedAt: addMs(T0, -policy.deadManIntervalMs), acknowledgedAt: addMs(T0, -60_000), escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null },
    );
    const r = await runNotificationsCycle(deps(repo));
    expect(r.deadManPaused).toEqual([{ alertClass: 'UNABLE_TO_EXIT', sessions: 1 }]);
    expect(repo.paused).toEqual([{ notificationId: 'aaaaaaaa-0000-4000-8000-000000000002', alertClass: 'UNABLE_TO_EXIT' }]);
    expect(repo.rows.map((x) => x.alertClass)).toContain('DEAD_MAN_PAUSE_APPLIED');
    const again = await runNotificationsCycle(deps(repo));
    expect(again.deadManPaused).toEqual([]);
  });

  it('SYSTEM_ALIVE is delivered on the heartbeat interval while a session is active and stays silent when intentionally OFF with nothing open', async () => {
    const repo = new MemoryRepo({ ...quiet(), openPositions: 0, sessionActive: false });
    expect((await runNotificationsCycle(deps(repo))).heartbeat).toBe(false);
    repo.factsValue = { ...quiet(), openPositions: 0, sessionActive: true };
    expect((await runNotificationsCycle(deps(repo))).heartbeat).toBe(true);
    expect((await runNotificationsCycle(deps(repo, { clock: fixedClock(addMs(T0, 60_000)) }))).heartbeat).toBe(false);
    expect((await runNotificationsCycle(deps(repo, { clock: fixedClock(addMs(T0, policy.heartbeatIntervalMs)) }))).heartbeat).toBe(true);
  });

  it('the Telegram sender posts one message and reports HTTP or API failure as a delivery error', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => ({ ok: true }) }; }) as unknown as typeof fetch;
    const s = telegramSender({ botToken: 'token', chatId: '42', fetchImpl });
    expect(await s.send({ id: 'n', severity: 'CRITICAL', alertClass: 'UNABLE_TO_EXIT', summary: 'cannot exit', escalationLevel: 2, raisedAt: T0 })).toEqual({ ok: true });
    expect(calls[0]?.url).toContain('/bottoken/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: '42', text: expect.stringContaining('[CRITICAL] UNABLE_TO_EXIT (escalation 2)') });
    const failing = telegramSender({ botToken: 't', chatId: '1', fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch });
    expect(await failing.send({ id: 'n', severity: 'HIGH', alertClass: 'CHAIN_ENTRIES_BLOCKED', summary: 's', escalationLevel: 0, raisedAt: T0 })).toEqual({ ok: false, error: 'telegram 429' });
    const apiNo = telegramSender({ botToken: 't', chatId: '1', fetchImpl: (async () => ({ ok: true, json: async () => ({ ok: false, description: 'chat not found' }) })) as unknown as typeof fetch });
    expect(await apiNo.send({ id: 'n', severity: 'HIGH', alertClass: 'CHAIN_ENTRIES_BLOCKED', summary: 's', escalationLevel: 0, raisedAt: T0 })).toEqual({ ok: false, error: 'telegram: chat not found' });
  });
});

describe('acknowledgement through the alert center', () => {
  it('an operator acknowledges an open alert once (who and when recorded), a viewer or a bad id is refused, and an acknowledged CRITICAL no longer escalates', async () => {
    const repo = new MemoryRepo(quiet());
    const id = 'aaaaaaaa-0000-4000-8000-000000000009' as Uuid;
    repo.rows.push({ id, alertClass: 'UNABLE_TO_EXIT', severity: 'CRITICAL', summary: 'cannot exit', affected: {}, raisedAt: addMs(T0, -policy.escalationIntervalMs), acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null });
    repo.pending = [
      { id: 'bbbbbbbb-0000-4000-8000-000000000001' as Uuid, requestedBy: fixtures.IDS.operator as Uuid, kind: 'ACKNOWLEDGE_ALERT', payload: { notificationId: id }, createdAt: T0 },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002' as Uuid, requestedBy: fixtures.IDS.operator as Uuid, kind: 'ACKNOWLEDGE_ALERT', payload: {}, createdAt: T0 },
    ];
    const r = await runNotificationsCycle(deps(repo));
    expect(r.acknowledged).toBe(1);
    expect(r.escalated).toEqual([]); // acknowledged before the escalation check
    expect(repo.resolutions.map((x) => [x.state, x.resolution['reason'] ?? 'ok'])).toEqual([['ACCEPTED', 'ok'], ['REJECTED', 'MALFORMED_PAYLOAD']]);
    expect(repo.rows[0]?.acknowledgedAt).toBe(T0);
    repo.pending = [{ id: 'bbbbbbbb-0000-4000-8000-000000000003' as Uuid, requestedBy: fixtures.IDS.operator as Uuid, kind: 'ACKNOWLEDGE_ALERT', payload: { notificationId: id }, createdAt: T0 }];
    const again = await runNotificationsCycle(deps(repo));
    expect(again.acknowledged).toBe(0);
    expect(repo.resolutions.at(-1)).toMatchObject({ state: 'REJECTED', resolution: { reason: 'NOT_OPEN_OR_ALREADY_ACKNOWLEDGED' } });
    repo.role = 'viewer';
    repo.pending = [{ id: 'bbbbbbbb-0000-4000-8000-000000000004' as Uuid, requestedBy: fixtures.IDS.operator as Uuid, kind: 'ACKNOWLEDGE_ALERT', payload: { notificationId: id }, createdAt: T0 }];
    await runNotificationsCycle(deps(repo));
    expect(repo.resolutions.at(-1)).toMatchObject({ state: 'REJECTED', resolution: { reason: 'NOT_AN_OPERATOR' } });
  });
});
