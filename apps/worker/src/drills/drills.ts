import type { AlertSeverity, Clock, Instant, NotificationChannel, NotificationPolicy, Uuid } from '@sol-agent-trader/contracts';
import type { NotificationSender, OutboundNotification } from '../notifications/channels.js';

/**
 * Automated readiness drills (blueprint §29, §21.2A, P10; plan M11). Each executor rehearses one
 * protection in the running deployment and returns a verdict with a transcript the readiness row
 * stores as evidence. A drill never widens authority: it raises and resolves its own alert, asks the
 * executor for a dry run or an audit, and refuses to claim a PASS for anything it did not exercise.
 */

export interface DrillOutcome {
  /** NOT_APPLICABLE when the rehearsal ran but this deployment gave it nothing to demonstrate. */
  verdict: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  startedAt: Instant;
  finishedAt: Instant;
  transcript: string[];
  detail: Record<string, unknown>;
}

export type DrillExecutor = () => Promise<DrillOutcome>;

// --- CRITICAL_ALERT_DELIVERY ------------------------------------------------------------------------

export interface AlertDeliveryDrillDeps {
  senders: readonly NotificationSender[];
  policy: NotificationPolicy;
  clock: Clock;
  newId: () => Uuid;
  repo: {
    raise(n: { id: Uuid; severity: AlertSeverity; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant; deadManDeadline: Instant | null }): Promise<void>;
    recordDelivery(d: { id: Uuid; notificationId: Uuid; channel: NotificationChannel; escalationLevel: number; attemptedAt: Instant; confirmedAt: Instant | null; error: string | null }): Promise<void>;
    escalate(id: Uuid, level: number): Promise<void>;
    resolve(alertClass: string, at: Instant): Promise<Uuid[]>;
  };
}

/**
 * Raises a CRITICAL drill alert, delivers it on every channel the policy maps to CRITICAL, escalates
 * it one level and delivers again, then resolves it. PASS needs at least `criticalMinConfirmedChannels`
 * confirmed channels including one out-of-app channel, on both rounds. The dead-man pause is not
 * applied by the drill (it would pause the live session); the transcript says so and names the unit
 * test that exercises it.
 */
export function alertDeliveryDrill(deps: AlertDeliveryDrillDeps): DrillExecutor {
  return async () => {
    const startedAt = deps.clock.now();
    const transcript: string[] = [];
    const id = deps.newId();
    const alertClass = 'DRILL_CRITICAL_ALERT_DELIVERY';
    const channels = deps.policy.channelsBySeverity['CRITICAL'];
    await deps.repo.raise({ id, severity: 'CRITICAL', alertClass, summary: 'Readiness drill: CRITICAL alert delivery, escalation and out-of-app channels. No action required.', affected: { drill: true, startedAt }, automatedResponse: 'DRILL: no pause applied', raisedAt: startedAt, deadManDeadline: null });
    transcript.push(`raised ${alertClass} ${id} as CRITICAL at ${startedAt}; policy channels ${channels.join(', ')}`);
    const rounds: { level: number; confirmed: NotificationChannel[]; failed: { channel: NotificationChannel; error: string }[] }[] = [];
    try {
      for (const level of [0, 1]) {
        if (level > 0) {
          await deps.repo.escalate(id, level);
          transcript.push(`escalated to level ${level}`);
        }
        const n: OutboundNotification = { id, severity: 'CRITICAL', alertClass, summary: 'Readiness drill: CRITICAL alert delivery', escalationLevel: level, raisedAt: startedAt };
        const round = { level, confirmed: [] as NotificationChannel[], failed: [] as { channel: NotificationChannel; error: string }[] };
        for (const channel of channels) {
          const sender = deps.senders.find((s) => s.channel === channel);
          const attemptedAt = deps.clock.now();
          const result = sender ? await sender.send(n) : ({ ok: false, error: 'NO_SENDER' } as const);
          await deps.repo.recordDelivery({ id: deps.newId(), notificationId: id, channel, escalationLevel: level, attemptedAt, confirmedAt: result.ok ? deps.clock.now() : null, error: result.ok ? null : result.error });
          if (result.ok) round.confirmed.push(channel);
          else round.failed.push({ channel, error: result.error });
        }
        rounds.push(round);
        transcript.push(`level ${level}: confirmed ${round.confirmed.join(', ') || 'none'}; failed ${round.failed.map((f) => `${f.channel} (${f.error})`).join(', ') || 'none'}`);
      }
    } finally {
      // The drill raised a CRITICAL; whatever happens between here and there, it resolves it. An
      // abort mid-drill used to strand a permanent open CRITICAL that only a later successful drill
      // could clear (review 2026-09-09, L-3); the notifications role now owns the class as well.
      await deps.repo.resolve(alertClass, deps.clock.now());
    }
    const finishedAt = deps.clock.now();
    transcript.push(`resolved ${alertClass} at ${finishedAt}`);
    const outOfApp = (r: (typeof rounds)[number]) => r.confirmed.some((c) => c !== 'IN_APP');
    const enough = rounds.every((r) => r.confirmed.length >= deps.policy.criticalMinConfirmedChannels && outOfApp(r));
    transcript.push(enough ? `PASS: every round reached ${deps.policy.criticalMinConfirmedChannels}+ channels including an out-of-app channel` : `FAIL: a round reached fewer than ${deps.policy.criticalMinConfirmedChannels} channels or no out-of-app channel (configure TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)`);
    transcript.push('dead-man pause not applied by the drill (it would pause the live session); exercised by apps/worker/src/roles/notifications.spec.ts and imposed independently of dashboards by the notifications role');
    return { verdict: enough ? 'PASS' : 'FAIL', startedAt, finishedAt, transcript, detail: { notificationId: id, rounds, channels, minConfirmed: deps.policy.criticalMinConfirmedChannels, deadManExercised: 'unit-test' } };
  };
}

