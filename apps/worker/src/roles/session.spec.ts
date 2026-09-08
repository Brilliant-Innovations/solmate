import { addMs, DEFAULT_SESSION_POLICY, fixedClock, toInstant, type ActivityState, type CapitalAuthority, type ColdStartGate, type ControlRequestKind, type DeploymentProfile, type Uuid } from '@sol-agent-trader/contracts';
import type { ColdStartFactRows, PendingControlRequest, PersistedTransition, SessionRow } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runSessionCycle, type SessionDeps, type SessionRepo } from './session.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const ACCOUNT = id(1);
const OPERATOR = id(2);
const logger = createLogger({ service: 'worker', sink: () => undefined });
const healthyFacts: ColdStartFactRows = { reconciliations: [], blockingFeeds: [], universeRefreshedAt: addMs(NOW, -3_600_000), eligibleAssets: 9, trackedAssets: 40, warmAssets: 3, openPositions: 0, positionsWithStaleSafety: 0 };

class MemoryRepo implements SessionRepo {
  sessions = new Map<Uuid, SessionRow>();
  transitions: PersistedTransition[] = [];
  requests: PendingControlRequest[] = [];
  resolved: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  facts: ColdStartFactRows = healthyFacts;
  async armingFacts() { return { releaseAttested: false, readinessPermits: false }; }
  lots = 0;
  inFlight = 0;
  verifiedRequests = new Set<Uuid>();
  private seq = 100;
  async findOpenSession(accountId: Uuid) { return [...this.sessions.values()].filter((s) => s.accountId === accountId && s.activityState !== 'OFF').at(-1) ?? null; }
  async createSession(input: { accountId: Uuid; profile: DeploymentProfile; attended: boolean; capitalAuthority: CapitalAuthority }) {
    const sid = id(++this.seq);
    this.sessions.set(sid, { id: sid, accountId: input.accountId, profile: input.profile, activityState: 'OFF', capitalAuthority: input.capitalAuthority, paused: { active: false, reason: null, since: null, by: null }, attended: input.attended, lastPresenceHeartbeatAt: null, coldStartGates: [], exposureAtLastTransition: { managedCount: 0, offlineProtectedCount: 0, unmanagedCount: 0, unmanagedUsd: null } });
    return sid;
  }
  async loadSession(sid: Uuid) { return this.sessions.get(sid) ?? null; }
  async persistTransition(t: PersistedTransition) {
    this.transitions.push(t);
    const s = this.sessions.get(t.sessionId as Uuid)!;
    this.sessions.set(s.id, { ...s, activityState: t.after.activityState, capitalAuthority: t.after.capitalAuthority, paused: t.after.paused, exposureAtLastTransition: t.after.exposureAtLastTransition });
  }
  async saveColdStartGates(sid: Uuid, gates: ColdStartGate[]) { const s = this.sessions.get(sid)!; this.sessions.set(sid, { ...s, coldStartGates: gates }); }
  async coldStartFacts() { return this.facts; }
  async windDownFacts() { return { openLots: this.lots, inFlightExecutions: this.inFlight }; }
  async listPendingControlRequests(kinds: ControlRequestKind[]) { return this.requests.filter((r) => kinds.includes(r.kind) && !this.resolved.some((x) => x.id === r.id)); }
  async stepUpVerifiedFor(requestId: Uuid) { return this.verifiedRequests.has(requestId); }
  async resolveControlRequest(rid: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>) { this.resolved.push({ id: rid, state, resolution }); return true; }
  heartbeat(at = NOW) { for (const s of this.sessions.values()) if (s.activityState !== 'OFF') this.sessions.set(s.id, { ...s, lastPresenceHeartbeatAt: at }); }
  activity(): ActivityState { return [...this.sessions.values()].at(-1)?.activityState ?? 'OFF'; }
}

const deps = (repo: MemoryRepo, over: Partial<SessionDeps> = {}): SessionDeps => ({ repo, clock: fixedClock(NOW), logger, policy: DEFAULT_SESSION_POLICY, account: { id: ACCOUNT }, profile: 'P1A', attended: true, authority: 'PAPER', autoStart: true, liveCapabilityEnabled: false, ...over });
const request = (n: number, kind: ControlRequestKind): PendingControlRequest => ({ id: id(n), requestedBy: OPERATOR, kind, payload: {}, createdAt: NOW });

