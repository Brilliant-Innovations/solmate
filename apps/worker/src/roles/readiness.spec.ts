import { addMs, DEFAULT_READINESS_POLICY, DEFAULT_WALLET_RESERVE_POLICY, fixedClock, fixtures, TINY_LIVE_ROW_SET, type Amount, type Instant, type ReadinessBinding, type ReadinessRow, type ReadinessRowId, type ReadinessVerdict, type Release, type ReleaseAttestation, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { computeRows, runReadinessCycle, type ReadinessDeps, type ReadinessFacts } from './readiness.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const binding: ReadinessBinding = { gitSha: 'abcdef1', imageDigest: null, contractSetDigest: 'ab'.repeat(32) as Sha256Hex, policyDigests: { risk: 'risk-v1' }, tradingWallet: fixtures.WALLET as never, cluster: 'mainnet-beta', profile: 'P2', releaseId: IDS.release as Uuid, releaseDigest: 'cd'.repeat(32) as Sha256Hex };
const release: Release = { id: IDS.release as Uuid, digest: 'cd'.repeat(32) as Sha256Hex, binding: {} as Release['binding'], status: 'ARMED', createdAt: T0, promotedAt: T0, retiredAt: null };
const attestation: ReleaseAttestation = { id: IDS.attestation as Uuid, releaseId: release.id, releaseDigest: release.digest, purpose: 'ARM', operatorId: IDS.operator as Uuid, operatorRole: 'admin', credentialId: 'cred', credentialFingerprint: 'ef'.repeat(32) as Sha256Hex, challenge: 'c'.repeat(43), verificationResult: true, attestedAt: T0, expiresAt: null };
const healthy = (): ReadinessFacts => ({
  accountMode: 'LIVE',
  reconciliation: { status: 'CLEAN', evaluatedAt: addMs(T0, -30_000) },
  release,
  attestation,
  capital: { id: IDS.message as Uuid, accountId: IDS.account as Uuid, releaseId: release.id, attestationId: attestation.id, ceilingUsd: 250, recognizedUsdAtAttestation: 120, attestedBy: IDS.operator as Uuid, attestedAt: T0 },
  projection: { ...fixtures.riskStateProjection(), capitalAttestation: { ceilingUsd: 250, recognizedUsd: 120, reattestRequired: false }, gasReserveLamports: '200000000' as Amount, settlementAvailableBaseUnits: '50000000' as Amount } as never,
  presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -20_000) },
  chainHealth: { id: IDS.message as Uuid, observedAt: addMs(T0, -15_000), policyVersion: 'chain-health-v1' as never, state: 'HEALTHY', views: [{ label: 'primary', ok: true, slotConfirmed: 10 as never, slotFinalized: 5 as never, blockHeight: 1, latencyMs: 10, error: null }], headSlot: 10 as never, slotAdvanced: true, confirmedFinalizedLagSlots: 5, viewDivergenceSlots: null, effectOnEntries: 'NONE', reasons: [] },
  sleeveConflicts: [],
});
const depsOf = (over: Partial<ReadinessDeps> = {}): Pick<ReadinessDeps, 'reservePolicy' | 'presenceTimeoutMs' | 'reconciliationMaxAgeMs' | 'policy'> & Partial<ReadinessDeps> => ({ reservePolicy: DEFAULT_WALLET_RESERVE_POLICY, presenceTimeoutMs: 180_000, reconciliationMaxAgeMs: 300_000, policy: DEFAULT_READINESS_POLICY, ...over });
const rowMap = (rows: ReturnType<typeof computeRows>) => Object.fromEntries(rows.map((r) => [r.rowId, r.verdict === 'PASS' ? 'PASS' : `FAIL:${r.detail['reason']}`]));

