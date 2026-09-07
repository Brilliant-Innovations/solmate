import fc from 'fast-check';
import type { ActorKind, CapitalAuthority, Instant } from '@sol-agent-trader/contracts';
import { initialRuntimeState, liveExecutionAllowed, newEntriesAllowed, runtimeTransition, type RuntimeEvent, type RuntimeState } from './machine.js';

const T0 = '2026-09-05T12:00:00.000Z' as Instant;
const ACTORS: ActorKind[] = ['OPERATOR', 'SCHEDULE', 'AUTOMATION', 'WORKER', 'WATCHDOG'];

function to(state: RuntimeState, events: RuntimeEvent[]): RuntimeState {
  let s = state;
  for (const e of events) {
    const r = runtimeTransition(s, e);
    if (!r.ok) throw new Error(`${e.type}: ${JSON.stringify(r.rejection)}`);
    s = r.state;
  }
  return s;
}

const active = () =>
  to(initialRuntimeState({ liveCapabilityEnabled: true }), [
    { type: 'START', at: T0, by: 'OPERATOR' },
    { type: 'COLD_START_PASSED', at: T0 },
    { type: 'ACTIVATE', at: T0, by: 'SCHEDULE' },
  ]);

describe('runtime session (D60, D61, INV-05)', () => {
  it('PAUSED is sticky: schedules and automations cannot clear it, an operator needs step-up', () => {
    const paused = to(active(), [{ type: 'PAUSE', at: T0, by: 'SCHEDULE' }]);
    expect(newEntriesAllowed(paused)).toBe(false);
    for (const by of ['SCHEDULE', 'AUTOMATION', 'WORKER', 'WATCHDOG'] as ActorKind[]) {
      expect(runtimeTransition(paused, { type: 'RESUME', at: T0, by, stepUpVerified: true }).ok).toBe(false);
    }
    expect(runtimeTransition(paused, { type: 'RESUME', at: T0, by: 'OPERATOR', stepUpVerified: false }).ok).toBe(false);
    const resumed = runtimeTransition(paused, { type: 'RESUME', at: T0, by: 'OPERATOR', stepUpVerified: true });
    expect(resumed.ok && resumed.state.paused).toBe(false);
  });

  it('live arming needs deployment capability, attested Release, readiness verdict and step-up (§15.9)', () => {
    const s = active();
    const arm = (o: Partial<Extract<RuntimeEvent, { type: 'SET_AUTHORITY' }>>) =>
      runtimeTransition(s, { type: 'SET_AUTHORITY', at: T0, by: 'OPERATOR', authority: 'LIVE_APPROVAL', releaseAttested: true, readinessPermits: true, stepUpVerified: true, ...o });
    expect(arm({}).ok).toBe(true);
    expect(arm({ releaseAttested: false }).ok).toBe(false);
    expect(arm({ readinessPermits: false }).ok).toBe(false);
    expect(arm({ stepUpVerified: false }).ok).toBe(false);
    expect(arm({ by: 'SCHEDULE' }).ok).toBe(false);
    const noCap = { ...s, liveCapabilityEnabled: false };
    expect(runtimeTransition(noCap, { type: 'SET_AUTHORITY', at: T0, by: 'OPERATOR', authority: 'LIVE_AUTO', releaseAttested: true, readinessPermits: true, stepUpVerified: true }).ok).toBe(false);
  });

  it('END SESSION goes to WIND_DOWN; OFF is refused while exposure is unmanaged or execution is in flight (D61)', () => {
    const wd = to(active(), [{ type: 'END_SESSION', at: T0, by: 'OPERATOR' }]);
    expect(wd.activity).toBe('WIND_DOWN');
    expect(runtimeTransition(wd, { type: 'WIND_DOWN_COMPLETE', at: T0, unmanagedLots: 1, inFlightExecutions: 0, inFlightCustodyOps: 0 }).ok).toBe(false);
    expect(runtimeTransition(wd, { type: 'WIND_DOWN_COMPLETE', at: T0, unmanagedLots: 0, inFlightExecutions: 1, inFlightCustodyOps: 0 }).ok).toBe(false);
    expect(runtimeTransition(wd, { type: 'WIND_DOWN_COMPLETE', at: T0, unmanagedLots: 0, inFlightExecutions: 0, inFlightCustodyOps: 1 }).ok).toBe(false);
    const off = runtimeTransition(wd, { type: 'WIND_DOWN_COMPLETE', at: T0, unmanagedLots: 0, inFlightExecutions: 0, inFlightCustodyOps: 0 });
    expect(off.ok && off.state.activity).toBe('OFF');
  });

  const eventArb: fc.Arbitrary<RuntimeEvent> = fc.oneof(
    fc.record({ type: fc.constant('START' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.constant<RuntimeEvent>({ type: 'COLD_START_PASSED', at: T0 }),
    fc.record({ type: fc.constant('ACTIVATE' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.record({ type: fc.constant('TO_WATCH' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.record({ type: fc.constant('OPEN_EVENT_WINDOW' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.record({ type: fc.constant('CLOSE_EVENT_WINDOW' as const), at: fc.constant(T0), fallback: fc.constantFrom('ACTIVE' as const, 'WATCH' as const) }),
    fc.record({ type: fc.constant('END_SESSION' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.record({ type: fc.constant('WIND_DOWN_COMPLETE' as const), at: fc.constant(T0), unmanagedLots: fc.nat(2), inFlightExecutions: fc.nat(1), inFlightCustodyOps: fc.nat(1) }),
    fc.record({ type: fc.constant('PAUSE' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS) }),
    fc.record({ type: fc.constant('RESUME' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS), stepUpVerified: fc.boolean() }),
    fc.record({
      type: fc.constant('SET_AUTHORITY' as const), at: fc.constant(T0), by: fc.constantFrom(...ACTORS),
      authority: fc.constantFrom<CapitalAuthority>('OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'),
      releaseAttested: fc.boolean(), readinessPermits: fc.boolean(), stepUpVerified: fc.boolean(),
    }),
  );

  it('over arbitrary sequences: no live execution while PAUSED or in OBSERVE/PAPER; OFF never carries unmanaged exposure', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(eventArb, { minLength: 1, maxLength: 40 }), (liveCapabilityEnabled, events) => {
        let s = initialRuntimeState({ liveCapabilityEnabled });
        for (const e of events) {
          const r = runtimeTransition(s, e);
          if (e.type === 'RESUME' && e.by !== 'OPERATOR') expect(r.ok).toBe(false);
          if (e.type === 'WIND_DOWN_COMPLETE' && r.ok && r.state.activity === 'OFF') expect(e.unmanagedLots + e.inFlightExecutions + e.inFlightCustodyOps).toBe(0);
          if (!r.ok) continue;
          s = r.state;
          if (s.paused || s.authority === 'OBSERVE' || s.authority === 'PAPER' || !s.liveCapabilityEnabled) expect(liveExecutionAllowed(s)).toBe(false);
          if (!['ACTIVE', 'EVENT_WINDOW'].includes(s.activity)) expect(newEntriesAllowed(s)).toBe(false);
          if (['LIVE_APPROVAL', 'LIVE_AUTO'].includes(s.authority)) expect(liveCapabilityEnabled).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('INV-05: a pause blocks new exposure in every running activity and authority, including LIVE_AUTO with live capability (found by tools/check-bypass.mjs)', () => {
    fc.assert(
      fc.property(fc.constantFrom('ACTIVE', 'EVENT_WINDOW', 'WATCH', 'STARTING' as const), fc.constantFrom<CapitalAuthority>('OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'), fc.boolean(), (activity, authority, liveCapabilityEnabled) => {
        const running = initialRuntimeState({ activity, authority, liveCapabilityEnabled, paused: false });
        const paused = runtimeTransition(running, { type: 'PAUSE', at: T0, by: 'WATCHDOG' });
        if (!paused.ok) throw new Error('pause must always be accepted');
        expect(newEntriesAllowed(paused.state)).toBe(false);
        expect(liveExecutionAllowed(paused.state)).toBe(false);
        // The same state unpaused may allow entries: the pause is what blocks them.
        if ((activity === 'ACTIVE' || activity === 'EVENT_WINDOW') && authority !== 'OBSERVE') expect(newEntriesAllowed(running)).toBe(true);
      }),
    );
  });
});
