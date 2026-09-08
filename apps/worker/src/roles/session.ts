import { CapitalAuthority, instantToMs, type ActivityState, type ActorKind, type Clock, type ColdStartGate, type ControlRequestKind, type DeploymentProfile, type Instant, type SessionPolicy, type Uuid, type VersionId, type WatchdogPolicy } from '@sol-agent-trader/contracts';
import type { ColdStartFactRows, PendingControlRequest, PersistedTransition, SessionRow } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { coldStartPassed, evaluateColdStartGates, presenceState, runtimeTransition, windDownPlan, type LotForWindDown, type Presence, type RuntimeEvent, type RuntimeState, type StrategyOfflineTerms } from '@sol-agent-trader/risk';

/**
 * Worker role `session` (blueprint D2, D60–D63, §20.21, §21.2B, §21.3, §23.3; execution plan M5a
 * "minimal runtime session"). One session per paper account. Every tick it:
 *
 * 1. acts on pending operator control requests in order: START_SESSION, END_SESSION,
 *    PAUSE_NEW_ENTRIES (cheap, no step-up) and RESUME_NEW_ENTRIES (needs a verified step-up
 *    assertion for that request), each accepted or rejected with an audit row;
 * 2. drives the machine from stored facts: STARTING evaluates and records the D63 cold-start
 *    gates and leaves only when all pass; WATCH ↔ ACTIVE follows attended presence; WIND_DOWN
 *    waits for zero open lots and no in-flight execution before OFF (D61).
 *
 * The worker never clears a pause and never raises capital authority. PAPER authority is fixed at
 * session creation; live arming stays with the M7 operator flow. `SESSION_AUTOSTART` lets a
 * schedule start the paper session (D62) when no operator request is pending.
 */

