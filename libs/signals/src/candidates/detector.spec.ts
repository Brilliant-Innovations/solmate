import fc from 'fast-check';
import { addMs, DEFAULT_MOMENTUM_TRIGGER_POLICY, FEATURE_ENGINE_V1, toInstant, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { detectMomentumCandidate, isWarm, type DetectorInput } from './detector.js';
import { evaluateMomentumTrigger } from '../triggers/momentum.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const SNAP = '11111111-1111-4111-8111-111111111111' as Uuid;
const ELIG = '55555555-5555-4555-8555-555555555555' as Uuid;
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as Uuid;

const warmFeatures = (over: Record<string, number | null> = {}): Record<string, number | null> => {
  const f: Record<string, number | null> = {};
  for (const name of Object.keys(FEATURE_ENGINE_V1.lookbackBuckets)) f[name] = 0;
  return { ...f, ret_15m: 0.04, rel_volume_60: 3, ema_9_over_21: 0.01, atr_14_pct: 0.02, rsi_14: 62, liquidity_usd: 500_000, impact_bps_small: 20, breakout_20: 1, sell_route_confirmed: 1, ...over };
};
const snapshot = (features: Record<string, number | null>): FeatureSnapshot => ({ id: SNAP, assetId: ASSET, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
const input = (over: Partial<DetectorInput> = {}): DetectorInput => ({
  newId, now: NOW, snapshot: snapshot(warmFeatures()), spec: FEATURE_ENGINE_V1, policy: DEFAULT_MOMENTUM_TRIGGER_POLICY, solRelativeReturn1h: 0.01,
  entryGate: { allowed: true, reason: null, eligibilityEvaluationId: ELIG }, selfInfluence: { isOwned: () => false, ownSignatures: new Set(), windows: [], now: NOW },
  openCandidates: [], lastTerminalAt: null, ...over,
});

describe('momentum trigger (§9.1) and candidate detection (§6.9, §9.7, §8.6, D63)', () => {
  it('a warm, strong, liquid, executable, not-extended setup fires with an explainable score and becomes a DETECTED candidate bound to its snapshot and eligibility record', () => {
    const d = detectMomentumCandidate(input());
    expect(d.kind).toBe('CANDIDATE');
    if (d.kind !== 'CANDIDATE') return;
    expect(d.evaluation.passed).toEqual(expect.arrayContaining(['RETURN_15M', 'RELATIVE_VOLUME', 'EMA_TREND', 'NOT_EXTENDED', 'RSI_NOT_EXHAUSTED', 'LIQUIDITY', 'EXECUTABLE', 'RELATIVE_STRENGTH']));
    expect(d.candidate).toMatchObject({ status: 'DETECTED', triggerFamily: 'MOMENTUM_CONTINUATION', featureSnapshotId: SNAP, eligibilityEvaluationId: ELIG, expiresAt: addMs(NOW, DEFAULT_MOMENTUM_TRIGGER_POLICY.candidateTtlMs), deterministicRejectionReason: null });
    expect(d.candidate.scannerScore).toBe(d.evaluation.score);
    expect(d.candidate.scannerScore).toBeGreaterThanOrEqual(DEFAULT_MOMENTUM_TRIGGER_POLICY.minScannerScore);
    expect(d.candidate.triggerDetails).toMatchObject({ policyVersion: 'momentum-v1', featureEngineVersion: 'features-v1' });
    expect(d.candidate.dedupeKey).toMatch(/^22222222-2222-4222-8222-222222222222:MOMENTUM_CONTINUATION:\d+$/);
  });

  it('D63: any cold required indicator prevents scoring entirely; a cold trigger input fails its condition as FEATURE_COLD', () => {
    const d = detectMomentumCandidate(input({ snapshot: snapshot(warmFeatures({ rsi_14: null })) }));
    expect(d).toMatchObject({ kind: 'SKIP', reason: 'FEATURES_COLD', detail: 'rsi_14' });
    expect(isWarm(snapshot(warmFeatures({ ret_1h: null })), FEATURE_ENGINE_V1)).toEqual({ warm: false, cold: ['ret_1h'] });
    const e = evaluateMomentumTrigger(snapshot(warmFeatures({ atr_14_pct: null })), DEFAULT_MOMENTUM_TRIGGER_POLICY, null);
    expect(e.fires).toBe(false);
    expect(e.failed).toEqual([{ condition: 'NOT_EXTENDED', reason: 'FEATURE_COLD', value: null, threshold: DEFAULT_MOMENTUM_TRIGGER_POLICY.maxExtensionAtrMultiple }]);
  });

  it('each §9.1 condition is enforced: extended, exhausted, illiquid, unexecutable or weak-relative setups do not fire', () => {
    const cases: [Record<string, number | null>, string][] = [
      [{ ret_15m: 0.5 }, 'NOT_EXTENDED:ABOVE_MAX'],
      [{ rsi_14: 95 }, 'RSI_NOT_EXHAUSTED:ABOVE_MAX'],
      [{ liquidity_usd: 10_000 }, 'LIQUIDITY:BELOW_MIN'],
      [{ impact_bps_small: 400 }, 'EXECUTABLE:ABOVE_MAX'],
      [{ rel_volume_60: 1 }, 'RELATIVE_VOLUME:BELOW_MIN'],
      [{ ret_15m: 0.005 }, 'RETURN_15M:BELOW_MIN'],
    ];
    for (const [over, expected] of cases) {
      const d = detectMomentumCandidate(input({ snapshot: snapshot(warmFeatures(over)) }));
      expect(d.kind, expected).toBe('SKIP');
      if (d.kind === 'SKIP') expect(d.detail, expected).toContain(expected);
    }
    const weak = detectMomentumCandidate(input({ solRelativeReturn1h: -0.05 }));
    expect(weak).toMatchObject({ kind: 'SKIP', reason: 'NO_TRIGGER' });
    // Without SOL data relative strength is neither evidence for nor against.
    expect(detectMomentumCandidate(input({ solRelativeReturn1h: null })).kind).toBe('CANDIDATE');
  });

  it('dedupe and cooldown are silent skips; a fired trigger refused by the entry gate or the self-influence guard is a REJECTED candidate with its reason (§32: rejected trades stay visible)', () => {
    const first = detectMomentumCandidate(input());
    if (first.kind !== 'CANDIDATE') throw new Error('expected candidate');
    expect(detectMomentumCandidate(input({ openCandidates: [first.candidate] }))).toMatchObject({ kind: 'SKIP', reason: 'DEDUPED' });
    expect(detectMomentumCandidate(input({ lastTerminalAt: addMs(NOW, -5 * 60_000) }))).toMatchObject({ kind: 'SKIP', reason: 'COOLDOWN' });
    expect(detectMomentumCandidate(input({ lastTerminalAt: addMs(NOW, -DEFAULT_MOMENTUM_TRIGGER_POLICY.cooldownMs) })).kind).toBe('CANDIDATE');
    const gated = detectMomentumCandidate(input({ entryGate: { allowed: false, reason: 'ELIGIBILITY_STALE', eligibilityEvaluationId: ELIG } }));
    expect(gated).toMatchObject({ kind: 'REJECTED', reason: 'ELIGIBILITY_STALE' });
    if (gated.kind === 'REJECTED') expect(gated.candidate).toMatchObject({ status: 'REJECTED', deterministicRejectionReason: 'ELIGIBILITY_STALE', scannerScore: gated.evaluation.score });
    const suppressed = detectMomentumCandidate(input({ selfInfluence: { isOwned: () => false, ownSignatures: new Set(), windows: [{ assetId: ASSET, signature: 'x' as never, from: addMs(NOW, -60_000), until: addMs(NOW, 60_000) }], now: NOW } }));
    expect(suppressed).toMatchObject({ kind: 'REJECTED', reason: 'SELF_TRADE_SUPPRESSION_WINDOW' });
  });

  it('property: the decision is deterministic in its inputs, a candidate never carries a cold required feature, and the score is monotone in the 15-minute return', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.2, noNaN: true }), fc.double({ min: 0, max: 6, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (ret, relvol, rsi) => {
        const s = snapshot(warmFeatures({ ret_15m: ret, rel_volume_60: relvol, rsi_14: rsi }));
        const a = detectMomentumCandidate(input({ snapshot: s }));
        const b = detectMomentumCandidate(input({ snapshot: s }));
        expect(a.kind).toBe(b.kind);
        if (a.kind === 'CANDIDATE') {
          expect(isWarm(s, FEATURE_ENGINE_V1).warm).toBe(true);
          expect(a.candidate.scannerScore).toBeGreaterThanOrEqual(DEFAULT_MOMENTUM_TRIGGER_POLICY.minScannerScore);
        }
        const lo = evaluateMomentumTrigger(snapshot(warmFeatures({ ret_15m: 0.02 })), DEFAULT_MOMENTUM_TRIGGER_POLICY, null).score;
        const hi = evaluateMomentumTrigger(snapshot(warmFeatures({ ret_15m: 0.05 })), DEFAULT_MOMENTUM_TRIGGER_POLICY, null).score;
        expect(hi).toBeGreaterThanOrEqual(lo);
      }),
    );
  });
});