describe('worker role session (D2, D60–D63, §21.2B)', () => {
  it('autostarts a paper session into STARTING, records the cold-start gates and reaches WATCH only when every gate passes (D63)', async () => {
    const repo = new MemoryRepo();
    repo.facts = { ...healthyFacts, warmAssets: 0 };
    const first = await runSessionCycle(deps(repo));
    expect(first).toMatchObject({ activity: 'STARTING', gatesFailed: ['WARMUP_SUFFICIENT'] });
    expect(repo.transitions.map((t) => [t.from, t.to, t.actor])).toEqual([['OFF', 'STARTING', 'SCHEDULE']]);
    expect(repo.activity()).toBe('STARTING');
    expect([...repo.sessions.values()][0]!.coldStartGates.filter((g) => !g.passed).map((g) => g.name)).toEqual(['WARMUP_SUFFICIENT']);
    const second = await runSessionCycle(deps(repo));
    expect(second.activity).toBe('STARTING');
    repo.facts = healthyFacts;
    const third = await runSessionCycle(deps(repo));
    expect(third).toMatchObject({ activity: 'WATCH', gatesFailed: [] });
  });

  it('WATCH becomes ACTIVE only with a fresh operator heartbeat, falls back to WATCH when presence lapses, and unattended profiles activate directly', async () => {
    const repo = new MemoryRepo();
    await runSessionCycle(deps(repo)); // STARTING → WATCH (gates pass)
    expect(repo.activity()).toBe('WATCH');
    const absent = await runSessionCycle(deps(repo));
    expect(absent).toMatchObject({ activity: 'WATCH', presence: 'ABSENT' });
    repo.heartbeat(addMs(NOW, -30_000));
    const present = await runSessionCycle(deps(repo));
    expect(present).toMatchObject({ activity: 'ACTIVE', presence: 'PRESENT' });
    repo.heartbeat(addMs(NOW, -DEFAULT_SESSION_POLICY.presenceTimeoutMs - 1));
    const lapsed = await runSessionCycle(deps(repo));
    expect(lapsed).toMatchObject({ activity: 'WATCH', presence: 'ABSENT' });

    const unattended = new MemoryRepo();
    await runSessionCycle(deps(unattended, { profile: 'P1B', attended: false }));
    const r = await runSessionCycle(deps(unattended, { profile: 'P1B', attended: false }));
    expect(r).toMatchObject({ activity: 'ACTIVE', presence: 'NOT_REQUIRED' });
  });

  it('operator requests: START/END/PAUSE are honoured in order with audited resolutions; PAUSE is sticky and RESUME needs a verified step-up', async () => {
    const repo = new MemoryRepo();
    repo.requests = [request(10, 'END_SESSION'), request(11, 'START_SESSION')];
    const r1 = await runSessionCycle(deps(repo, { autoStart: false, liveCapabilityEnabled: false }));
    expect(r1.requests).toEqual([{ id: id(10), kind: 'END_SESSION', outcome: 'REJECTED', reason: 'NO_SESSION' }, { id: id(11), kind: 'START_SESSION', outcome: 'ACCEPTED', reason: null }]);
    expect(repo.transitions[0]).toMatchObject({ from: 'OFF', to: 'STARTING', actor: 'OPERATOR', actorRef: OPERATOR });
    expect(r1.activity).toBe('WATCH'); // gates pass in the same tick
    repo.requests.push(request(12, 'PAUSE_NEW_ENTRIES'), request(13, 'RESUME_NEW_ENTRIES'));
    const r2 = await runSessionCycle(deps(repo, { autoStart: false, liveCapabilityEnabled: false }));
    expect(r2.requests).toEqual([{ id: id(12), kind: 'PAUSE_NEW_ENTRIES', outcome: 'ACCEPTED', reason: null }, { id: id(13), kind: 'RESUME_NEW_ENTRIES', outcome: 'REJECTED', reason: 'STEP_UP_REQUIRED' }]);
    expect(r2.paused).toBe(true);
    expect([...repo.sessions.values()][0]!.paused).toMatchObject({ active: true, reason: 'OPERATOR_PAUSE', by: 'OPERATOR' });
    repo.requests.push(request(14, 'RESUME_NEW_ENTRIES'));
    repo.verifiedRequests.add(id(14));
    const r3 = await runSessionCycle(deps(repo, { autoStart: false, liveCapabilityEnabled: false }));
    expect(r3.requests).toEqual([{ id: id(14), kind: 'RESUME_NEW_ENTRIES', outcome: 'ACCEPTED', reason: null }]);
    expect(r3.paused).toBe(false);
    expect(repo.resolved.find((x) => x.id === id(14))!.resolution).toMatchObject({ stepUpVerified: true });
  });

  it('END SESSION enters WIND_DOWN; OFF waits for zero open lots and no in-flight execution (D61); a new START creates a new session', async () => {
    const repo = new MemoryRepo();
    await runSessionCycle(deps(repo));
    repo.lots = 2;
    repo.requests = [request(20, 'END_SESSION')];
    const r1 = await runSessionCycle(deps(repo));
    expect(r1).toMatchObject({ activity: 'WIND_DOWN', windDownBlockers: ['2 open lot(s)'] });
    repo.lots = 0;
    repo.inFlight = 1;
    const r2 = await runSessionCycle(deps(repo));
    expect(r2).toMatchObject({ activity: 'WIND_DOWN', windDownBlockers: ['1 execution(s) in flight'] });
    repo.inFlight = 0;
    const r3 = await runSessionCycle(deps(repo));
    expect(r3.activity).toBe('OFF');
    expect(repo.transitions.at(-1)).toMatchObject({ from: 'WIND_DOWN', to: 'OFF', after: { exposureAtLastTransition: { unmanagedCount: 0 } } });
    // autostart opens a fresh session row rather than reviving the ended one
    const r4 = await runSessionCycle(deps(repo));
    expect(r4.activity).toBe('WATCH');
    expect(repo.sessions.size).toBe(2);
  });
});
