import fc from 'fast-check';
import { activityTone, alertsLabel, authorityTone, entriesLabel, freshnessLabel, valueOrMissing, worstHealth } from '../src/lib/status';

describe('status bar labelling (§20.1, §20.21)', () => {
  it('never renders missing data as zero or fresh', () => {
    expect(freshnessLabel(null, 5000)).toEqual({ text: 'NO DATA', tone: 'unknown' });
    expect(valueOrMissing(null, (n) => `$${n}`)).toEqual({ text: '—', tone: 'unknown' });
    expect(valueOrMissing(0, (n) => `$${n}`)).toEqual({ text: '$0', tone: 'ok' });
    expect(worstHealth([])).toBeNull();
    expect(worstHealth(['HEALTHY', null])).toBeNull();
  });

  it('freshness breaches read STALE with the age; within limit read FRESH', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3_600_000 }), fc.integer({ min: 1, max: 60_000 }), (age, limit) => {
        const l = freshnessLabel(age, limit);
        expect(l.text.startsWith(age > limit ? 'STALE' : 'FRESH')).toBe(true);
        expect(l.tone).toBe(age > limit ? 'failed' : 'ok');
      }),
    );
  });

  it('entries are PAUSED whenever paused, BLOCKED outside ACTIVE/EVENT_WINDOW or in OBSERVE, ARMED otherwise', () => {
    expect(entriesLabel({ activity: 'ACTIVE', authority: 'LIVE_AUTO', paused: true })).toEqual({ text: 'PAUSED', tone: 'paused' });
    expect(entriesLabel({ activity: 'WATCH', authority: 'PAPER', paused: false }).text).toBe('BLOCKED');
    expect(entriesLabel({ activity: 'ACTIVE', authority: 'OBSERVE', paused: false }).text).toBe('BLOCKED');
    expect(entriesLabel({ activity: 'ACTIVE', authority: 'LIVE_AUTO', paused: false })).toEqual({ text: 'ARMED', tone: 'live-auto' });
  });

  it('authority and activity map to distinct tones so PAPER and LIVE_AUTO cannot look alike', () => {
    const tones = new Set((['OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'] as const).map(authorityTone));
    expect(tones.size).toBe(4);
    const act = new Set((['OFF', 'STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW', 'WIND_DOWN'] as const).map(activityTone));
    expect(act.size).toBe(6);
  });

  it('alerts show count and worst severity', () => {
    expect(alertsLabel([])).toEqual({ text: '0', tone: 'ok' });
    expect(alertsLabel(['INFO', 'CRITICAL', 'HIGH'])).toEqual({ text: '3 (CRITICAL)', tone: 'failed' });
    expect(worstHealth(['HEALTHY', 'DEGRADED'])).toBe('DEGRADED');
    expect(worstHealth(['DEGRADED', 'FAILED'])).toBe('FAILED');
  });
});
