import fc from 'fast-check';
import { DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY, FEATURE_ENGINE_V2, toInstant, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { evaluateEarlyAccelerationTrigger } from './early-acceleration.js';
import { detectEarlyAccelerationCandidate, detectMomentumCandidate, type DetectorContext } from '../candidates/detector.js';
import { DEFAULT_MOMENTUM_TRIGGER_POLICY } from '@sol-agent-trader/contracts';

const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as Uuid;
const policy = DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY;

/** A pre-breakout setup: slope and flow rising, price still inside the band, no breakout yet. */
const early = (over: Record<string, number | null> = {}): Record<string, number | null> => {
  const f: Record<string, number | null> = {};
  for (const name of Object.keys(FEATURE_ENGINE_V2.lookbackBuckets)) f[name] = 0;
  return { ...f, ret_accel_5m: 0.02, ret_15m: 0.012, volume_accel_15: 1.2, trade_count_accel_15: 0.8, ema_9_over_21: 0.002, trend_persistence_20: 0.5, breakout_20: 0, bb_location_20: 0.7, atr_14_pct: 0.015, rsi_14: 58, liquidity_usd: 600_000, impact_bps_small: 25, sell_route_confirmed: 1, rel_volume_60: 1.4, ...over };
};
const snapshot = (features: Record<string, number | null>): FeatureSnapshot => ({ id: newId(), assetId: ASSET, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v2' as never, provenance: 'LIVE', marketSnapshotId: null, features, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
const context = (features: Record<string, number | null>, over: Partial<DetectorContext> = {}): DetectorContext => ({
  newId, now: NOW, snapshot: snapshot(features), spec: FEATURE_ENGINE_V2, solRelativeReturn1h: 0.005,
  entryGate: { allowed: true, reason: null, eligibilityEvaluationId: newId() }, selfInfluence: { isOwned: () => false, ownSignatures: new Set(), windows: [], now: NOW },
  openCandidates: [], lastTerminalAt: null, ...over,
});

describe('early-acceleration trigger (§9.2) and its candidate', () => {
  it('fires on rising slope and flow before the breakout with an explainable score, and becomes an EARLY_ACCELERATION candidate labelled with its inputs', () => {
    const e = evaluateEarlyAccelerationTrigger({ features: early() }, policy, 0.005);
    expect(e.fires).toBe(true);
    expect(e.failed).toEqual([]);
    expect(e.passed).toEqual(['RETURN_ACCELERATING', 'VOLUME_ACCELERATING', 'TRADE_COUNT_ACCELERATING', 'TREND_TURNING', 'PERSISTENCE', 'PRE_BREAKOUT', 'NOT_AT_UPPER_BAND', 'NOT_EXTENDED', 'RSI_ROOM', 'LIQUIDITY', 'EXECUTABLE', 'RELATIVE_STRENGTH']);
    expect(e.score).toBeGreaterThanOrEqual(policy.minScannerScore);
    const d = detectEarlyAccelerationCandidate({ ...context(early()), policy });
    expect(d.kind).toBe('CANDIDATE');
    if (d.kind !== 'CANDIDATE') return;
    expect(d.candidate).toMatchObject({ triggerFamily: 'EARLY_ACCELERATION', status: 'DETECTED', scannerScore: e.score });
    expect(d.candidate.triggerDetails).toMatchObject({ policyVersion: policy.version, passed: e.passed, marketSessions: ['US'] });
    // the same setup is not a momentum-continuation candidate: it has not broken out or run 2 % yet
    expect(detectMomentumCandidate({ ...context(early()), policy: DEFAULT_MOMENTUM_TRIGGER_POLICY }).kind).toBe('SKIP');
  });

  it('each §9.2 condition holds: a breakout already made, price at the upper band, exhausted RSI, extension, thin liquidity, unexecutable, decelerating or cold inputs do not fire; absent trade counts are optional evidence', () => {
    const cases: [Record<string, number | null>, string][] = [
      [{ breakout_20: 1 }, 'PRE_BREAKOUT'],
      [{ bb_location_20: 0.97 }, 'NOT_AT_UPPER_BAND'],
      [{ rsi_14: 80 }, 'RSI_ROOM'],
      [{ ret_15m: 0.06 }, 'NOT_EXTENDED'],
      [{ liquidity_usd: 50_000 }, 'LIQUIDITY'],
      [{ impact_bps_small: 300 }, 'EXECUTABLE'],
      [{ ret_accel_5m: -0.01 }, 'RETURN_ACCELERATING'],
      [{ volume_accel_15: 0.1 }, 'VOLUME_ACCELERATING'],
      [{ trend_persistence_20: -0.2 }, 'PERSISTENCE'],
      [{ ema_9_over_21: -0.05 }, 'TREND_TURNING'],
      [{ volume_accel_15: null }, 'VOLUME_ACCELERATING'],
    ];
    for (const [over, condition] of cases) {
      const e = evaluateEarlyAccelerationTrigger({ features: early(over) }, policy, 0.005);
      expect(e.fires, condition).toBe(false);
      expect(e.failed.map((f) => f.condition), condition).toContain(condition);
    }
    const noCounts = evaluateEarlyAccelerationTrigger({ features: early({ trade_count_accel_15: null }) }, policy, null);
    expect(noCounts.fires).toBe(true);
    expect(noCounts.passed).not.toContain('TRADE_COUNT_ACCELERATING');
    expect(noCounts.passed).not.toContain('RELATIVE_STRENGTH');
  });

  it('§9.7: an open candidate of another family inside the window aggregates the move, and a recent terminal candidate of this family cools it down', () => {
    const deduped = detectEarlyAccelerationCandidate({ ...context(early(), { openCandidates: [{ dedupeKey: `${ASSET}:MOMENTUM_CONTINUATION:1`, discoveredAt: NOW }] }), policy });
    expect(deduped).toMatchObject({ kind: 'SKIP', reason: 'DEDUPED' });
    const cooled = detectEarlyAccelerationCandidate({ ...context(early(), { lastTerminalAt: NOW }), policy });
    expect(cooled).toMatchObject({ kind: 'SKIP', reason: 'COOLDOWN' });
  });

  it('property: deterministic in its inputs, never fires with a cold required input, score within [50, 100] when it fires and monotone in return acceleration', () => {
    fc.assert(
      fc.property(fc.double({ min: -0.05, max: 0.1, noNaN: true }), fc.double({ min: -0.5, max: 3, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (accel, vol, bb) => {
        const f = early({ ret_accel_5m: accel, volume_accel_15: vol, bb_location_20: bb });
        const a = evaluateEarlyAccelerationTrigger({ features: f }, policy, null);
        const b = evaluateEarlyAccelerationTrigger({ features: { ...f } }, policy, null);
        expect(b).toEqual(a);
        if (a.fires) expect(a.score >= 50 && a.score <= 100).toBe(true);
        const higher = evaluateEarlyAccelerationTrigger({ features: early({ ret_accel_5m: accel + 0.01, volume_accel_15: vol, bb_location_20: bb }) }, policy, null);
        if (a.fires && higher.fires) expect(higher.score).toBeGreaterThanOrEqual(a.score);
        expect(evaluateEarlyAccelerationTrigger({ features: early({ ret_accel_5m: null }) }, policy, null).fires).toBe(false);
      }),
    );
  });
});
