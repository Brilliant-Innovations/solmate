import fc from 'fast-check';
import { addMs, DEFAULT_S0_SAFETY_GATE_POLICY, S0_RAW_UNGATED_REASON, S0_STRATEGY_VERSION_IDS, toInstant, type Candidate, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { canAuthorize } from '@sol-agent-trader/agents';
import { decideS0, type S0DecisionInput } from './decide.js';
import { evaluateS0SafetyGate } from './gate.js';
import { s0StrategyVersion } from './versions.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const RAW = s0StrategyVersion('RAW', 'abcdef1', NOW);
const SAFE = s0StrategyVersion('SAFE', 'abcdef1', NOW);

const goodFeatures: Record<string, number | null> = { ret_5m: 0.01, ret_15m: 0.03, ret_1h: 0.08, atr_14_pct: 0.02, rsi_14: 65, ema_9_over_21: 0.01, rel_volume_60: 3, breakout_20: 1, liquidity_usd: 800_000, impact_bps_small: 30, sell_route_confirmed: 1 };
const snapshot = (over: Partial<FeatureSnapshot> = {}): FeatureSnapshot => ({
  id: id(1), assetId: id(2), asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v1' as FeatureSnapshot['featureEngineVersion'], provenance: 'LIVE', marketSnapshotId: null,
  features: goodFeatures, regime: 'RISK_ON_TREND', marketSessions: ['US'], selfInfluenceSuppressed: false, ...over,
});
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: id(3), assetId: id(2), discoveredAt: addMs(NOW, -30_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: { policyVersion: 'momentum-v1' }, scannerScore: 72, status: 'DETECTED',
  featureSnapshotId: id(1), eligibilityEvaluationId: id(4), expiresAt: addMs(NOW, 9 * 60_000), deterministicRejectionReason: null, dedupeKey: 'k', strategyVersionIds: [], ...over,
});
const input = (variant: 'RAW' | 'SAFE', over: Partial<S0DecisionInput> = {}): S0DecisionInput => ({
  variant, ids: { cycleId: id(10), proposalId: id(11), reviewId: id(12) }, candidate: candidate(), snapshot: snapshot(), strategy: variant === 'RAW' ? RAW : SAFE, gatePolicy: DEFAULT_S0_SAFETY_GATE_POLICY, now: NOW, ...over,
});

