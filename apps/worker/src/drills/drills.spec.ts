import { DEFAULT_NOTIFICATION_POLICY, fixedClock, fixtures, type Instant, type NotificationChannel, type Uuid } from '@sol-agent-trader/contracts';
import { inAppSender, unconfiguredSender, type NotificationSender } from '../notifications/channels.js';
import { alertDeliveryDrill, dbDownCloseDrill, persistBeforeSubmitDrill } from './drills.js';

const T0 = fixtures.T0 as Instant;
const okSender = (channel: NotificationChannel): NotificationSender => ({ channel, configured: true, async send() { return { ok: true }; } });

function repo() {
  const raised: string[] = [];
  const deliveries: { channel: string; level: number; ok: boolean }[] = [];
  const escalations: number[] = [];
  const resolved: string[] = [];
  let n = 0;
  return {
    raised, deliveries, escalations, resolved,
    newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid,
    repo: {
      async raise(x: { alertClass: string }) { raised.push(x.alertClass); },
      async recordDelivery(d: { channel: string; escalationLevel: number; confirmedAt: Instant | null }) { deliveries.push({ channel: d.channel, level: d.escalationLevel, ok: d.confirmedAt !== null }); },
      async escalate(_id: Uuid, level: number) { escalations.push(level); },
      async resolve(alertClass: string) { resolved.push(alertClass); return []; },
    },
  };
}

describe('automated readiness drills (§29, P10, M11)', () => {
  it('CRITICAL alert delivery passes when every round reaches the minimum channels including an out-of-app one, and records, escalates and resolves the drill alert', async () => {
    const r = repo();
    const out = await alertDeliveryDrill({ senders: [inAppSender, okSender('TELEGRAM'), unconfiguredSender('EMAIL')], policy: DEFAULT_NOTIFICATION_POLICY, clock: fixedClock(T0), newId: r.newId, repo: r.repo })();
    expect(out.verdict).toBe('PASS');
    expect(r.raised).toEqual(['DRILL_CRITICAL_ALERT_DELIVERY']);
    expect(r.escalations).toEqual([1]);
    expect(r.resolved).toEqual(['DRILL_CRITICAL_ALERT_DELIVERY']);
    expect(r.deliveries.filter((d) => d.ok).map((d) => `${d.channel}@${d.level}`)).toEqual(['IN_APP@0', 'TELEGRAM@0', 'IN_APP@1', 'TELEGRAM@1']);
    expect(r.deliveries.filter((d) => !d.ok).map((d) => d.channel)).toEqual(['EMAIL', 'EMAIL']);
    expect(out.transcript.join('\n')).toMatch(/dead-man pause not applied/);
  });

  it('CRITICAL alert delivery fails honestly without an out-of-app channel, and still resolves its alert', async () => {
    const r = repo();
    const out = await alertDeliveryDrill({ senders: [inAppSender, unconfiguredSender('TELEGRAM'), unconfiguredSender('EMAIL')], policy: DEFAULT_NOTIFICATION_POLICY, clock: fixedClock(T0), newId: r.newId, repo: r.repo })();
    expect(out.verdict).toBe('FAIL');
    expect(out.transcript.join('\n')).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(r.resolved).toEqual(['DRILL_CRITICAL_ALERT_DELIVERY']);
  });

  it('executor drills fail without an executor, and refuse to claim a PASS for a rehearsal that demonstrated nothing', async () => {
    const clock = fixedClock(T0);
    expect((await dbDownCloseDrill(null, clock)()).detail).toEqual({ reason: 'EXECUTOR_NOT_CONFIGURED' });
    expect((await persistBeforeSubmitDrill(null, clock)()).verdict).toBe('FAIL');

    // A funded wallet whose whole custody the plan accounts for: the only shape that is evidence.
    const good = { async drill(name: string) { return name === 'db-down-close' ? { ok: true, shadowSequence: 7, custodySlot: 100, actions: 2, skipped: 1, holdings: 4, closeableHoldings: 3 } : { ok: true, attemptsAudited: 3, violations: 0, unresolvedAttempts: 0 }; } };
    expect((await dbDownCloseDrill(good, clock)()).verdict).toBe('PASS');
    expect((await persistBeforeSubmitDrill(good, clock)()).verdict).toBe('PASS');

    // An empty wallet yields a valid zero-action plan and proves nothing (review 2026-09-09, M-6).
    const emptyWallet = { async drill() { return { ok: true, shadowSequence: 7, custodySlot: 100, actions: 0, skipped: 0, holdings: 0, closeableHoldings: 0 }; } };
    const na = await dbDownCloseDrill(emptyWallet, clock)();
    expect(na.verdict).toBe('NOT_APPLICABLE');
    expect(na.transcript.join('\n')).toMatch(/demonstrates nothing/);

    // A plan that does not account for everything held, and one with no synced shadow, both fail.
    const partial = { async drill() { return { ok: true, shadowSequence: 7, custodySlot: 100, actions: 1, skipped: 0, holdings: 5, closeableHoldings: 4 }; } };
    expect((await dbDownCloseDrill(partial, clock)()).verdict).toBe('FAIL');
    const noShadow = { async drill() { return { ok: true, shadowSequence: null, custodySlot: 100, actions: 2, skipped: 0, holdings: 2, closeableHoldings: 2 }; } };
    expect((await dbDownCloseDrill(noShadow, clock)()).verdict).toBe('FAIL');
    // An executor that predates the coverage report cannot be given a PASS on its say-so.
    const oldExecutor = { async drill() { return { ok: true, shadowSequence: 7, custodySlot: 100, actions: 0, skipped: 0 }; } };
    expect((await dbDownCloseDrill(oldExecutor, clock)()).verdict).toBe('FAIL');

    // An empty journal is not a pass, and an unresolved attempt is a failure the audit used to drop.
    const emptyJournal = { async drill() { return { ok: true, attemptsAudited: 0, violations: 0, unresolvedAttempts: 0 }; } };
    const none = await persistBeforeSubmitDrill(emptyJournal, clock)();
    expect(none.verdict).toBe('NOT_APPLICABLE');
    expect(none.transcript.join('\n')).toMatch(/no attempt in the journal/);
    const stranded = { async drill() { return { ok: true, attemptsAudited: 3, violations: 0, unresolvedAttempts: 1, unresolved: [{ correlationId: 'intent-1', lastKind: 'ATTEMPT_SUBMITTED' }] }; } };
    const un = await persistBeforeSubmitDrill(stranded, clock)();
    expect(un.verdict).toBe('FAIL');
    expect(un.transcript.join('\n')).toMatch(/unresolved/);
    const violating = { async drill() { return { ok: false, attemptsAudited: 3, violations: 1, unresolvedAttempts: 0, violating: [{ correlationId: 'intent-2', submittedAt: 4, reason: 'SIGNED_AFTER_SUBMIT' }] }; } };
    expect((await persistBeforeSubmitDrill(violating, clock)()).verdict).toBe('FAIL');

    const broken = { async drill(): Promise<Record<string, unknown>> { throw new Error('ECONNREFUSED'); } };
    expect((await dbDownCloseDrill(broken, clock)()).transcript[0]).toMatch(/ECONNREFUSED/);
  });
});
