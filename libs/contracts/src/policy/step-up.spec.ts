import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CapitalAuthority, ControlRequestKind } from '../enums.js';
import { FAST_CONTROLS, STEP_UP_POLICY, stepUpBindingHash, stepUpRequired } from './step-up.js';

describe('D41 step-up policy', () => {
  it('classifies every control request kind', () => {
    for (const kind of ControlRequestKind.options) expect(STEP_UP_POLICY[kind]).toBeDefined();
  });

  it('keeps exactly the risk-reducing/neutral controls fast', () => {
    expect([...FAST_CONTROLS].sort()).toEqual(
      ['PAUSE_NEW_ENTRIES', 'REJECT_AUTHORIZATION', 'MANUAL_REDUCE', 'MANUAL_CLOSE', 'EMERGENCY_CLOSE_ALL', 'ACKNOWLEDGE_ALERT', 'RUN_READINESS_DRILL', 'END_SESSION'].sort(),
    );
    for (const kind of FAST_CONTROLS) expect(stepUpRequired(kind, {})).toBe(false);
  });

  it('requires step-up for every authority-widening control', () => {
    for (const kind of ['RESUME_NEW_ENTRIES', 'APPROVE_AUTHORIZATION', 'PROMOTE_RELEASE', 'ARM_RELEASE', 'REVOKE_PASSKEY'] as const) {
      expect(stepUpRequired(kind, {})).toBe(true);
    }
  });

  it('mode/session requests need step-up only toward live authority, and fail closed on a missing target', () => {
    fc.assert(
      fc.property(fc.constantFrom('SET_REQUESTED_MODE', 'START_SESSION' as const), fc.constantFrom(...CapitalAuthority.options), (kind, authority) => {
        expect(stepUpRequired(kind, { authority })).toBe(authority === 'LIVE_APPROVAL' || authority === 'LIVE_AUTO');
      }),
    );
    expect(stepUpRequired('SET_REQUESTED_MODE', {})).toBe(true);
    expect(stepUpRequired('SET_REQUESTED_MODE', { authority: 'live' })).toBe(true);
  });

  it('the first passkey needs an aal2 session, not a passkey', () => {
    expect(STEP_UP_POLICY.REGISTER_PASSKEY).toBe('AAL2_ONLY');
    expect(stepUpRequired('REGISTER_PASSKEY', {})).toBe(false);
  });

  it('binding hash is canonical: key order and whitespace do not matter, any value change does', async () => {
    const a = await stepUpBindingHash('ARM_RELEASE', { releaseId: 'r1', authority: 'LIVE_AUTO' });
    const b = await stepUpBindingHash('ARM_RELEASE', { authority: 'LIVE_AUTO', releaseId: 'r1' });
    const c = await stepUpBindingHash('ARM_RELEASE', { authority: 'LIVE_AUTO', releaseId: 'r2' });
    const d = await stepUpBindingHash('PROMOTE_RELEASE', { authority: 'LIVE_AUTO', releaseId: 'r1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
