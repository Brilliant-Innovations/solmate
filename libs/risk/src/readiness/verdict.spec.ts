import { addMs, DEFAULT_READINESS_POLICY, fixtures, TINY_LIVE_ROW_SET, type Instant, type ReadinessBinding, type ReadinessRow, type ReadinessRowId, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { bindingMatches, computeReadiness, verdictPermits } from './verdict.js';

const T0 = fixtures.T0 as Instant;
const ID = fixtures.IDS.message as Uuid;
const binding: ReadinessBinding = { gitSha: 'abcdef1', imageDigest: null, contractSetDigest: 'ab'.repeat(32) as Sha256Hex, policyDigests: { risk: 'risk-v1', session: 'session-v1' }, tradingWallet: fixtures.WALLET as never, cluster: 'mainnet-beta', profile: 'P2', releaseId: fixtures.IDS.release as Uuid, releaseDigest: 'cd'.repeat(32) as Sha256Hex };
let n = 0;
const row = (rowId: ReadinessRowId, over: Partial<ReadinessRow> = {}): ReadinessRow => {
  const spec = TINY_LIVE_ROW_SET.find((s) => s.rowId === rowId)!;
  return { id: `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid, rowId, kind: spec.kind, verdict: 'PASS', strategyClass: 'DETERMINISTIC', binding, detail: {}, evidenceRef: null, recordedBy: 'test', evaluatedAt: addMs(T0, -1_000), expiresAt: null, ...over };
};
/** A PASS for every row this deployment actually requires: the unconditional ones plus those LIVE_SIGNING turns on. */
const allPass = (): ReadinessRow[] => TINY_LIVE_ROW_SET.filter((s) => s.requiresCapability === null || s.requiresCapability === 'LIVE_SIGNING').map((s) => row(s.rowId));
const compute = (rows: ReadinessRow[], over: Partial<Parameters<typeof computeReadiness>[0]> = {}) => computeReadiness({ id: ID, name: 'READY_FOR_ATTENDED_TINY_LIVE', spec: TINY_LIVE_ROW_SET, rows, binding, strategyClass: 'DETERMINISTIC', enabledCapabilities: ['LIVE_SIGNING'], policy: DEFAULT_READINESS_POLICY, now: T0, ...over });

describe('readiness verdict (§29, ADR-0004, ADR-0010)', () => {
  it('every required row a fresh bound PASS and the conditional row NOT_APPLICABLE (provider protection disabled) is READY', () => {
    const v = compute(allPass());
    expect(v.verdict).toBe('READY');
    expect(v.notApplicable).toEqual(['TRIGGER_LIFECYCLE']);
    expect(v.rows.find((r) => r.rowId === 'TRIGGER_LIFECYCLE')).toMatchObject({ verdict: 'NOT_APPLICABLE', reason: 'capability PROVIDER_PROTECTION disabled' });
    expect(v.missing).toEqual([]);
    expect(v.stale).toEqual([]);
    expect(v.failed).toEqual([]);
    expect(v.rows).toHaveLength(TINY_LIVE_ROW_SET.length);
    expect(verdictPermits(v, binding.releaseId!, addMs(T0, 60_000), DEFAULT_READINESS_POLICY)).toBe(true);
  });

  it('a missing, failed or expired required row is NOT_READY with the row named; the newest row per id wins', () => {
    const rows = allPass().filter((r) => r.rowId !== 'RECONCILIATION_CLEAN');
    expect(compute(rows)).toMatchObject({ verdict: 'NOT_READY', missing: ['RECONCILIATION_CLEAN'] });
    const failed = [...allPass(), row('RECONCILIATION_CLEAN', { verdict: 'FAIL', detail: { reason: 'MISMATCH' }, evaluatedAt: T0 })];
    const vf = compute(failed);
    expect(vf).toMatchObject({ verdict: 'NOT_READY', failed: ['RECONCILIATION_CLEAN'] });
    expect(vf.rows.find((r) => r.rowId === 'RECONCILIATION_CLEAN')).toMatchObject({ verdict: 'FAIL', reason: 'MISMATCH' });
    // an older PASS behind a newer FAIL does not rescue the row
    const older = [...failed, row('RECONCILIATION_CLEAN', { evaluatedAt: addMs(T0, -5_000) })];
    expect(compute(older).failed).toEqual(['RECONCILIATION_CLEAN']);
    // a computed row past its max age is stale
    const aged = allPass().map((r) => (r.rowId === 'CHAIN_HEALTH' ? { ...r, evaluatedAt: addMs(T0, -DEFAULT_READINESS_POLICY.computedRowMaxAgeMs - 1) } : r));
    const va = compute(aged);
    expect(va).toMatchObject({ verdict: 'NOT_READY', stale: ['CHAIN_HEALTH'] });
    expect(va.rows.find((r) => r.rowId === 'CHAIN_HEALTH')?.reason).toMatch(/^EXPIRED:/);
    // an explicit expiry is honoured too
    const expired = allPass().map((r) => (r.rowId === 'SIGNER_OUTAGE_DRILL' ? { ...r, expiresAt: addMs(T0, -1) } : r));
    expect(compute(expired).stale).toEqual(['SIGNER_OUTAGE_DRILL']);
  });

  it('a row bound to a different commit, contract digest, policy, wallet, cluster, profile or Release is stale and never counted', () => {
    const cases: Array<[string, Partial<ReadinessBinding>]> = [
      ['gitSha', { gitSha: 'abcdef2' }],
      ['contractSetDigest', { contractSetDigest: 'ef'.repeat(32) as Sha256Hex }],
      ['policy:risk', { policyDigests: { ...binding.policyDigests, risk: 'risk-v2' } }],
      ['policy:session', { policyDigests: { risk: 'risk-v1' } }],
      ['tradingWallet', { tradingWallet: null }],
      ['cluster', { cluster: 'devnet' }],
      ['profile', { profile: 'P3' }],
      ['release', { releaseDigest: 'ee'.repeat(32) as Sha256Hex }],
    ];
    for (const [label, over] of cases) {
      const rows = allPass().map((r) => (r.rowId === 'APPROVAL_BINDING_REPLAY' ? { ...r, binding: { ...binding, ...over } } : r));
      const v = compute(rows);
      // a profile mismatch is a different profile's row: it simply does not exist for this verdict
      if (label === 'profile') expect(v.missing, label).toEqual(['APPROVAL_BINDING_REPLAY']);
      else {
        expect(v.stale, label).toEqual(['APPROVAL_BINDING_REPLAY']);
        expect(v.rows.find((r) => r.rowId === 'APPROVAL_BINDING_REPLAY')?.reason, label).toBe(`STALE_BINDING:${label}`);
      }
    }
    // an image digest known on only one side is not a mismatch (single-host profiles carry none)
    expect(bindingMatches({ ...binding, imageDigest: 'sha256:1' }, binding)).toEqual([]);
    expect(bindingMatches({ ...binding, imageDigest: 'sha256:1' }, { ...binding, imageDigest: 'sha256:2' })).toEqual(['imageDigest']);
  });

  it('a recorded NOT_APPLICABLE is honoured only for a conditional row; enabling provider protection makes TRIGGER_LIFECYCLE required', () => {
    const optOut = [...allPass(), row('CREDENTIAL_ISOLATION', { verdict: 'NOT_APPLICABLE', evaluatedAt: T0 })];
    const v = compute(optOut);
    expect(v.failed).toEqual(['CREDENTIAL_ISOLATION']);
    expect(v.rows.find((r) => r.rowId === 'CREDENTIAL_ISOLATION')?.reason).toMatch(/unconditional/);
    const withProtection = compute(allPass(), { enabledCapabilities: ['LIVE_SIGNING', 'PROVIDER_PROTECTION'] });
    expect(withProtection).toMatchObject({ verdict: 'NOT_READY', missing: ['TRIGGER_LIFECYCLE'] });
    const recorded = compute([...allPass(), row('TRIGGER_LIFECYCLE', { verdict: 'PASS' })], { enabledCapabilities: ['LIVE_SIGNING', 'PROVIDER_PROTECTION'] });
    expect(recorded.verdict).toBe('READY');
  });

  it('rows of another strategy class never count, and a stored verdict permits arming only while READY, for the same Release and fresh', () => {
    const llm = allPass().map((r) => (r.rowId === 'INVARIANT_COVERAGE' ? { ...r, strategyClass: 'LLM' as const } : r));
    expect(compute(llm).missing).toEqual(['INVARIANT_COVERAGE']);
    const v = compute(allPass());
    expect(verdictPermits(v, binding.releaseId!, addMs(T0, DEFAULT_READINESS_POLICY.verdictMaxAgeMs + 1), DEFAULT_READINESS_POLICY)).toBe(false);
    expect(verdictPermits(v, fixtures.IDS.account as Uuid, T0, DEFAULT_READINESS_POLICY)).toBe(false);
    expect(verdictPermits(null, binding.releaseId!, T0, DEFAULT_READINESS_POLICY)).toBe(false);
    expect(verdictPermits({ ...v, verdict: 'NOT_READY' }, binding.releaseId!, T0, DEFAULT_READINESS_POLICY)).toBe(false);
  });
});
