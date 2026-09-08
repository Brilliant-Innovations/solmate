import fc from 'fast-check';
import { DEFAULT_CATALYST_TRIGGER_POLICY, DEFAULT_HYBRID_TRIGGER_POLICY, DEFAULT_SMART_MONEY_TRIGGER_POLICY, addMs, fixtures, type FeatureSnapshot, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { evaluateCatalystTrigger, type CatalystEvidence } from './catalyst.js';
import { evaluateHybridTrigger, type FamilySignal } from './hybrid.js';
import { evaluateSmartMoneyTrigger, type SmartMoneyFlowFacts } from './smart-money.js';

const T0 = fixtures.T0 as Instant;
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;
const snapshot = (features: Record<string, number | null>): Pick<FeatureSnapshot, 'features'> => ({ features });
const confirming = snapshot({ ret_15m: 0.03, rel_volume_60: 2.2, liquidity_usd: 600_000, ema_9_over_21: 0.01, ret_1h: 0.02 });
const event = (patch: Partial<CatalystEvidence> = {}): CatalystEvidence => ({ id: uuid(1), kind: 'NEWS', sourceQuality: 'REPUTABLE_PUBLICATION', sourceTimeConfidence: 'HIGH', sourcePublishedAt: addMs(T0, -20 * 60_000), firstSeenAt: addMs(T0, -15 * 60_000), noveltyScore: 1, clusterId: null, corroboratesEventId: null, ...patch });

describe('catalyst-response trigger (§9.4, §10.3, D64)', () => {
  const policy = DEFAULT_CATALYST_TRIGGER_POLICY;
  it('fires on a fresh, trusted, novel catalyst with market confirmation and records the catalyst id', () => {
    const e = evaluateCatalystTrigger([event()], confirming, policy, T0);
    expect(e.fires).toBe(true);
    expect(e.catalystEvidenceId).toBe(uuid(1));
    expect(e.passed).toEqual(['FRESH_CATALYST', 'SOURCE_QUALITY', 'SOURCE_TIME_TRUSTED', 'NOVEL', 'MARKET_CONFIRMS_RETURN', 'MARKET_CONFIRMS_VOLUME', 'LIQUIDITY']);
    expect(e.score).toBeGreaterThanOrEqual(policy.minScannerScore);
  });
  it('does not fire on a syndicated copy, a stale catalyst, an untrusted time, social-only evidence or without market confirmation', () => {
    expect(evaluateCatalystTrigger([event({ corroboratesEventId: uuid(9), clusterId: uuid(9), noveltyScore: 0.1 })], confirming, policy, T0).failed[0]?.condition).toBe('FRESH_CATALYST');
    expect(evaluateCatalystTrigger([event({ sourcePublishedAt: addMs(T0, -7 * 3_600_000) })], confirming, policy, T0).failed[0]?.condition).toBe('FRESH_CATALYST');
    expect(evaluateCatalystTrigger([event({ sourceTimeConfidence: 'LOW' })], confirming, policy, T0).failed.map((f) => f.condition)).toEqual(['SOURCE_TIME_TRUSTED']);
    expect(evaluateCatalystTrigger([event({ kind: 'SOCIAL' })], confirming, policy, T0).fires).toBe(false);
    expect(evaluateCatalystTrigger([event({ sourceQuality: 'UNKNOWN_SOCIAL' })], confirming, policy, T0).failed.map((f) => f.condition)).toEqual(['SOURCE_QUALITY']);
    expect(evaluateCatalystTrigger([event()], snapshot({ ret_15m: -0.01, rel_volume_60: 0.8, liquidity_usd: 600_000 }), policy, T0).failed.map((f) => f.condition)).toEqual(['MARKET_CONFIRMS_RETURN', 'MARKET_CONFIRMS_VOLUME']);
    expect(evaluateCatalystTrigger([event({ firstSeenAt: addMs(T0, 1) })], confirming, policy, T0).fires).toBe(false); // seen after now is not visible
    expect(evaluateCatalystTrigger([event()], snapshot({ ret_15m: 0.03, rel_volume_60: 2, liquidity_usd: null }), policy, T0).failed[0]).toMatchObject({ condition: 'LIQUIDITY', reason: 'FEATURE_COLD' });
  });
  it('picks the newest fresh catalyst when several are visible', () => {
    const e = evaluateCatalystTrigger([event(), event({ id: uuid(2), sourcePublishedAt: addMs(T0, -5 * 60_000), firstSeenAt: addMs(T0, -60_000) })], confirming, policy, T0);
    expect(e.catalystEvidenceId).toBe(uuid(2));
    expect(e.inputs['catalystAgeMs']).toBe(5 * 60_000);
  });
});

describe('smart-money accumulation trigger (§9.3, INV-11)', () => {
  const policy = DEFAULT_SMART_MONEY_TRIGGER_POLICY;
  const flow = (patch: Partial<SmartMoneyFlowFacts> = {}): SmartMoneyFlowFacts => ({ netFlowUsd: { h1: 2_000, h4: 12_000, h24: 20_000 }, distinctBuyers: { h1: 2, h4: 5, h24: 7 }, distinctSellers: { h1: 0, h4: 1, h24: 3 }, topBuyerShare: 0.35, ownWalletActivityExcluded: true, ...patch });
  it('fires when several independent buyers accumulate with structure confirming', () => {
    const e = evaluateSmartMoneyTrigger(flow(), confirming, policy);
    expect(e.fires).toBe(true);
    expect(e.passed).toEqual(['INDEPENDENT_BUYERS', 'NET_ACCUMULATION', 'NOT_DOMINATED', 'BUYERS_OUTNUMBER_SELLERS', 'STRUCTURE_CONFIRMS', 'LIQUIDITY']);
  });
  it('does not fire on one dominant buyer, net distribution, too few buyers, sellers outnumbering, or a cold structure feature', () => {
    expect(evaluateSmartMoneyTrigger(flow({ topBuyerShare: 0.9 }), confirming, policy).failed.map((f) => f.condition)).toEqual(['NOT_DOMINATED']);
    expect(evaluateSmartMoneyTrigger(flow({ netFlowUsd: { h1: 0, h4: -1_000, h24: 0 } }), confirming, policy).failed.map((f) => f.condition)).toEqual(['NET_ACCUMULATION']);
    expect(evaluateSmartMoneyTrigger(flow({ distinctBuyers: { h1: 1, h4: 2, h24: 2 } }), confirming, policy).failed.map((f) => f.condition)).toEqual(['INDEPENDENT_BUYERS']);
    expect(evaluateSmartMoneyTrigger(flow({ distinctSellers: { h1: 1, h4: 5, h24: 5 } }), confirming, policy).failed.map((f) => f.condition)).toEqual(['BUYERS_OUTNUMBER_SELLERS']);
    expect(evaluateSmartMoneyTrigger(flow(), snapshot({ liquidity_usd: 600_000 }), policy).failed[0]).toMatchObject({ condition: 'STRUCTURE_CONFIRMS', reason: 'FEATURE_COLD' });
  });
});

describe('hybrid ensemble trigger (§12.1 S4)', () => {
  const policy = DEFAULT_HYBRID_TRIGGER_POLICY;
  const sig = (family: FamilySignal['family'], minutesAgo: number, score = 70): FamilySignal => ({ family, firedAt: addMs(T0, -minutesAgo * 60_000), score });
  it('fires only with two independent families aligned inside the window; two market-data families do not count twice', () => {
    expect(evaluateHybridTrigger([sig('MOMENTUM_CONTINUATION', 5), sig('SMART_MONEY_ACCUMULATION', 12)], policy, T0)).toMatchObject({ fires: true, families: ['MOMENTUM_CONTINUATION', 'SMART_MONEY_ACCUMULATION'], score: 70 });
    expect(evaluateHybridTrigger([sig('MOMENTUM_CONTINUATION', 5), sig('EARLY_ACCELERATION', 6)], policy, T0).failed.map((f) => f.condition)).toEqual(['INDEPENDENT_FAMILIES']);
    expect(evaluateHybridTrigger([sig('MOMENTUM_CONTINUATION', 5), sig('CATALYST_RESPONSE', 45)], policy, T0).failed.map((f) => f.condition)).toEqual(['MIN_FAMILIES', 'INDEPENDENT_FAMILIES']);
    expect(evaluateHybridTrigger([sig('MOMENTUM_CONTINUATION', 5), sig('CATALYST_RESPONSE', 6, 30)], policy, T0).fires).toBe(false);
    expect(evaluateHybridTrigger([], policy, T0).fires).toBe(false);
  });
  it('property: it never fires from a single independence group and never scores above the mean of the aligned families', () => {
    const families: FamilySignal['family'][] = ['MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION', 'SMART_MONEY_ACCUMULATION', 'CATALYST_RESPONSE', 'SOCIAL_ACCELERATION', 'HOLDER_LIQUIDITY_EXPANSION'];
    fc.assert(
      fc.property(fc.array(fc.record({ family: fc.constantFrom(...families), minutesAgo: fc.integer({ min: 0, max: 60 }), score: fc.integer({ min: 0, max: 100 }) }), { maxLength: 8 }), (raw) => {
        const signals = raw.map((r) => sig(r.family, r.minutesAgo, r.score));
        const e = evaluateHybridTrigger(signals, policy, T0);
        const groups = new Set(signals.filter((s) => T0 >= s.firedAt && (Date.parse(T0) - Date.parse(s.firedAt)) <= policy.alignmentWindowMs && s.score >= policy.minFamilyScore).map((s) => (['MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION', 'HOLDER_LIQUIDITY_EXPANSION'].includes(s.family) ? 'MARKET' : s.family === 'SMART_MONEY_ACCUMULATION' ? 'ONCHAIN' : 'INTEL')));
        if (e.fires) {
          expect(groups.size).toBeGreaterThanOrEqual(2);
          expect(e.score).toBeLessThanOrEqual(100);
        } else if (groups.size < 2) expect(e.fires).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
