import { addMs, DEFAULT_S0_SAFETY_GATE_POLICY, fixedClock, toInstant, type Candidate, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { s0StrategyVersion, type S0Decision } from '@sol-agent-trader/strategies';
import { runS0Cycle, type S0Repo } from './s0.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const logger = createLogger({ service: 'worker', sink: () => undefined });
const good: Record<string, number | null> = { ret_15m: 0.03, ret_1h: 0.08, rsi_14: 65, ema_9_over_21: 0.01, rel_volume_60: 3, liquidity_usd: 800_000, impact_bps_small: 30, sell_route_confirmed: 1 };
const snap = (n: number, features = good): FeatureSnapshot => ({ id: id(n), assetId: id(n + 50), asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v1' as FeatureSnapshot['featureEngineVersion'], provenance: 'LIVE', marketSnapshotId: null, features, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
const cand = (n: number): Candidate => ({ id: id(n + 100), assetId: id(n + 50), discoveredAt: addMs(NOW, -30_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'DETECTED', featureSnapshotId: id(n), eligibilityEvaluationId: id(200), expiresAt: addMs(NOW, 500_000), deterministicRejectionReason: null, dedupeKey: 'k', strategyVersionIds: [] });

describe('worker role s0', () => {
  it('decides RAW and SAFE per candidate, persists both together and moves the candidate by the SAFE outcome', async () => {
    const persisted: { candidateId: Uuid; decisions: S0Decision[]; status: string; reason: string | null }[] = [];
    const repo: S0Repo = {
      listAwaiting: async () => [
        { candidate: cand(1), snapshot: snap(1) },
        { candidate: cand(2), snapshot: snap(2, { ...good, rel_volume_60: 60 }) },
      ],
      persist: async (candidateId, decisions, status, reason) => {
        persisted.push({ candidateId, decisions, status, reason });
      },
    };
    const report = await runS0Cycle({ repo, clock: fixedClock(NOW), logger, strategies: { RAW: s0StrategyVersion('RAW', 'abcdef1', NOW), SAFE: s0StrategyVersion('SAFE', 'abcdef1', NOW) }, gatePolicy: DEFAULT_S0_SAFETY_GATE_POLICY, config: { batchSize: 10 } });
    expect(report).toMatchObject({ scanned: 2, cleared: 1, rejected: 1, rejectionsByCode: { VOLUME_ANOMALY: 1 }, errors: [] });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ candidateId: id(101), status: 'QUALIFIED', reason: null });
    expect(persisted[0]!.decisions.map((d) => [d.variant, d.cycle.state])).toEqual([['RAW', 'CLEARED'], ['SAFE', 'CLEARED']]);
    expect(persisted[1]).toMatchObject({ candidateId: id(102), status: 'REJECTED', reason: 'VOLUME_ANOMALY' });
    expect(persisted[1]!.decisions.map((d) => [d.variant, d.cycle.state])).toEqual([['RAW', 'CLEARED'], ['SAFE', 'REJECTED']]);
    // every persisted cycle carries its gate review; ids never collide across the pair
    const ids = persisted.flatMap((p) => p.decisions.flatMap((d) => [d.cycle.id, d.proposal.id, d.review.id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a persistence failure on one candidate is reported and does not stop the others', async () => {
    let n = 0;
    const repo: S0Repo = {
      listAwaiting: async () => [{ candidate: cand(1), snapshot: snap(1) }, { candidate: cand(2), snapshot: snap(2) }],
      persist: async () => {
        if (n++ === 0) throw new Error('candidate is no longer DETECTED');
      },
    };
    const report = await runS0Cycle({ repo, clock: fixedClock(NOW), logger, strategies: { RAW: s0StrategyVersion('RAW', 'abcdef1', NOW), SAFE: s0StrategyVersion('SAFE', 'abcdef1', NOW) }, gatePolicy: DEFAULT_S0_SAFETY_GATE_POLICY, config: { batchSize: 10 } });
    expect(report.errors).toEqual([{ candidateId: id(101), error: 'candidate is no longer DETECTED' }]);
    expect(report.cleared).toBe(1);
  });
});