export interface SessionRepo {
  findOpenSession(accountId: Uuid): Promise<SessionRow | null>;
  createSession(input: { accountId: Uuid; profile: DeploymentProfile; attended: boolean; capitalAuthority: CapitalAuthority }): Promise<Uuid>;
  loadSession(id: Uuid): Promise<SessionRow | null>;
  persistTransition(t: PersistedTransition): Promise<void>;
  saveColdStartGates(id: Uuid, gates: ColdStartGate[]): Promise<void>;
  coldStartFacts(now: Instant): Promise<ColdStartFactRows>;
  windDownFacts(accountId: Uuid): Promise<{ openLots: number; inFlightExecutions: number }>;
  listPendingControlRequests(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  stepUpVerifiedFor(requestId: Uuid, now: Instant): Promise<boolean>;
  resolveControlRequest(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
  /** §15.9 facts for a requested live authority: an ARMED Release with a valid ARM attestation exists for the account's strategies, and the readiness verdict permits. */
  armingFacts(authority: CapitalAuthority, now: Instant): Promise<{ releaseAttested: boolean; readinessPermits: boolean }>;
  /** Sticky entry pauses that outlive sessions (§21.2C): STARTING honours them; only RESUME with step-up clears them. */
  activeEntryPauses(): Promise<{ reason: string; setBy: string; setAt: Instant }[]>;
  clearEntryPauses(by: Uuid, ref: string): Promise<number>;
  /** D61 wind-down inputs: open lots with protection and safety state, strategy offline terms, watchdog telemetry. */
  windDownLots(accountId: Uuid): Promise<LotForWindDown[]>;
  strategyOfflineTerms(strategyVersionId: VersionId): Promise<StrategyOfflineTerms | null>;
  watchdogLastRunAt(): Promise<Instant | null>;
  setOfflineResumeDeadline(sessionId: Uuid, deadline: Instant | null, protectedLots: number): Promise<void>;
}

export interface SessionDeps {
  repo: SessionRepo;
  clock: Clock;
  logger: Logger;
  policy: SessionPolicy;
  account: { id: Uuid };
  profile: DeploymentProfile;
  attended: boolean;
  authority: CapitalAuthority;
  autoStart: boolean;
  /** Deployment-level live capability (§15.9); false in every paper profile. */
  liveCapabilityEnabled: boolean;
  watchdogPolicy: WatchdogPolicy;
}

export interface SessionReport {
  sessionId: Uuid | null;
  activity: ActivityState;
  paused: boolean;
  presence: Presence | null;
  gatesFailed: string[];
  transitions: { from: ActivityState; to: ActivityState; by: ActorKind }[];
  requests: { id: Uuid; kind: ControlRequestKind; outcome: 'ACCEPTED' | 'REJECTED'; reason: string | null }[];
  windDownBlockers: string[];
  errors: string[];
}

const CONTROL_KINDS: ControlRequestKind[] = ['START_SESSION', 'END_SESSION', 'PAUSE_NEW_ENTRIES', 'RESUME_NEW_ENTRIES', 'SET_REQUESTED_MODE'];

export async function runSessionCycle(deps: SessionDeps): Promise<SessionReport> {
  const now = deps.clock.now();
  const report: SessionReport = { sessionId: null, activity: 'OFF', paused: false, presence: null, gatesFailed: [], transitions: [], requests: [], windDownBlockers: [], errors: [] };
  let session = await deps.repo.findOpenSession(deps.account.id);

  const persist = async (row: SessionRow, from: RuntimeState, to: RuntimeState, by: ActorKind, actorRef: string, reason: string | null, pausedReason: string | null): Promise<SessionRow> => {
    const facts = await deps.repo.windDownFacts(deps.account.id);
    await deps.repo.persistTransition({
      sessionId: row.id,
      from: from.activity,
      to: to.activity,
      at: now,
      actor: by,
      actorRef,
      reason,
      after: {
        activityState: to.activity,
        capitalAuthority: to.authority,
        paused: to.paused ? { active: true, reason: row.paused.active ? row.paused.reason : pausedReason, since: row.paused.active ? row.paused.since : now, by: row.paused.active ? row.paused.by : to.pausedBy } : { active: false, reason: null, since: null, by: null },
        exposureAtLastTransition: { managedCount: to.activity === 'OFF' ? 0 : facts.openLots, offlineProtectedCount: 0, unmanagedCount: to.activity === 'OFF' ? 0 : 0, unmanagedUsd: null },
      },
    });
    if (from.activity !== to.activity) report.transitions.push({ from: from.activity, to: to.activity, by });
    const reloaded = await deps.repo.loadSession(row.id);
    if (!reloaded) throw new Error(`session ${row.id} vanished`);
    return reloaded;
  };
  const stateOf = (row: SessionRow | null): RuntimeState => ({ activity: row?.activityState ?? 'OFF', authority: row?.capitalAuthority ?? deps.authority, paused: row?.paused.active ?? false, pausedBy: row?.paused.by ?? null, attended: row?.attended ?? deps.attended, liveCapabilityEnabled: false });
  const start = async (by: ActorKind, actorRef: string): Promise<SessionRow> => {
    const id = await deps.repo.createSession({ accountId: deps.account.id, profile: deps.profile, attended: deps.attended, capitalAuthority: deps.authority });
    const created = await deps.repo.loadSession(id);
    if (!created) throw new Error('session not created');
    const r = runtimeTransition(stateOf(created), { type: 'START', at: now, by });
    if (!r.ok) throw new Error(`START rejected: ${JSON.stringify(r.rejection)}`);
    let started = await persist(created, stateOf(created), r.state, by, actorRef, 'session start', null);
    // §21.2C: a sticky pause left by the watchdog or the dead-man rule is honoured at start; only a step-up RESUME clears it.
    const sticky = await deps.repo.activeEntryPauses();
    if (sticky.length) {
      const p = runtimeTransition(stateOf(started), { type: 'PAUSE', at: now, by: 'WORKER' });
      if (p.ok) started = await persist(started, stateOf(started), p.state, 'WORKER', 'sticky-entry-pause', 'sticky entry pause honoured at start', `STICKY:${sticky.map((x) => x.reason).join(',')}`);
      deps.logger.warn('session_started_paused', { sessionId: started.id, sticky: sticky.map((x) => ({ reason: x.reason, setBy: x.setBy, setAt: x.setAt })) });
    }
    return started;
  };

  // 1. Operator control requests, oldest first.
  try {
    const pending = await deps.repo.listPendingControlRequests(CONTROL_KINDS, 20);
    for (const req of pending) {
      const state = stateOf(session);
      const resolve = async (outcome: 'ACCEPTED' | 'REJECTED', reason: string | null, extra: Record<string, unknown> = {}) => {
        await deps.repo.resolveControlRequest(req.id, outcome, { reason, sessionId: session?.id ?? null, ...extra }, now);
        report.requests.push({ id: req.id, kind: req.kind, outcome, reason });
        deps.logger.info('control_request_resolved', { requestId: req.id, kind: req.kind, outcome, reason });
      };
      try {
        switch (req.kind) {
          case 'START_SESSION':
            if (session) await resolve('REJECTED', 'ALREADY_RUNNING');
            else {
              session = await start('OPERATOR', req.requestedBy);
              await resolve('ACCEPTED', null, { sessionId: session.id });
            }
            break;
          case 'END_SESSION': {
            if (!session) {
              await resolve('REJECTED', 'NO_SESSION');
              break;
            }
            const r = runtimeTransition(state, { type: 'END_SESSION', at: now, by: 'OPERATOR' });
            if (!r.ok) {
              await resolve('REJECTED', r.rejection.code);
              break;
            }
            session = await persist(session, state, r.state, 'OPERATOR', req.requestedBy, 'operator END SESSION', null);
            await resolve('ACCEPTED', null);
            break;
          }
          case 'PAUSE_NEW_ENTRIES': {
            if (!session) {
              await resolve('REJECTED', 'NO_SESSION');
              break;
            }
            const r = runtimeTransition(state, { type: 'PAUSE', at: now, by: 'OPERATOR' });
            if (!r.ok) {
              await resolve('REJECTED', r.rejection.code);
              break;
            }
            session = await persist(session, state, r.state, 'OPERATOR', req.requestedBy, 'operator pause', 'OPERATOR_PAUSE');
            await resolve('ACCEPTED', null);
            break;
          }
          case 'RESUME_NEW_ENTRIES': {
            if (!session) {
              await resolve('REJECTED', 'NO_SESSION');
              break;
            }
            const stepUpVerified = await deps.repo.stepUpVerifiedFor(req.id, now);
            const r = runtimeTransition(state, { type: 'RESUME', at: now, by: 'OPERATOR', stepUpVerified });
            if (!r.ok) {
              await resolve('REJECTED', r.rejection.code);
              break;
            }
            session = await persist(session, state, r.state, 'OPERATOR', req.requestedBy, 'operator resume (step-up verified)', null);
            const stickyCleared = await deps.repo.clearEntryPauses(req.requestedBy, `control-request:${req.id}`);
            await resolve('ACCEPTED', null, { stepUpVerified: true, stickyPausesCleared: stickyCleared });
            break;
          }
          case 'SET_REQUESTED_MODE': {
            if (!session) {
              await resolve('REJECTED', 'NO_SESSION');
              break;
            }
            const authority = CapitalAuthority.safeParse(req.payload['authority']);
            if (!authority.success) {
              await resolve('REJECTED', 'MALFORMED_PAYLOAD');
              break;
            }
            const stepUpVerified = await deps.repo.stepUpVerifiedFor(req.id, now);
            const facts = await deps.repo.armingFacts(authority.data, now);
            const r = runtimeTransition({ ...state, liveCapabilityEnabled: deps.liveCapabilityEnabled }, { type: 'SET_AUTHORITY', at: now, by: 'OPERATOR', authority: authority.data, releaseAttested: facts.releaseAttested, readinessPermits: facts.readinessPermits, stepUpVerified });
            if (!r.ok) {
              await resolve('REJECTED', r.rejection.code, 'missing' in r.rejection ? { missing: r.rejection.missing } : {});
              break;
            }
            session = await persist(session, state, r.state, 'OPERATOR', req.requestedBy, `operator set authority ${authority.data}`, null);
            await resolve('ACCEPTED', null, { authority: authority.data, stepUpVerified, ...facts });
            break;
          }
          default:
            await resolve('REJECTED', 'UNSUPPORTED_KIND');
        }
      } catch (err) {
        report.errors.push(`request ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    report.errors.push(`control requests: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Schedule-driven start for the paper session (D62) when nothing runs and no operator spoke.
  if (!session && deps.autoStart && deps.authority === 'PAPER') {
    try {
      session = await start('SCHEDULE', 'SESSION_AUTOSTART');
      deps.logger.info('session_autostarted', { sessionId: session.id, profile: deps.profile, attended: deps.attended });
    } catch (err) {
      report.errors.push(`autostart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!session) {
    deps.logger.info('session_cycle', { activity: 'OFF', sessionId: null, requests: report.requests.length, errors: report.errors.length });
    return report;
  }

  // 3. Drive the machine from stored facts.
  try {
    const state = stateOf(session);
    report.presence = presenceState(session.attended, session.lastPresenceHeartbeatAt, now, deps.policy);
    const apply = async (event: RuntimeEvent, by: ActorKind, reason: string) => {
      const r = runtimeTransition(state, event);
      if (!r.ok) throw new Error(`${event.type} rejected: ${JSON.stringify(r.rejection)}`);
      session = await persist(session!, state, r.state, by, 'session-role', reason, null);
    };
    switch (state.activity) {
      case 'STARTING': {
        const facts = await deps.repo.coldStartFacts(now);
        const gates = evaluateColdStartGates({ ...facts, authority: state.authority, liveChecksHealthy: null }, deps.policy, now);
        await deps.repo.saveColdStartGates(session.id, gates);
        report.gatesFailed = gates.filter((g) => !g.passed).map((g) => g.name);
        if (coldStartPassed(gates)) await apply({ type: 'COLD_START_PASSED', at: now }, 'WORKER', 'cold-start gates passed');
        else deps.logger.info('session_cold_start_waiting', { sessionId: session.id, failed: gates.filter((g) => !g.passed).map((g) => `${g.name}: ${g.detail ?? ''}`) });
        break;
      }
      case 'WATCH':
        if (report.presence !== 'ABSENT') await apply({ type: 'ACTIVATE', at: now, by: 'WORKER' }, 'WORKER', report.presence === 'PRESENT' ? 'operator present' : 'unattended profile');
        break;
      case 'ACTIVE':
        if (report.presence === 'ABSENT') await apply({ type: 'TO_WATCH', at: now, by: 'WORKER' }, 'WORKER', 'operator presence lost');
        break;
      case 'WIND_DOWN': {
        // §21.2B / D61: OFF only when every remaining lot is OFFLINE_PROTECTED within policy and the resume watchdog is healthy; otherwise wait (the position monitor closes paper lots meanwhile).
        const facts = await deps.repo.windDownFacts(deps.account.id);
        const lots = await deps.repo.windDownLots(deps.account.id);
        const terms = new Map<VersionId, StrategyOfflineTerms | null>();
        for (const l of lots) if (!terms.has(l.strategyVersionId)) terms.set(l.strategyVersionId, await deps.repo.strategyOfflineTerms(l.strategyVersionId));
        const lastRun = await deps.repo.watchdogLastRunAt();
        const plan = windDownPlan({
          lots,
          strategyTerms: (v) => terms.get(v) ?? null,
          inFlightExecutions: facts.inFlightExecutions,
          inFlightCustodyOps: 0,
          emergencyRouteFresh: null,
          watchdog: { healthy: lastRun !== null && instantToMs(now) - instantToMs(lastRun) <= deps.watchdogPolicy.watchdogFreshMs, lastRunAt: lastRun },
          plannedResumeAt: null,
          now,
        });
        report.windDownBlockers.push(...plan.blockers);
        if (plan.canGoOff) {
          if (plan.offlineProtectedLots > 0) await deps.repo.setOfflineResumeDeadline(session.id, plan.resumeBy, plan.offlineProtectedLots);
          await apply({ type: 'WIND_DOWN_COMPLETE', at: now, unmanagedLots: plan.unmanagedLots, inFlightExecutions: facts.inFlightExecutions, inFlightCustodyOps: 0 }, 'WORKER', 'wind-down complete');
        } else deps.logger.info('session_wind_down_waiting', { sessionId: session.id, blockers: report.windDownBlockers, offlineProtectedLots: plan.offlineProtectedLots });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    report.errors.push(`drive: ${err instanceof Error ? err.message : String(err)}`);
  }

  report.sessionId = session.id;
  report.activity = session.activityState;
  report.paused = session.paused.active;
  deps.logger.info('session_cycle', { sessionId: session.id, activity: session.activityState, paused: session.paused.active, pausedReason: session.paused.reason, presence: report.presence, gatesFailed: report.gatesFailed, transitions: report.transitions, requests: report.requests.length, windDownBlockers: report.windDownBlockers, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('session_cycle_error', { error: e });
  return report;
}