describe('S0 decisions as action cycles (§12.1, D30, M5a)', () => {
  it('a clean candidate clears SAFE with the deterministic gate recorded as the blocking adversary, and the cycle can feed authorization', () => {
    const d = decideS0(input('SAFE'));
    expect(d.cycle.state).toBe('CLEARED');
    expect(d.cycle.verdict).toBe('CONFIRM');
    expect(d.cycle.proposalId).toBe(id(11));
    expect(d.cycle.strategyVersionId).toBe(S0_STRATEGY_VERSION_IDS.SAFE);
    expect(d.review).toMatchObject({ deterministicGate: true, blocking: true, verdict: 'CONFIRM', objections: [], agentRunId: null });
    expect(d.proposal.source).toBe('DETERMINISTIC');
    expect(d.proposal.proposal.actionType).toBe('ENTER');
    expect(canAuthorize(d.cycle)).toBe(true);
  });

  it('a counter-signal rejects SAFE and the candidate never clears; RAW records the same objections informationally and clears', () => {
    const over = { snapshot: snapshot({ features: { ...goodFeatures, ret_1h: 0.6, rsi_14: 90 } }) };
    const safe = decideS0(input('SAFE', over));
    expect(safe.cycle.state).toBe('REJECTED');
    expect(safe.cycle.reasonCodes).toEqual(['OVEREXTENDED_1H', 'OVERBOUGHT']);
    expect(safe.review.verdict).toBe('REJECT');
    expect(canAuthorize(safe.cycle)).toBe(false);
    const raw = decideS0(input('RAW', over));
    expect(raw.cycle.state).toBe('CLEARED');
    expect(raw.cycle.reasonCodes).toEqual([S0_RAW_UNGATED_REASON, 'OVEREXTENDED_1H', 'OVERBOUGHT']);
    expect(raw.review).toMatchObject({ deterministicGate: true, blocking: false, verdict: 'CONFIRM' });
    expect(raw.review.objections.map((o) => o.code)).toEqual(['OVEREXTENDED_1H', 'OVERBOUGHT']);
    // RAW never holds live authority: bounded by its strategy version, checked by the authorizer in M7.
    expect(RAW.eligibleCapitalAuthorities).toEqual(['OBSERVE', 'PAPER']);
    expect(SAFE.adversaryPolicy.deterministicGate).toBe(true);
  });

  it('the gate fails closed on missing inputs, stale candidates or snapshots, self-influence, exit viability, regime and session', () => {
    const cases: [Partial<FeatureSnapshot> | null, Partial<Candidate> | null, string][] = [
      [{ features: { ...goodFeatures, rsi_14: null } }, null, 'FEATURE_MISSING'],
      [{ asOf: addMs(NOW, -10 * 60_000) }, null, 'FEATURES_STALE'],
      [null, { discoveredAt: addMs(NOW, -11 * 60_000) }, 'CANDIDATE_STALE'],
      [{ selfInfluenceSuppressed: true }, null, 'SELF_INFLUENCE_SUPPRESSED'],
      [{ features: { ...goodFeatures, sell_route_confirmed: 0 } }, null, 'SELL_ROUTE_UNCONFIRMED'],
      [{ features: { ...goodFeatures, impact_bps_small: 120 } }, null, 'EXIT_IMPACT_HIGH'],
      [{ features: { ...goodFeatures, liquidity_usd: 100_000 } }, null, 'LIQUIDITY_THIN'],
      [{ features: { ...goodFeatures, rel_volume_60: 40 } }, null, 'VOLUME_ANOMALY'],
      [{ regime: 'BROAD_SELLOFF' }, null, 'REGIME_BLOCKED'],
      [{ marketSessions: ['WEEKEND'] }, null, 'SESSION_BLOCKED'],
    ];
    for (const [s, c, code] of cases) {
      const r = evaluateS0SafetyGate({ candidate: candidate(c ?? {}), snapshot: snapshot(s ?? {}), policy: DEFAULT_S0_SAFETY_GATE_POLICY, now: NOW, cutoffVersion: 1 });
      expect(r.verdict, code).toBe('REJECT');
      expect(r.objections.map((o) => o.code), code).toContain(code);
    }
  });

  it('reconstruction: identical stored inputs reproduce the identical cycle, proposal and review (exit gate), and SAFE rejects exactly when the gate objects', () => {
    const feature = fc.option(fc.double({ min: -1, max: 100, noNaN: true }), { nil: null });
    fc.assert(
      fc.property(
        fc.record({ ret_1h: feature, rsi_14: feature, rel_volume_60: feature, impact_bps_small: feature, sell_route_confirmed: fc.constantFrom(0, 1, null), liquidity_usd: fc.option(fc.double({ min: 0, max: 5_000_000, noNaN: true }), { nil: null }) }),
        fc.boolean(),
        fc.constantFrom<'RAW' | 'SAFE'>('RAW', 'SAFE'),
        (features, suppressed, variant) => {
          const i = input(variant, { snapshot: snapshot({ features: { ...goodFeatures, ...features }, selfInfluenceSuppressed: suppressed }) });
          const a = decideS0(i);
          const b = decideS0(structuredClone(i));
          expect(b).toEqual(a);
          const objects = a.gate.objections.length > 0;
          if (variant === 'SAFE') expect(a.cycle.state).toBe(objects ? 'REJECTED' : 'CLEARED');
          else expect(a.cycle.state).toBe('CLEARED');
          expect(a.cycle.terminalAt).toBe(NOW);
          expect(a.proposal.proposal.evidenceCutoffVersion).toBe(1);
        },
      ),
    );
  });
});
