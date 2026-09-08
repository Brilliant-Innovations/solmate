import fc from 'fast-check';
import { addMs, toInstant, type Instant } from '@sol-agent-trader/contracts';
import { candleVisibleAt, eventVisibleAt, labelVisibleAt, visibleCandles, visibleEvents } from './visibility.js';

const T0 = toInstant(Date.UTC(2026, 8, 8, 12, 0, 0));

describe('point-in-time visibility (§18.3, INV-13)', () => {
  it('an event becomes visible exactly at first-seen, never earlier whatever its source time; a candle after close plus lag; a label after first observation', () => {
    const e = { firstSeenAt: addMs(T0, 1_000), sourcePublishedAt: addMs(T0, -3_600_000) };
    expect(eventVisibleAt(e, T0)).toBe(false);
    expect(eventVisibleAt(e, addMs(T0, 1_000))).toBe(true);
    expect(visibleEvents([e, { firstSeenAt: T0, sourcePublishedAt: null }], T0).map((x) => x.firstSeenAt)).toEqual([T0]);
    const c = { bucketTime: T0 };
    expect(candleVisibleAt(c, 60_000, 0, addMs(T0, 59_999))).toBe(false);
    expect(candleVisibleAt(c, 60_000, 0, addMs(T0, 60_000))).toBe(true);
    expect(candleVisibleAt(c, 60_000, 5_000, addMs(T0, 64_999))).toBe(false);
    expect(visibleCandles([c, { bucketTime: addMs(T0, 60_000) }], 60_000, 0, addMs(T0, 60_000))).toEqual([c]);
    expect(labelVisibleAt({ firstSeenAt: addMs(T0, 1) }, T0)).toBe(false);
  });

  it('property: nothing visible at t has first-seen after t, and visibility is monotone in time', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -86_400_000, max: 86_400_000 }), { maxLength: 50 }), fc.integer({ min: -86_400_000, max: 86_400_000 }), fc.integer({ min: 0, max: 3_600_000 }), (offsets, nowOffset, step) => {
        const events = offsets.map((o) => ({ firstSeenAt: addMs(T0, o) as Instant }));
        const now = addMs(T0, nowOffset) as Instant;
        const seen = visibleEvents(events, now);
        for (const e of seen) expect(Date.parse(e.firstSeenAt) <= Date.parse(now)).toBe(true);
        const later = visibleEvents(events, addMs(now, step) as Instant);
        for (const e of seen) expect(later).toContain(e);
      }),
    );
  });
});
