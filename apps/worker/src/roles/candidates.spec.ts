import { DEFAULT_CATALYST_TRIGGER_POLICY, DEFAULT_SMART_MONEY_TRIGGER_POLICY, DEFAULT_HYBRID_TRIGGER_POLICY, addMs, DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY, DEFAULT_ELIGIBILITY_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_SELF_INFLUENCE_POLICY, FEATURE_ENGINE_V1, fixedClock, toInstant, type AssetEligibility, type Candidate, type FeatureSnapshot, type Instant, type TriggerFamily, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import type { OwnFill } from '@sol-agent-trader/signals';
import { runCandidatesCycle, type CandidatesRepo } from './candidates.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
const A = '22222222-2222-4222-8222-222222222222' as Uuid;
const B = '33333333-3333-4333-8333-333333333333' as Uuid;
const ELIG = '55555555-5555-4555-8555-555555555555' as Uuid;

const warm = (over: Record<string, number | null> = {}): Record<string, number | null> => {
  const f: Record<string, number | null> = {};
  for (const name of Object.keys(FEATURE_ENGINE_V1.lookbackBuckets)) f[name] = 0;
  return { ...f, ret_15m: 0.04, rel_volume_60: 3, ema_9_over_21: 0.01, atr_14_pct: 0.02, rsi_14: 62, liquidity_usd: 500_000, impact_bps_small: 20, breakout_20: 1, sell_route_confirmed: 1, ret_1h: 0.05, ...over };
};
const snapshot = (assetId: Uuid, features: Record<string, number | null>): FeatureSnapshot => ({ id: `1111${assetId.slice(4)}` as Uuid, assetId, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
const eligible = (assetId: Uuid, over: Partial<AssetEligibility> = {}): AssetEligibility => ({ id: ELIG, assetId, evaluatedAt: NOW, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version, eligible: true, hardReject: false, rejectionReasons: [], grade: 100, ...over }) as unknown as AssetEligibility;

class MemoryRepo implements CandidatesRepo {
  candidates: Candidate[] = [];
  fills: OwnFill[] = [];
  sol: number | null = null;
  constructor(
    private readonly inputs: { snapshot: FeatureSnapshot; eligibilityEvaluationId: Uuid }[],
    private readonly records: Record<string, AssetEligibility | null>,
  ) {}
  async listScanInputs() {
    return this.inputs;
  }
  async latestEligibility(assetId: Uuid) {
    return this.records[assetId] ?? null;
  }
  async listOpenCandidates(assetId: Uuid, family: TriggerFamily) {
    return this.candidates.filter((c) => c.assetId === assetId && c.triggerFamily === family && ['DETECTED', 'ENRICHING', 'AGENT_REVIEW'].includes(c.status));
  }
  async lastTerminalCandidateAt(assetId: Uuid, family: TriggerFamily): Promise<Instant | null> {
    const t = this.candidates.filter((c) => c.assetId === assetId && c.triggerFamily === family && ['REJECTED', 'EXPIRED'].includes(c.status)).map((c) => c.discoveredAt);
    return t.length ? (t.sort().at(-1) as Instant) : null;
  }
  async insertCandidate(c: Candidate) {
    this.candidates.push(c);
  }
  async expireCandidates(now: Instant) {
    let n = 0;
    for (const c of this.candidates) if (c.status === 'DETECTED' && c.expiresAt <= now) {
      c.status = 'EXPIRED';
      n++;
    }
    return n;
  }
  async recentOwnFills() {
    return this.fills;
  }
  async listOwnedAddresses() {
    return [];
  }
  async solReturn1h() {
    return this.sol;
  }
  async visibleEvents() {
    return [];
  }
  async smartMoneyFlow() {
    return null;
  }
  async recentFamilySignals() {
    return [];
  }
}
const deps = (repo: MemoryRepo, now = NOW) => ({ repo, clock: fixedClock(now), logger: createLogger({ service: 'worker', sink: () => undefined }), spec: FEATURE_ENGINE_V1, trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY, earlyAcceleration: DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY, catalyst: DEFAULT_CATALYST_TRIGGER_POLICY, smartMoney: DEFAULT_SMART_MONEY_TRIGGER_POLICY, hybrid: DEFAULT_HYBRID_TRIGGER_POLICY, eligibility: DEFAULT_ELIGIBILITY_POLICY, selfInfluence: DEFAULT_SELF_INFLUENCE_POLICY, config: { batchSize: 100 } });

describe('candidates role (§6.9, §9.1, §9.7, INV-03, INV-11)', () => {
  it('detects on a warm eligible asset, skips a cold one, and never raises the same move twice inside the dedupe window', async () => {
    const repo = new MemoryRepo([{ snapshot: snapshot(A, warm()), eligibilityEvaluationId: ELIG }, { snapshot: snapshot(B, warm({ rsi_14: null })), eligibilityEvaluationId: ELIG }], { [A]: eligible(A), [B]: eligible(B) });
    const r = await runCandidatesCycle(deps(repo));
    // the other four families see the same warm asset and decline it (already broken out; no events, flow or aligned signals): four NO_TRIGGER
    expect(r).toMatchObject({ scanned: 2, detected: 1, rejected: 0, skipped: { FEATURES_COLD: 1, NO_TRIGGER: 4, DEDUPED: 0, COOLDOWN: 0 }, byFamily: { MOMENTUM_CONTINUATION: { detected: 1, rejected: 0 }, EARLY_ACCELERATION: { detected: 0, rejected: 0 } }, errors: [] });
    expect(repo.candidates[0]).toMatchObject({ assetId: A, status: 'DETECTED', eligibilityEvaluationId: ELIG, featureSnapshotId: snapshot(A, {}).id });
    const r2 = await runCandidatesCycle(deps(repo, addMs(NOW, 60_000)));
    expect(r2.skipped.DEDUPED).toBe(1);
    expect(repo.candidates).toHaveLength(1);
  });

  it('INV-03: a stale or missing eligibility record turns a fired trigger into a REJECTED candidate with the gate reason; expiry and cooldown follow', async () => {
    const repo = new MemoryRepo([{ snapshot: snapshot(A, warm()), eligibilityEvaluationId: ELIG }, { snapshot: snapshot(B, warm()), eligibilityEvaluationId: ELIG }], { [A]: eligible(A, { evaluatedAt: addMs(NOW, -2 * DEFAULT_ELIGIBILITY_POLICY.maxEligibilityAgeMs) }), [B]: null });
    const r = await runCandidatesCycle(deps(repo));
    expect(r).toMatchObject({ detected: 0, rejected: 2 });
    expect(repo.candidates.map((c) => c.deterministicRejectionReason).sort()).toEqual(['ELIGIBILITY_STALE', 'NO_ELIGIBILITY_RECORD']);
    // Cooldown after a rejection: the same setup does not come back immediately.
    const r2 = await runCandidatesCycle(deps(repo, addMs(NOW, 60_000)));
    expect(r2.skipped.COOLDOWN).toBe(2);
    // A detected candidate past its TTL is expired at the start of the next cycle.
    const fresh = new MemoryRepo([{ snapshot: snapshot(A, warm()), eligibilityEvaluationId: ELIG }], { [A]: eligible(A) });
    await runCandidatesCycle(deps(fresh));
    const later = addMs(NOW, DEFAULT_MOMENTUM_TRIGGER_POLICY.candidateTtlMs + 1);
    const r3 = await runCandidatesCycle(deps(fresh, later));
    expect(r3.expired).toBe(1);
    expect(fresh.candidates[0]!.status).toBe('EXPIRED');
  });

  it('INV-11: our own recent fill in the asset suppresses the aggregate-metric trigger, recorded as a REJECTED candidate', async () => {
    const repo = new MemoryRepo([{ snapshot: snapshot(A, warm()), eligibilityEvaluationId: ELIG }], { [A]: eligible(A) });
    repo.fills = [{ assetId: A, signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as never, filledAt: addMs(NOW, -60_000), estimatedImpactBps: 30 as never }];
    const r = await runCandidatesCycle(deps(repo));
    expect(r).toMatchObject({ detected: 0, rejected: 1 });
    expect(repo.candidates[0]!.deterministicRejectionReason).toBe('SELF_TRADE_SUPPRESSION_WINDOW');
  });

  it('relative strength versus SOL is applied when a SOL return exists and the asset lags SOL', async () => {
    const repo = new MemoryRepo([{ snapshot: snapshot(A, warm({ ret_1h: 0.01 })), eligibilityEvaluationId: ELIG }], { [A]: eligible(A) });
    repo.sol = 0.05;
    const r = await runCandidatesCycle(deps(repo));
    expect(r.skipped.NO_TRIGGER).toBe(5); // no family fires on an asset that lags SOL (five families scanned)
  });
});
