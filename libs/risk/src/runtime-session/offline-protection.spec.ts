import { addMs, fixtures, type Amount, type Instant, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { evaluateOfflineProtection, windDownPlan, type LotForWindDown, type WindDownInput } from './offline-protection.js';

const T0 = fixtures.T0 as Instant;
const lot = (over: Partial<LotForWindDown> = {}): LotForWindDown => ({ lotId: fixtures.IDS.lot as Uuid, positionId: fixtures.IDS.position as Uuid, strategyVersionId: 'S0_SAFE@1.2.0' as VersionId, quantity: '1000' as Amount, protectionMode: 'JUPITER_TRIGGER', providerProtectionActive: true, safetyState: 'NORMAL', ...over });
const input = (over: Partial<WindDownInput> = {}): WindDownInput => ({ lots: [lot()], strategyTerms: () => ({ permitted: true, maxOfflineMs: 8 * 3_600_000 }), inFlightExecutions: 0, inFlightCustodyOps: 0, emergencyRouteFresh: true, watchdog: { healthy: true, lastRunAt: addMs(T0, -60_000) }, plannedResumeAt: addMs(T0, 4 * 3_600_000), now: T0, ...over });

describe('D61 offline protection and the §21.2B wind-down plan', () => {
  it('a lot is OFFLINE_PROTECTED only when every D61 condition holds; the plan then permits OFF with the resume obligation', () => {
    const plan = windDownPlan(input());
    expect(plan).toMatchObject({ unmanagedLots: 0, offlineProtectedLots: 1, blockers: [], canGoOff: true, resumeBy: addMs(T0, 4 * 3_600_000) });
  });

  it('each missing condition names itself and makes the lot unmanaged', () => {
    const reasons = (over: Partial<WindDownInput>, l: Partial<LotForWindDown> = {}) => {
      const v = evaluateOfflineProtection(lot(l), input(over));
      return v.protected ? [] : v.reasons;
    };
    expect(reasons({ strategyTerms: () => ({ permitted: false, maxOfflineMs: 8 * 3_600_000 }) })).toEqual(['strategy forbids offline protection']);
    expect(reasons({ strategyTerms: () => null })).toEqual(['strategy terms unknown']);
    expect(reasons({}, { protectionMode: 'MONITORED_EXIT' as never })).toEqual(['no active provider-side protection']);
    expect(reasons({}, { providerProtectionActive: false })).toEqual(['no active provider-side protection']);
    expect(reasons({ inFlightExecutions: 1 })).toEqual(['execution or custody transition in flight']);
    expect(reasons({}, { safetyState: 'DEGRADED' })).toEqual(['safety DEGRADED']);
    expect(reasons({ emergencyRouteFresh: null })).toEqual(['emergency route state not fresh']);
    expect(reasons({ plannedResumeAt: null })).toEqual(['no planned resume']);
    expect(reasons({ strategyTerms: () => ({ permitted: true, maxOfflineMs: null }) })).toEqual(['strategy declares no maximum offline duration']);
    expect(reasons({ plannedResumeAt: addMs(T0, 9 * 3_600_000) })).toEqual(['planned resume beyond the maximum offline duration']);
    expect(reasons({ watchdog: { healthy: false, lastRunAt: null } })).toEqual(['resume watchdog not healthy']);
  });

  it('the plan blocks OFF for in-flight transitions, unmanaged lots and an unhealthy watchdog when protected lots would be carried; zero lots always permits OFF', () => {
    expect(windDownPlan(input({ inFlightExecutions: 2 })).blockers[0]).toBe('2 execution/custody transition(s) in flight');
    const unmanaged = windDownPlan(input({ lots: [lot({ protectionMode: 'MONITORED_EXIT' as never, providerProtectionActive: false }), lot({ lotId: fixtures.IDS.message as Uuid })] }));
    expect(unmanaged).toMatchObject({ unmanagedLots: 1, offlineProtectedLots: 1, canGoOff: false });
    expect(unmanaged.blockers[0]).toMatch(/^1 unmanaged lot\(s\): no active provider-side protection/);
    const dog = windDownPlan(input({ watchdog: { healthy: false, lastRunAt: addMs(T0, -3_600_000) } }));
    expect(dog.canGoOff).toBe(false);
    expect(dog.blockers.some((b) => b.includes('resume watchdog not healthy'))).toBe(true);
    expect(windDownPlan(input({ lots: [], watchdog: { healthy: false, lastRunAt: null } }))).toMatchObject({ canGoOff: true, resumeBy: null, blockers: [] });
  });
});