// --- executor drills --------------------------------------------------------------------------------

export interface ExecutorDrillClient {
  drill(name: 'db-down-close' | 'persist-before-submit'): Promise<Record<string, unknown>>;
}

/**
 * DB-down emergency close (D22, §15.10A): asks the executor to plan EMERGENCY_CLOSE_ALL from its local
 * shadow and chain custody without the database and without submitting.
 *
 * PASS needs the rehearsal to have demonstrated something: a plan, a synced shadow sequence, and a
 * plan that accounts for every closeable holding the wallet actually has. A zero-action plan on an
 * empty wallet is a valid plan and no evidence at all, so it records NOT_APPLICABLE rather than a
 * PASS the arming path would rely on (review 2026-09-09, M-6).
 */
export function dbDownCloseDrill(client: ExecutorDrillClient | null, clock: Clock): DrillExecutor {
  return async () => {
    const startedAt = clock.now();
    const transcript: string[] = [];
    if (!client) return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript: ['FAIL: no execution-service configured (EXECUTION_SERVICE_URL / INTERNAL_API_SECRET); the DB-down close cannot be rehearsed in this deployment'], detail: { reason: 'EXECUTOR_NOT_CONFIGURED' } };
    try {
      const r = await client.drill('db-down-close');
      transcript.push(`executor dry run: ${JSON.stringify(r)}`);
      const num = (k: string): number | null => (typeof r[k] === 'number' ? (r[k] as number) : null);
      const planned = r['ok'] === true;
      const closeable = num('closeableHoldings');
      const actions = num('actions') ?? 0;
      const skipped = num('skipped') ?? 0;
      const shadow = r['shadowSequence'];
      if (!planned) {
        transcript.push(`FAIL: executor could not plan a DB-independent close (${String(r['reasons'] ?? r['error'] ?? 'unknown')})`);
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (shadow === null || shadow === undefined) {
        transcript.push('FAIL: the executor has no synced position shadow, so a DB-down close would have no bounds to plan against');
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (closeable === null) {
        transcript.push('FAIL: the executor did not report how much closeable custody it holds, so the plan cannot be checked for coverage (executor predates the M-6 fix)');
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (closeable === 0) {
        transcript.push('NOT_APPLICABLE: the trading wallet holds no closeable position, so a planned close of zero actions demonstrates nothing. Re-run this drill against a funded wallet before it counts as readiness evidence.');
        return { verdict: 'NOT_APPLICABLE', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (actions + skipped < closeable) {
        transcript.push(`FAIL: ${closeable} closeable holding(s) but only ${actions} planned and ${skipped} explicitly skipped; the plan does not account for everything held`);
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      transcript.push(`PASS: emergency close planned from shadow sequence ${String(shadow)} and custody slot ${String(r['custodySlot'])} without the database; ${actions} action(s) and ${skipped} skipped across ${closeable} closeable holding(s); nothing submitted`);
      return { verdict: 'PASS', startedAt, finishedAt: clock.now(), transcript, detail: r };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript: [`FAIL: executor drill call failed: ${message}`], detail: { error: message } };
    }
  };
}

/**
 * Persist-before-submit (D12, §6.18): the executor audits its own durable journal — every attempt
 * that reached SUBMITTED has an earlier SIGNED record for the same correlation id, retries counted
 * rather than collapsed, and nothing left unresolved. PASS only when at least one attempt exists to
 * audit; an empty journal is NOT_APPLICABLE, not a pass (review 2026-09-09, M-7).
 */
export function persistBeforeSubmitDrill(client: ExecutorDrillClient | null, clock: Clock): DrillExecutor {
  return async () => {
    const startedAt = clock.now();
    if (!client) return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript: ['FAIL: no execution-service configured; the journal cannot be audited in this deployment'], detail: { reason: 'EXECUTOR_NOT_CONFIGURED' } };
    try {
      const r = await client.drill('persist-before-submit');
      const audited = Number(r['attemptsAudited'] ?? 0);
      const violations = Number(r['violations'] ?? 0);
      const unresolved = Number(r['unresolvedAttempts'] ?? 0);
      const transcript = [`executor journal audit: ${JSON.stringify(r)}`];
      if (audited === 0) {
        transcript.push('NOT_APPLICABLE: no attempt in the journal yet, so there is nothing to audit. Re-run after this deployment has executed at least one attempt.');
        return { verdict: 'NOT_APPLICABLE', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (violations > 0) {
        transcript.push(`FAIL: ${violations} attempt(s) submitted without a persisted SIGNED record before them: ${JSON.stringify(r['violating'] ?? [])}`);
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      if (unresolved > 0) {
        transcript.push(`FAIL: ${unresolved} attempt(s) left unresolved in the journal (last entry SIGNED or SUBMITTED with no result); a crash there is exactly what the record exists to recover from: ${JSON.stringify(r['unresolved'] ?? [])}`);
        return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript, detail: r };
      }
      transcript.push(`PASS: ${audited} attempt(s) audited, every SUBMITTED preceded by its own SIGNED record, nothing unresolved`);
      return { verdict: 'PASS', startedAt, finishedAt: clock.now(), transcript, detail: r };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verdict: 'FAIL', startedAt, finishedAt: clock.now(), transcript: [`FAIL: executor drill call failed: ${message}`], detail: { error: message } };
    }
  };
}