function fake(over: { facts?: ReadinessFacts; rows?: ReadinessRow[]; verdict?: ReadinessVerdict | null; requests?: PendingControlRequest[]; role?: 'operator' | 'admin' | 'viewer' | null; stepUp?: boolean } = {}) {
  const inserted: ReadinessRow[] = [];
  const verdicts: ReadinessVerdict[] = [];
  const resolutions: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  let n = 0;
  const deps: ReadinessDeps = {
    repo: {
      async facts() { return over.facts ?? healthy(); },
      async latestRows() { return [...(over.rows ?? []), ...inserted]; },
      async insertRow(r) { inserted.push(r); },
      async latestVerdict() { return over.verdict === undefined ? null : over.verdict; },
      async insertVerdict(v) { verdicts.push(v); },
      async listPending() { return over.requests ?? []; },
      async operatorRole() { return over.role === undefined ? 'admin' : over.role; },
      async stepUpVerified() { return over.stepUp ?? true; },
      async resolve(id, state, resolution) { resolutions.push({ id, state, resolution }); return true; },
    },
    binding,
    strategyClass: 'DETERMINISTIC',
    enabledCapabilities: ['LIVE_SIGNING'],
    policy: DEFAULT_READINESS_POLICY,
    reservePolicy: DEFAULT_WALLET_RESERVE_POLICY,
    presenceTimeoutMs: 180_000,
    reconciliationMaxAgeMs: 300_000,
    clock: fixedClock(T0),
    logger,
    newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-00000000abcd` as Uuid,
  };
  return { deps, inserted, verdicts, resolutions };
}
const evidenceRow = (rowId: ReadinessRowId, over: Partial<ReadinessRow> = {}): ReadinessRow => ({ id: `${rowId}`.slice(0, 8).padEnd(8, '0').toLowerCase().replace(/[^0-9a-f]/g, '0') + '-0000-4000-8000-000000000000' as Uuid, rowId, kind: TINY_LIVE_ROW_SET.find((s) => s.rowId === rowId)!.kind, verdict: 'PASS', strategyClass: 'DETERMINISTIC', binding, detail: {}, evidenceRef: 'ci:run/1', recordedBy: 'operator:x', evaluatedAt: addMs(T0, -60_000), expiresAt: null, ...over });
const request = (payload: Record<string, unknown>, id = IDS.message as Uuid): PendingControlRequest => ({ id, requestedBy: IDS.operator as Uuid, kind: 'RUN_READINESS_DRILL', payload, createdAt: T0 });

describe('computed readiness rows from stored facts (§29, ADR-0004)', () => {
  it('healthy facts pass every computed row', () => {
    expect(rowMap(computeRows(healthy(), depsOf(), T0))).toEqual({ RECONCILIATION_CLEAN: 'PASS', TINY_LIVE_RELEASE_BOUND: 'PASS', CAPITAL_ATTESTATION: 'PASS', TINY_ATTESTED_CAPITAL: 'PASS', WALLET_RESERVES: 'PASS', OPERATOR_PRESENCE_HEARTBEAT: 'PASS', SINGLE_SLEEVE_PER_MINT: 'PASS', CHAIN_HEALTH: 'PASS' });
  });

  it('each fact failing names its reason: stale or mismatched reconciliation, unbound or unattested Release, paper account, ceiling crossed, thin reserves, absent operator, sleeve conflict, blocked chain', () => {
    const h = healthy();
    const check = (facts: ReadinessFacts, rowId: ReadinessRowId, reason: RegExp) => expect(rowMap(computeRows(facts, depsOf(), T0))[rowId], rowId).toMatch(reason);
    check({ ...h, reconciliation: { status: 'MISMATCH', evaluatedAt: T0 } }, 'RECONCILIATION_CLEAN', /MISMATCH/);
    check({ ...h, reconciliation: { status: 'CLEAN', evaluatedAt: addMs(T0, -400_000) } }, 'RECONCILIATION_CLEAN', /stale/);
    check({ ...h, reconciliation: null }, 'RECONCILIATION_CLEAN', /no reconciliation/);
    check({ ...h, release: null }, 'TINY_LIVE_RELEASE_BOUND', /no Release/);
    check({ ...h, release: { ...release, status: 'DRAFT' } }, 'TINY_LIVE_RELEASE_BOUND', /DRAFT/);
    check({ ...h, attestation: null }, 'TINY_LIVE_RELEASE_BOUND', /no attestation/);
    check({ ...h, attestation: { ...attestation, expiresAt: addMs(T0, -1) } }, 'TINY_LIVE_RELEASE_BOUND', /expired/);
    check({ ...h, attestation: { ...attestation, releaseDigest: 'ee'.repeat(32) as Sha256Hex } }, 'TINY_LIVE_RELEASE_BOUND', /another Release/);
    check({ ...h, accountMode: 'PAPER' }, 'CAPITAL_ATTESTATION', /not LIVE/);
    check({ ...h, accountMode: 'PAPER' }, 'TINY_ATTESTED_CAPITAL', /not LIVE/);
    check({ ...h, capital: null }, 'CAPITAL_ATTESTATION', /no capital attestation/);
    check({ ...h, projection: { ...h.projection!, capitalAttestation: { ceilingUsd: 250, recognizedUsd: 300, reattestRequired: true } } }, 'TINY_ATTESTED_CAPITAL', /above the attested ceiling/);
    check({ ...h, projection: { ...h.projection!, gasReserveLamports: '1000' as Amount } }, 'WALLET_RESERVES', /gas/);
    check({ ...h, projection: { ...h.projection!, settlementAvailableBaseUnits: '5' as Amount } }, 'WALLET_RESERVES', /settlement/);
    check({ ...h, projection: null }, 'WALLET_RESERVES', /no projection/);
    check({ ...h, presence: null }, 'OPERATOR_PRESENCE_HEARTBEAT', /no open session/);
    check({ ...h, presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -400_000) } }, 'OPERATOR_PRESENCE_HEARTBEAT', /absent/);
    check({ ...h, presence: { attended: false, lastPresenceHeartbeatAt: null } }, 'OPERATOR_PRESENCE_HEARTBEAT', /not attended/);
    check({ ...h, sleeveConflicts: [{ mint: 'm', sleeves: 2 }] }, 'SINGLE_SLEEVE_PER_MINT', /more than one sleeve/);
    check({ ...h, chainHealth: { ...h.chainHealth!, state: 'STALLED', effectOnEntries: 'BLOCK', reasons: ['halt'] } }, 'CHAIN_HEALTH', /STALLED/);
    check({ ...h, chainHealth: { ...h.chainHealth!, observedAt: addMs(T0, -DEFAULT_READINESS_POLICY.computedRowMaxAgeMs - 1) } }, 'CHAIN_HEALTH', /stale/);
    check({ ...h, chainHealth: null }, 'CHAIN_HEALTH', /no chain-health/);
  });
});

describe('worker readiness role: rows, evidence requests and the verdict', () => {
  it('appends every computed row on the first cycle, a NOT_READY verdict naming the evidence rows still missing, and appends nothing on an unchanged second cycle', async () => {
    const f = fake();
    const r1 = await runReadinessCycle(f.deps);
    expect(r1.verdict).toBe('NOT_READY');
    expect(r1.rowsAppended).toHaveLength(8);
    expect(r1.verdictAppended).toBe(true);
    expect(r1.missing.sort()).toEqual(TINY_LIVE_ROW_SET.filter((s) => s.kind !== 'COMPUTED' && s.requiresCapability === null).map((s) => s.rowId).sort());
    expect(f.verdicts[0]).toMatchObject({ name: 'READY_FOR_ATTENDED_TINY_LIVE', profile: 'P2', releaseId: IDS.release, verdict: 'NOT_READY', notApplicable: ['TRIGGER_LIFECYCLE'] });
    const g = fake({ rows: f.inserted, verdict: f.verdicts[0] });
    g.deps.clock = fixedClock(addMs(T0, 60_000));
    const r2 = await runReadinessCycle(g.deps);
    expect(r2.rowsAppended).toEqual([]);
    expect(r2.verdictAppended).toBe(false);
  });

  it('with every evidence row recorded against the same binding the verdict is READY; a changed commit makes the evidence stale again', async () => {
    const evidence = TINY_LIVE_ROW_SET.filter((s) => s.kind !== 'COMPUTED' && s.requiresCapability === null).map((s) => evidenceRow(s.rowId));
    const f = fake({ rows: evidence });
    const r = await runReadinessCycle(f.deps);
    expect(r).toMatchObject({ verdict: 'READY', missing: [], stale: [], failed: [] });
    expect(f.verdicts[0]?.verdict).toBe('READY');
    const moved = fake({ rows: evidence });
    moved.deps.binding = { ...binding, gitSha: 'abcdef2' };
    const r2 = await runReadinessCycle(moved.deps);
    expect(r2.verdict).toBe('NOT_READY');
    expect(r2.stale.length).toBe(evidence.length);
  });

  it('a RUN_READINESS_DRILL request records a bound row: PASS needs an admin, an evidence reference and (for drills and probes) a verified step-up; FAIL needs only an operator', async () => {
    const pass = request({ rowId: 'SIGNER_OUTAGE_DRILL', kind: 'DRILL', verdict: 'PASS', evidenceRef: 'drill:2026-09-08/signer-outage', detail: { durationMs: 900 } });
    const f = fake({ requests: [pass] });
    const r = await runReadinessCycle(f.deps);
    expect(r.evidence).toEqual({ accepted: 1, refused: {} });
    expect(f.inserted[0]).toMatchObject({ rowId: 'SIGNER_OUTAGE_DRILL', kind: 'DRILL', verdict: 'PASS', evidenceRef: 'drill:2026-09-08/signer-outage', recordedBy: `operator:${IDS.operator}`, binding, detail: { durationMs: 900, requestId: IDS.message } });
    expect(f.resolutions[0]).toMatchObject({ state: 'ACCEPTED', resolution: { rowId: 'SIGNER_OUTAGE_DRILL', verdict: 'PASS' } });
    const cases: Array<[string, Parameters<typeof fake>[0], string]> = [
      ['no step-up for a drill PASS', { requests: [pass], stepUp: false }, 'STEP_UP_REQUIRED'],
      ['operator, not admin', { requests: [pass], role: 'operator' }, 'ROLE_NOT_ADMIN'],
      ['viewer', { requests: [pass], role: 'viewer' }, 'NOT_AN_OPERATOR'],
      ['no evidence ref', { requests: [request({ rowId: 'SIGNER_OUTAGE_DRILL', kind: 'DRILL', verdict: 'PASS' })] }, 'EVIDENCE_REF_REQUIRED'],
      ['kind does not match the row', { requests: [request({ rowId: 'SIGNER_OUTAGE_DRILL', kind: 'CI_EVIDENCE', verdict: 'PASS', evidenceRef: 'x' })] }, 'ROW_KIND_MISMATCH'],
      ['computed rows cannot be recorded by hand', { requests: [request({ rowId: 'RECONCILIATION_CLEAN', kind: 'COMPUTED', verdict: 'PASS', evidenceRef: 'x' })] }, 'MALFORMED_PAYLOAD'],
      ['unknown row', { requests: [request({ rowId: 'NOPE', kind: 'DRILL', verdict: 'PASS', evidenceRef: 'x' })] }, 'MALFORMED_PAYLOAD'],
    ];
    for (const [label, over, reason] of cases) {
      const g = fake(over);
      const rr = await runReadinessCycle(g.deps);
      expect(rr.evidence.refused, label).toEqual({ [reason]: 1 });
      expect(g.inserted.filter((x) => x.kind !== 'COMPUTED'), label).toEqual([]);
    }
    // a CI_EVIDENCE PASS needs no step-up; a FAIL from an operator without step-up is accepted and blocks the verdict
    const ci = fake({ requests: [request({ rowId: 'INVARIANT_COVERAGE', kind: 'CI_EVIDENCE', verdict: 'PASS', evidenceRef: 'ci:123' })], stepUp: false });
    expect((await runReadinessCycle(ci.deps)).evidence).toEqual({ accepted: 1, refused: {} });
    const failed = fake({ requests: [request({ rowId: 'DB_DOWN_EMERGENCY_CLOSE', kind: 'DRILL', verdict: 'FAIL', detail: { reason: 'close timed out' } })], role: 'operator', stepUp: false });
    const rf = await runReadinessCycle(failed.deps);
    expect(rf.evidence).toEqual({ accepted: 1, refused: {} });
    expect(rf.failed).toContain('DB_DOWN_EMERGENCY_CLOSE');
  });
});

describe('automated drills (M11): EXECUTE_READINESS_DRILL runs the executor and records its verdict', () => {
  const drillRequest = (rowId: string, id = IDS.message as Uuid): PendingControlRequest => ({ id, requestedBy: IDS.operator as Uuid, kind: 'EXECUTE_READINESS_DRILL', payload: { rowId, source: 'readiness' }, createdAt: T0 });

  it('records a PASS row with the transcript as evidence when the drill passes, and a FAIL row when it fails or throws', async () => {
    const h = fake({ requests: [drillRequest('CRITICAL_ALERT_DELIVERY'), drillRequest('DB_DOWN_EMERGENCY_CLOSE', IDS.account as Uuid), drillRequest('PERSIST_BEFORE_SUBMIT_DRILL', IDS.release as Uuid)] });
    h.deps.drills = {
      CRITICAL_ALERT_DELIVERY: async () => ({ verdict: 'PASS', startedAt: T0, finishedAt: addMs(T0, 1_000), transcript: ['raised', 'delivered IN_APP, TELEGRAM', 'resolved'], detail: { rounds: 2 } }),
      DB_DOWN_EMERGENCY_CLOSE: async () => ({ verdict: 'FAIL', startedAt: T0, finishedAt: addMs(T0, 500), transcript: ['FAIL: no execution-service configured'], detail: { reason: 'EXECUTOR_NOT_CONFIGURED' } }),
      PERSIST_BEFORE_SUBMIT_DRILL: async () => { throw new Error('boom'); },
    };
    await runReadinessCycle(h.deps);
    const drills = h.inserted.filter((r) => r.kind === 'DRILL');
    expect(drills.map((r) => [r.rowId, r.verdict, r.detail['automated'], r.evidenceRef])).toEqual([
      ['CRITICAL_ALERT_DELIVERY', 'PASS', true, `drill:${IDS.message}`],
      ['DB_DOWN_EMERGENCY_CLOSE', 'FAIL', true, `drill:${IDS.account}`],
      ['PERSIST_BEFORE_SUBMIT_DRILL', 'FAIL', true, `drill:${IDS.release}`],
    ]);
    expect(drills[0]!.detail['transcript']).toEqual(['raised', 'delivered IN_APP, TELEGRAM', 'resolved']);
    expect(drills[0]!.recordedBy).toBe(`worker:drill:${IDS.operator}`);
    expect(drills[2]!.detail['transcript']).toEqual(['drill executor threw: boom']);
    expect(h.resolutions.map((r) => [r.state, r.resolution['verdict'], r.resolution['automated']])).toEqual([['ACCEPTED', 'PASS', true], ['ACCEPTED', 'FAIL', true], ['ACCEPTED', 'FAIL', true]]);
  });

  it('refuses a non-admin, an unknown or manual row, and a row without an executor', async () => {
    const op = fake({ requests: [drillRequest('CRITICAL_ALERT_DELIVERY')], role: 'operator' });
    op.deps.drills = { CRITICAL_ALERT_DELIVERY: async () => ({ verdict: 'PASS', startedAt: T0, finishedAt: T0, transcript: [], detail: {} }) };
    expect((await runReadinessCycle(op.deps)).evidence.refused).toEqual({ ROLE_NOT_ADMIN: 1 });
    const manual = fake({ requests: [drillRequest('SIGNER_OUTAGE_DRILL')] });
    expect((await runReadinessCycle(manual.deps)).evidence.refused).toEqual({ MALFORMED_PAYLOAD: 1 });
    const none = fake({ requests: [drillRequest('DB_DOWN_EMERGENCY_CLOSE')] });
    none.deps.drills = {};
    expect((await runReadinessCycle(none.deps)).evidence.refused).toEqual({ NOT_AUTOMATED: 1 });
    expect(none.inserted.filter((r) => r.kind === 'DRILL')).toHaveLength(0);
  });
});
