import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CapitalAuthority, ControlRequestKind } from '../enums.js';
import { contractRegistry } from '../digest/registry.js';
import { boundPayload, FAST_CONTROLS, STEP_UP_POLICY, StepUpPolicy, stepUpBindingHash, stepUpRequired } from './step-up.js';

describe('D41 step-up policy', () => {
  it('classifies every control request kind and the table is part of the contract digest', () => {
    for (const kind of ControlRequestKind.options) expect(STEP_UP_POLICY[kind]).toBeDefined();
    expect(StepUpPolicy.safeParse(STEP_UP_POLICY).success).toBe(true);
    expect(StepUpPolicy.safeParse({ ...STEP_UP_POLICY, ARM_RELEASE: 'FAST' }).success).toBe(false);
    expect(contractRegistry.has('policy.StepUpPolicy')).toBe(true);
  });

  it('keeps exactly the risk-reducing/neutral controls fast', () => {
    expect([...FAST_CONTROLS].sort()).toEqual(
      ['PAUSE_NEW_ENTRIES', 'REJECT_AUTHORIZATION', 'MANUAL_REDUCE', 'MANUAL_CLOSE', 'EMERGENCY_CLOSE_ALL', 'ACKNOWLEDGE_ALERT', 'RUN_READINESS_DRILL', 'END_SESSION', 'WATCH_ASSET', 'UNWATCH_ASSET', 'REQUEST_RESEARCH_REFRESH', 'FUND_TRADING_WALLET', 'RUN_REPLAY'].sort(),
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

  it('only the first passkey may be added with TOTP alone; later ones need an existing passkey; unknown context fails closed (R2-01)', () => {
    expect(STEP_UP_POLICY.REGISTER_PASSKEY).toBe('FIRST_PASSKEY_AAL2');
    expect(stepUpRequired('REGISTER_PASSKEY', {}, { activePasskeys: 0 })).toBe(false);
    fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), (n) => stepUpRequired('REGISTER_PASSKEY', {}, { activePasskeys: n }) === true));
    expect(stepUpRequired('REGISTER_PASSKEY', {})).toBe(true);
  });

  it('binding hash ignores ceremony evidence keys and is canonical otherwise (R2-09)', async () => {
    const base = { releaseId: 'r1', authority: 'LIVE_AUTO' };
    const a = await stepUpBindingHash('ARM_RELEASE', base);
    const b = await stepUpBindingHash('ARM_RELEASE', { authority: 'LIVE_AUTO', releaseId: 'r1', stepUp: { challengeId: 'x' }, registration: { id: 'y' } });
    const c = await stepUpBindingHash('ARM_RELEASE', { ...base, releaseId: 'r2' });
    const d = await stepUpBindingHash('PROMOTE_RELEASE', base);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(boundPayload({ x: 1, stepUp: {}, registration: {} })).toEqual({ x: 1 });
  });
});
