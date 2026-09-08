import { addMs, DEFAULT_CHAIN_HEALTH_POLICY, fixedClock, fixtures, type ChainHealthSnapshot, type FeedHealth, type Instant } from '@sol-agent-trader/contracts';
import type { PreviousHead } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { CHAIN_PROVIDER, runChainHealthCycle, type ChainHealthDeps, type ChainViewSampler } from './chain-health.js';

const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const sampler = (label: string, slot: number | Error, finalizedBehind = 32): ChainViewSampler => ({ label, async sample() { if (slot instanceof Error) throw slot; return { slotConfirmed: slot, slotFinalized: slot - finalizedBehind, blockHeight: slot - 10 }; } });
function fake(samplers: ChainViewSampler[], stored: PreviousHead | null = null) {
  const inserted: ChainHealthSnapshot[] = [];
  const feed: FeedHealth[] = [];
  const deps: ChainHealthDeps = { samplers, repo: { async insert(s) { inserted.push(s); }, async lastHeadAdvance() { return stored; }, async upsertFeedHealth(h) { feed.push(h); } }, policy: DEFAULT_CHAIN_HEALTH_POLICY, clock: fixedClock(T0), logger };
  return { deps, inserted, feed };
}

describe('worker chain-health role (§14.7, §40.3)', () => {
  it('samples every view, records the snapshot and mirrors a HEALTHY verdict into provider health with no entry effect', async () => {
    const f = fake([sampler('primary', 10_000), sampler('secondary', 10_002)]);
    const r = await runChainHealthCycle(f.deps, { headSlot: 9_990 as never, observedAt: addMs(T0, -15_000), lastAdvanceAt: addMs(T0, -15_000) });
    expect(r.snapshot).toMatchObject({ state: 'HEALTHY', headSlot: 10_002, slotAdvanced: true, viewDivergenceSlots: 2, effectOnEntries: 'NONE' });
    expect(f.inserted).toHaveLength(1);
    expect(f.feed[0]).toMatchObject({ provider: CHAIN_PROVIDER, state: 'HEALTHY', effectOnEntries: 'NONE', effectOnExits: 'NONE', lastError: null, lastSuccessAt: T0 });
    expect(r.previous).toEqual({ headSlot: 10_002, observedAt: T0, lastAdvanceAt: T0 });
  });

  it('a halt seen across cycles turns into FAILED/BLOCK in provider health, with the reason as the last error', async () => {
    const f = fake([sampler('primary', 10_000)]);
    const first = await runChainHealthCycle(f.deps, null);
    expect(first.snapshot.slotAdvanced).toBeNull();
    const stalled = await runChainHealthCycle(f.deps, { headSlot: 10_000 as never, observedAt: addMs(T0, -DEFAULT_CHAIN_HEALTH_POLICY.maxSlotStallMs), lastAdvanceAt: addMs(T0, -DEFAULT_CHAIN_HEALTH_POLICY.maxSlotStallMs) });
    expect(stalled.snapshot).toMatchObject({ state: 'STALLED', effectOnEntries: 'BLOCK' });
    expect(f.feed[1]).toMatchObject({ provider: CHAIN_PROVIDER, state: 'FAILED', effectOnEntries: 'BLOCK' });
    expect(f.feed[1]?.lastError).toMatch(/no confirmed slot advance/);
    // the stall clock is not reset by a sample that did not move
    expect(stalled.previous?.lastAdvanceAt).toBe(addMs(T0, -DEFAULT_CHAIN_HEALTH_POLICY.maxSlotStallMs));
  });

  it('a restart takes the stall clock from the stored history instead of starting fresh', async () => {
    const f = fake([sampler('primary', 10_000)], { headSlot: 10_000 as never, observedAt: addMs(T0, -60_000), lastAdvanceAt: addMs(T0, -60_000) });
    const r = await runChainHealthCycle(f.deps, null);
    expect(r.snapshot).toMatchObject({ state: 'STALLED', slotAdvanced: false });
  });

  it('every view failing is UNAVAILABLE and blocks; the previous head is kept for the next cycle', async () => {
    const prev: PreviousHead = { headSlot: 9_990 as never, observedAt: addMs(T0, -15_000), lastAdvanceAt: addMs(T0, -15_000) };
    const f = fake([sampler('primary', new Error('ECONNRESET')), sampler('secondary', new Error('429'))]);
    const r = await runChainHealthCycle(f.deps, prev);
    expect(r.snapshot).toMatchObject({ state: 'UNAVAILABLE', effectOnEntries: 'BLOCK', headSlot: null });
    expect(r.snapshot.views.map((v) => v.error)).toEqual(['ECONNRESET', '429']);
    expect(f.feed[0]).toMatchObject({ state: 'FAILED', effectOnEntries: 'BLOCK', lastSuccessAt: null });
    expect(r.previous).toEqual(prev);
  });

  it('divergent views block entries even though both are answering', async () => {
    const f = fake([sampler('primary', 10_000), sampler('secondary', 10_000 - DEFAULT_CHAIN_HEALTH_POLICY.maxViewDivergenceSlots - 5)]);
    const r = await runChainHealthCycle(f.deps, null);
    expect(r.snapshot).toMatchObject({ state: 'DIVERGENT', effectOnEntries: 'BLOCK' });
    expect(f.feed[0]).toMatchObject({ state: 'FAILED', effectOnEntries: 'BLOCK' });
  });
});
