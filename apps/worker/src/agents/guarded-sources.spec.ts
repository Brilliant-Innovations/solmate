import { addMs, fixedClock, fixtures, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { liveGuardContext, LookAheadError, SimulatedClock } from '@sol-agent-trader/replay';
import type { ContextSources } from '@sol-agent-trader/skills';
import { CONTEXT_SOURCE_AS_OF, guardedContextSources } from './guarded-sources.js';

const T0 = fixtures.T0 as Instant;
const ID = 'a0000000-0000-4000-8000-000000000001' as Uuid;

function fakeSources(calls: string[]): ContextSources {
  const rec = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}@${args.find((a) => typeof a === 'string' && /^\d{4}-/.test(a as string))}`);
    return null as never;
  };
  return {
    candidate: rec('candidate'),
    position: rec('position'),
    featureSnapshotAt: rec('featureSnapshotAt'),
    marketSnapshotAt: rec('marketSnapshotAt'),
    eligibilityAt: rec('eligibilityAt'),
    safetyAt: rec('safetyAt'),
    eventsVisibleAt: rec('eventsVisibleAt'),
    onchainAt: rec('onchainAt'),
    portfolioAt: rec('portfolioAt'),
    executionPreview: rec('executionPreview'),
    cohortPeers: rec('cohortPeers'),
  };
}

describe('look-ahead guard over skill context sources (§18.3, INV-13)', () => {
  it('every ContextSources method is mapped to its asOf argument and passes at or before the clock', async () => {
    const calls: string[] = [];
    const g = guardedContextSources(fakeSources(calls), { clock: new SimulatedClock(T0), datasetCutoff: T0 });
    const keys = Object.keys(CONTEXT_SOURCE_AS_OF) as (keyof ContextSources)[];
    expect(keys.sort()).toEqual((Object.keys(fakeSources([])) as (keyof ContextSources)[]).sort());
    await g.candidate(ID, T0);
    await g.executionPreview(ID, 'BUY', T0);
    await g.eventsVisibleAt(ID, addMs(T0, -1), 10);
    await g.portfolioAt(ID, addMs(T0, -60_000));
    expect(calls).toEqual([`candidate@${T0}`, `executionPreview@${T0}`, `eventsVisibleAt@${addMs(T0, -1)}`, `portfolioAt@${addMs(T0, -60_000)}`]);
  });

  it('a tool call that asks for a later moment than the replay clock fails before the repository is read', async () => {
    const calls: string[] = [];
    const g = guardedContextSources(fakeSources(calls), { clock: new SimulatedClock(T0), datasetCutoff: addMs(T0, 3_600_000) });
    expect(() => g.eventsVisibleAt(ID, addMs(T0, 1), 10)).toThrow(LookAheadError);
    expect(() => g.executionPreview(ID, 'SELL', addMs(T0, 1))).toThrow(LookAheadError);
    expect(() => g.featureSnapshotAt(ID, 'not-an-instant' as Instant)).toThrow(LookAheadError);
    expect(calls).toEqual([]);
  });

  it('the live guard refuses a future asOf against the wall clock and accepts now', async () => {
    const calls: string[] = [];
    const g = guardedContextSources(fakeSources(calls), liveGuardContext(fixedClock(T0)));
    await g.onchainAt(ID, T0);
    expect(() => g.onchainAt(ID, addMs(T0, 1_000))).toThrow(LookAheadError);
    expect(calls).toEqual([`onchainAt@${T0}`]);
  });
});
