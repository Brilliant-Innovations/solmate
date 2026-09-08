import fc from 'fast-check';
import { modeGate, type ModeFacts } from './mode-gate.js';

describe('executor mode gate (D60, P3; INV-05)', () => {
  it('property: exposure-increasing work needs live capability, a live authority, a running activity and no pause of either kind; risk reduction is never gated', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('OFF', 'STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW', 'WIND_DOWN'),
        fc.constantFrom('OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'),
        fc.boolean(), fc.boolean(), fc.boolean(),
        (activity, authority, paused, localPause, live) => {
          const facts = { activity, authority, paused, localPause, liveCapabilityEnabled: live } as ModeFacts;
          expect(modeGate(facts, 'REDUCE')).toEqual({ allowed: true });
          const increase = modeGate(facts, 'INCREASE');
          const expected = !paused && !localPause && (activity === 'ACTIVE' || activity === 'EVENT_WINDOW') && (authority === 'LIVE_APPROVAL' || authority === 'LIVE_AUTO') && live;
          expect(increase.allowed).toBe(expected);
          expect(modeGate(facts, 'NEUTRAL').allowed).toBe(expected);
        },
      ),
    );
  });
});
