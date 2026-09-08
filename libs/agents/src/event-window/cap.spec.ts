import fc from 'fast-check';
import { DEFAULT_EVENT_WINDOW_CAP_POLICY, addMs, fixtures, instantToMs, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { capEventWindow, extendEventWindow, type CatalystTiming } from './cap.js';

const T0 = fixtures.T0 as Instant;
const EV = fixtures.IDS.message as Uuid;
const policy = DEFAULT_EVENT_WINDOW_CAP_POLICY;
const catalyst = (patch: Partial<CatalystTiming> = {}): CatalystTiming => ({ evidenceId: EV, sourceTime: addMs(T0, -30 * 60_000), sourceTimeConfidence: 'HIGH', relation: 'NEW', ...patch });
const request = { catalystEvidenceId: EV, expectedHalfLifeMinutes: 180, requestedDurationMinutes: 600 };

describe('EVENT_WINDOW deterministic cap (§12.3A, D64)', () => {
  it('opens a window from T0 capped by policy, with the policy cadence, retest rule and actions', () => {
    const d = capEventWindow(request, catalyst(), policy, T0);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.window).toMatchObject({ t0: addMs(T0, -30 * 60_000), opensAt: T0, endsAt: addMs(T0, -30 * 60_000 + 4 * 3_600_000), cadenceMs: 300_000, retestRequiredAfter: addMs(T0, -15 * 60_000), extensionsRemaining: 1, expiryBehavior: 'ACTIVE', cappedByPolicy: true, policyVersion: 'event-window-v1' });
    // a modest request is honoured as requested (twice the half-life bounds it)
    const modest = capEventWindow({ ...request, expectedHalfLifeMinutes: 20, requestedDurationMinutes: 90 }, catalyst(), policy, T0);
    expect(modest.allowed && modest.window.endsAt).toBe(addMs(T0, -30 * 60_000 + 40 * 60_000));
    expect(modest.allowed && modest.window.cappedByPolicy).toBe(false);
  });

  it('refuses untrusted time, stale or recycled catalysts, mismatched evidence and already-expired windows', () => {
    expect(capEventWindow(request, catalyst({ sourceTimeConfidence: 'MEDIUM' }), policy, T0)).toEqual({ allowed: false, reason: 'SOURCE_TIME_UNTRUSTED' });
    expect(capEventWindow(request, catalyst({ sourceTime: null, sourceTimeConfidence: 'ABSENT' }), policy, T0)).toEqual({ allowed: false, reason: 'SOURCE_TIME_UNTRUSTED' });
    expect(capEventWindow(request, catalyst({ sourceTime: addMs(T0, -7 * 3_600_000) }), policy, T0)).toEqual({ allowed: false, reason: 'CATALYST_TOO_OLD' });
    expect(capEventWindow(request, catalyst({ relation: 'DUPLICATE' }), policy, T0)).toEqual({ allowed: false, reason: 'NOT_NEW_INFORMATION' });
    expect(capEventWindow(request, catalyst({ evidenceId: fixtures.IDS.lot as Uuid }), policy, T0)).toEqual({ allowed: false, reason: 'EVIDENCE_MISMATCH' });
    expect(capEventWindow({ ...request, expectedHalfLifeMinutes: 5, requestedDurationMinutes: 10 }, catalyst(), policy, T0)).toEqual({ allowed: false, reason: 'ALREADY_EXPIRED' });
  });

  it('extends once on genuinely new information and never past T0 + max + extensions', () => {
    const opened = capEventWindow(request, catalyst(), policy, T0);
    if (!opened.allowed) throw new Error('expected window');
    const later = addMs(T0, 3_600_000);
    const newer = { ...catalyst({ evidenceId: fixtures.IDS.lot as Uuid, sourceTime: addMs(later, -5 * 60_000) }), firstSeenAt: addMs(later, -4 * 60_000) };
    const ext = extendEventWindow(opened.window, newer, policy, later);
    expect(ext.allowed && ext.window.endsAt).toBe(addMs(opened.window.endsAt, 2 * 3_600_000));
    expect(ext.allowed && ext.window.extensionsRemaining).toBe(0);
    if (!ext.allowed) return;
    expect(extendEventWindow(ext.window, newer, policy, later)).toEqual({ allowed: false, reason: 'NO_EXTENSIONS_LEFT' });
    expect(extendEventWindow(opened.window, { ...newer, relation: 'CORROBORATION' }, policy, later)).toEqual({ allowed: false, reason: 'NOT_NEW_INFORMATION' });
    expect(extendEventWindow(opened.window, { ...newer, firstSeenAt: addMs(T0, -1) }, policy, later)).toEqual({ allowed: false, reason: 'NOT_NEW_INFORMATION' });
    expect(extendEventWindow(opened.window, { ...newer, sourceTime: addMs(later, -7 * 3_600_000) }, policy, later)).toEqual({ allowed: false, reason: 'CATALYST_TOO_OLD' });
    expect(extendEventWindow(opened.window, newer, policy, addMs(opened.window.endsAt, 1))).toEqual({ allowed: false, reason: 'WINDOW_CLOSED' });
  });

  it('property: whatever is requested, a window never exceeds the policy ceiling from T0, never opens on an old or untrusted catalyst, and always carries the policy actions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1440 }), fc.integer({ min: 1, max: 1440 }), fc.integer({ min: -8 * 60, max: 10 }), fc.constantFrom<'ABSENT' | 'LOW' | 'MEDIUM' | 'HIGH'>('ABSENT', 'LOW', 'MEDIUM', 'HIGH'), fc.constantFrom<'NEW' | 'DUPLICATE' | 'CORROBORATION'>('NEW', 'DUPLICATE', 'CORROBORATION'), (half, dur, ageMin, conf, relation) => {
        const sourceTime = conf === 'ABSENT' ? null : addMs(T0, -ageMin * 60_000);
        const d = capEventWindow({ catalystEvidenceId: EV, expectedHalfLifeMinutes: half, requestedDurationMinutes: dur }, { evidenceId: EV, sourceTime, sourceTimeConfidence: conf, relation }, policy, T0);
        if (d.allowed) {
          expect(conf).toBe('HIGH');
          expect(relation).toBe('NEW');
          expect(ageMin).toBeLessThanOrEqual(6 * 60);
          expect(instantToMs(d.window.endsAt) - instantToMs(d.window.t0)).toBeLessThanOrEqual(policy.maxDurationMs);
          expect(instantToMs(d.window.endsAt)).toBeGreaterThan(instantToMs(T0));
          expect(d.window.allowedActions).toEqual(policy.allowedActions);
        }
      }),
      { numRuns: 500 },
    );
  });
});
