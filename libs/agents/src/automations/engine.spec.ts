import fc from 'fast-check';
import { AutomationRunDisposition, AutomationTriggerType, DEFAULT_AUTOMATION_SET, AutomationSet, addMs, fixtures, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { decideAutomation, evaluatePositionTriggers, pickTrigger, protectionOnlyBackoffMs, type PositionTriggerFacts, type RuntimeFacts, type TargetHistory, type TriggerEvent } from './engine.js';

const T0 = fixtures.T0 as Instant;
const POS = fixtures.IDS.position as Uuid;
const set = AutomationSet.parse(DEFAULT_AUTOMATION_SET);
const fresh = (): TargetHistory => ({ lastFiredAt: null, lastFiredByType: {}, cycleInFlight: false, reviewState: null, consecutiveUnresolved: 0 });
const active: RuntimeFacts = { capitalAuthority: 'PAPER', activityState: 'ACTIVE', spendGate: { ok: true, checked: 1 } };
const ev = (type: TriggerEvent['type'], at = T0): TriggerEvent => ({ type, targetId: POS, at, details: {} });

describe('automation engine (§11.7, D39, D43)', () => {
  it('pins automations-v1: one enabled rule per required trigger type, all modes, tier heartbeats', () => {
    expect(set.version).toBe('automations-v1');
    expect(set.rules.map((r) => r.triggerType).sort()).toEqual([...AutomationTriggerType.options].sort());
    expect(set.rules.every((r) => r.enabled && r.enabledModes.length === 4)).toBe(true);
    expect(set.heartbeatMsByTier).toEqual({ T0_FAST: 300_000, T1_MOMENTUM: 600_000, T2_CONTEXTUAL: 1_800_000, T3_CATALYST: 7_200_000 });
    expect(AutomationRunDisposition.options).toEqual(['INVOKED', 'SKIPPED_COOLDOWN', 'SKIPPED_BUDGET', 'SKIPPED_MODE', 'SKIPPED_ACTIVITY_STATE', 'ERROR']);
  });

  it('invokes a fresh target, then enforces cooldown, per-type interval, one cycle at a time, mode, activity and budget gates', () => {
    const first = decideAutomation(set, ev('REASSESSMENT_HEARTBEAT'), fresh(), active);
    expect(first).toMatchObject({ disposition: 'INVOKED', rule: { name: 'position-heartbeat' }, nextEligibleAt: addMs(T0, 600_000) });
    const fired: TargetHistory = { ...fresh(), lastFiredAt: T0, lastFiredByType: { REASSESSMENT_HEARTBEAT: T0 } };
    expect(decideAutomation(set, ev('PRICE_EXCURSION', addMs(T0, 60_000)), fired, active)).toMatchObject({ disposition: 'SKIPPED_COOLDOWN', nextEligibleAt: addMs(T0, 120_000) });
    expect(decideAutomation(set, ev('PRICE_EXCURSION', addMs(T0, 120_000)), fired, active)).toMatchObject({ disposition: 'INVOKED' });
    expect(decideAutomation(set, ev('REASSESSMENT_HEARTBEAT', addMs(T0, 300_000)), fired, active)).toMatchObject({ disposition: 'SKIPPED_COOLDOWN', nextEligibleAt: addMs(T0, 600_000) });
    expect(decideAutomation(set, ev('REASSESSMENT_HEARTBEAT', addMs(T0, 600_000)), fired, active)).toMatchObject({ disposition: 'INVOKED' });
    expect(decideAutomation(set, ev('SECURITY_EVIDENCE'), { ...fresh(), cycleInFlight: true }, active)).toMatchObject({ disposition: 'SKIPPED_COOLDOWN' });
    expect(decideAutomation(set, ev('SECURITY_EVIDENCE'), fresh(), { ...active, capitalAuthority: 'OBSERVE' })).toMatchObject({ disposition: 'INVOKED' });
    const narrow = { ...set, rules: set.rules.map((r) => (r.triggerType === 'SECURITY_EVIDENCE' ? { ...r, enabledModes: ['LIVE_AUTO' as const] } : r)) };
    expect(decideAutomation(narrow, ev('SECURITY_EVIDENCE'), fresh(), active)).toMatchObject({ disposition: 'SKIPPED_MODE' });
    expect(decideAutomation(set, ev('SECURITY_EVIDENCE'), fresh(), { ...active, activityState: 'WIND_DOWN' })).toMatchObject({ disposition: 'SKIPPED_ACTIVITY_STATE' });
    expect(decideAutomation(set, ev('SECURITY_EVIDENCE'), fresh(), { ...active, spendGate: { ok: false, block: { code: 'BUDGET_PAUSED', budgetId: 'b', scope: 'PLATFORM' }, checked: 1 } })).toMatchObject({ disposition: 'SKIPPED_BUDGET' });
    const disabled = { ...set, rules: set.rules.map((r) => (r.triggerType === 'PROFIT_MILESTONE' ? { ...r, enabled: false } : r)) };
    expect(decideAutomation(disabled, ev('PROFIT_MILESTONE'), fresh(), active)).toMatchObject({ disposition: 'SKIPPED_MODE' });
  });

  it('D39: an unreviewed position retries with exponential backoff up to the ceiling', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => protectionOnlyBackoffMs(set, n))).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    const h: TargetHistory = { ...fresh(), lastFiredAt: T0, reviewState: 'PROTECTION_ONLY', consecutiveUnresolved: 3 };
    expect(decideAutomation(set, ev('REASSESSMENT_HEARTBEAT', addMs(T0, 200_000)), h, active)).toMatchObject({ disposition: 'SKIPPED_COOLDOWN', nextEligibleAt: addMs(T0, 240_000) });
    expect(decideAutomation(set, ev('REASSESSMENT_HEARTBEAT', addMs(T0, 240_000)), h, active)).toMatchObject({ disposition: 'INVOKED' });
    // a reviewed position with the same history is not held back beyond the ordinary cooldown
    expect(decideAutomation(set, ev('REASSESSMENT_HEARTBEAT', addMs(T0, 200_000)), { ...h, reviewState: 'REVIEWED' }, active)).toMatchObject({ disposition: 'INVOKED' });
  });

  it('picks the highest-priority trigger in a tick; security and protection changes outrank the heartbeat', () => {
    expect(pickTrigger(set, [ev('REASSESSMENT_HEARTBEAT'), ev('PRICE_EXCURSION'), ev('SECURITY_EVIDENCE')])?.type).toBe('SECURITY_EVIDENCE');
    expect(pickTrigger(set, [ev('REASSESSMENT_HEARTBEAT'), ev('PROFIT_MILESTONE')])?.type).toBe('PROFIT_MILESTONE');
    expect(pickTrigger(set, [])).toBeNull();
  });

  it('evaluates open-position triggers from facts: heartbeat by tier, excursion, milestone, horizon and event flags', () => {
    const base: PositionTriggerFacts = { positionId: POS, speedTier: 'T2_CONTEXTUAL', openedAt: T0, lastReassessedAt: null, nextReassessmentAt: null, averageEntryPrice: 1, markPrice: 1.02, highWaterPrice: 1.03, expectedHorizonEndsAt: addMs(T0, 3_600_000), volatilityRegimeChanged: false, liquidityDegraded: false, smartMoneyReversal: false, newSecurityEvidence: false, catalystChanged: false, protectiveOrderChanged: false, recoveredAfterRestart: false, profitMilestoneFraction: 0.1 };
    expect(evaluatePositionTriggers(set, base, addMs(T0, 600_000))).toEqual([]);
    expect(evaluatePositionTriggers(set, base, addMs(T0, 1_800_000)).map((e) => e.type)).toEqual(['REASSESSMENT_HEARTBEAT']);
    expect(evaluatePositionTriggers(set, { ...base, speedTier: 'T1_MOMENTUM' }, addMs(T0, 600_000)).map((e) => e.type)).toEqual(['REASSESSMENT_HEARTBEAT']);
    expect(evaluatePositionTriggers(set, { ...base, nextReassessmentAt: addMs(T0, 100_000) }, addMs(T0, 100_000)).map((e) => e.type)).toEqual(['REASSESSMENT_HEARTBEAT']);
    expect(evaluatePositionTriggers(set, { ...base, markPrice: 0.94 }, addMs(T0, 1_000)).map((e) => e.type)).toEqual(['PRICE_EXCURSION']);
    expect(evaluatePositionTriggers(set, { ...base, markPrice: 1.12 }, addMs(T0, 1_000)).map((e) => e.type)).toEqual(['PRICE_EXCURSION', 'PROFIT_MILESTONE']);
    expect(evaluatePositionTriggers(set, base, addMs(T0, 3_600_000)).map((e) => e.type)).toEqual(['REASSESSMENT_HEARTBEAT', 'HORIZON_CHECKPOINT']);
    const flags = evaluatePositionTriggers(set, { ...base, volatilityRegimeChanged: true, liquidityDegraded: true, smartMoneyReversal: true, newSecurityEvidence: true, catalystChanged: true, protectiveOrderChanged: true, recoveredAfterRestart: true }, addMs(T0, 1_000));
    expect(flags.map((e) => e.type)).toEqual(['VOLATILITY_REGIME_SHIFT', 'LIQUIDITY_ROUTE_DEGRADATION', 'SMART_MONEY_REVERSAL', 'SECURITY_EVIDENCE', 'CATALYST_CHANGE', 'PROTECTIVE_ORDER_STATE_CHANGE', 'RECOVERY_AFTER_RESTART']);
    expect(pickTrigger(set, flags)?.type).toBe('SECURITY_EVIDENCE');
  });

  it('property: never invokes inside a cooldown, an interval or a backoff, and never invokes when a cycle is in flight or the budget is blocked', () => {
    const types = AutomationTriggerType.options;
    fc.assert(
      fc.property(fc.constantFrom(...types), fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: 2_000_000 }), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 6 }), (type, sinceAny, sinceType, inFlight, budgetOk, unresolved) => {
        const lastFiredAt = addMs(T0, -sinceAny);
        const h: TargetHistory = { lastFiredAt, lastFiredByType: { [type]: addMs(T0, -sinceType) }, cycleInFlight: inFlight, reviewState: unresolved > 0 ? 'PROTECTION_ONLY' : 'REVIEWED', consecutiveUnresolved: unresolved };
        const d = decideAutomation(set, ev(type), h, { ...active, spendGate: budgetOk ? { ok: true, checked: 1 } : { ok: false, block: { code: 'CYCLES_PER_HOUR', budgetId: 'b', scope: 'STRATEGY', used: 1, limit: 1 }, checked: 1 } });
        const rule = set.rules.find((r) => r.triggerType === type)!;
        const blocked = inFlight || sinceAny < rule.cooldownMs || sinceType < rule.minIntervalMs || (unresolved > 0 && sinceAny < protectionOnlyBackoffMs(set, unresolved)) || !budgetOk;
        expect(d.disposition === 'INVOKED').toBe(!blocked);
      }),
      { numRuns: 400 },
    );
  });
});
