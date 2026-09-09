import { addMs, fixtures, type Instant } from '@sol-agent-trader/contracts';
import fc from 'fast-check';
import { SimulatedClock } from '../clock/simulated.js';
import { DatasetCutoffError, guardSources, guardedCandles, guardedRows, LookAheadError } from './guard.js';

const T0 = fixtures.T0 as Instant;
const ctx = (now: Instant, cutoffMs = 3_600_000) => ({ clock: new SimulatedClock(now), datasetCutoff: addMs(T0, cutoffMs) });

describe('look-ahead enforcement (§18.3, P9 acceptance, INV-13)', () => {
  it('a read that reaches for evidence after the replay clock fails instead of returning a filtered result', () => {
    const events = [{ firstSeenAt: T0 }, { firstSeenAt: addMs(T0, 120_000) }];
    const c = ctx(addMs(T0, 60_000));
    expect(guardedRows('events', events, addMs(T0, 60_000), c)).toEqual([{ firstSeenAt: T0 }]);
    expect(() => guardedRows('events', events, addMs(T0, 60_001), c)).toThrow(LookAheadError);
    expect(() => guardedCandles('candles', [{ bucketTime: T0 }], 60_000, 0, addMs(T0, 120_000), c)).toThrow(LookAheadError);
  });

  it('never returns a row first seen after the requested moment (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -600_000, max: 600_000 }), { minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 600_000 }), (offsets, untilOffset) => {
        const until = addMs(T0, untilOffset);
        const rows = offsets.map((o) => ({ firstSeenAt: addMs(T0, o) }));
        const out = guardedRows('events', rows, until, { clock: new SimulatedClock(until), datasetCutoff: addMs(T0, 3_600_000) });
        return out.every((r) => r.firstSeenAt <= until) && out.length === rows.filter((r) => r.firstSeenAt <= until).length;
      }),
    );
  });

  it('drops observations made after the dataset cutoff and refuses reads past it', () => {
    const c = { clock: new SimulatedClock(addMs(T0, 7_200_000)), datasetCutoff: addMs(T0, 3_600_000) };
    const rows = [
      { firstSeenAt: T0, observedAt: addMs(T0, 1_000) },
      { firstSeenAt: addMs(T0, 1_000), observedAt: addMs(T0, 3_600_001) },
    ];
    expect(guardedRows('events', rows, addMs(T0, 3_600_000), c)).toEqual([rows[0]]);
    expect(() => guardedRows('events', rows, addMs(T0, 3_600_001), c)).toThrow(DatasetCutoffError);
  });

  it('candles need their bucket closed plus the availability lag', () => {
    const c = ctx(addMs(T0, 65_000));
    const candles = [{ bucketTime: T0 }, { bucketTime: addMs(T0, 60_000) }];
    expect(guardedCandles('candles', candles, 60_000, 5_000, addMs(T0, 64_999), c)).toEqual([]);
    expect(guardedCandles('candles', candles, 60_000, 5_000, addMs(T0, 65_000), c)).toEqual([{ bucketTime: T0 }]);
  });

  it('guarded skill sources refuse a future asOf before the read runs, and refuse unknown methods outright', async () => {
    const calls: string[] = [];
    const sources = {
      async events(_assetId: string, asOf: Instant) { calls.push(`events@${asOf}`); return [1]; },
      async portfolio(asOf: Instant) { calls.push(`portfolio@${asOf}`); return { asOf }; },
      async mystery() { calls.push('mystery'); return 0; },
    };
    const now = addMs(T0, 60_000);
    const g = guardSources(sources, ctx(now), (m, args) => (m === 'events' ? (args[1] as Instant) : m === 'portfolio' ? (args[0] as Instant) : null));
    await expect(g.events('a', now)).resolves.toEqual([1]);
    expect(() => g.events('a', addMs(now, 1))).toThrow(LookAheadError);
    expect(() => g.portfolio(addMs(now, 1))).toThrow(LookAheadError);
    expect(() => g.mystery()).toThrow(LookAheadError);
    expect(calls).toEqual([`events@${now}`]);
  });
});
