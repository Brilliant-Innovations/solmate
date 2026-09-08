import { addMs, DEFAULT_CHAIN_HEALTH_POLICY, fixtures, type ChainView, type Instant, type Slot, type Uuid } from '@sol-agent-trader/contracts';
import { chainAcceptsSubmissions, evaluateChainHealth, type PreviousHead } from './health.js';

const T0 = fixtures.T0 as Instant;
const ID = fixtures.IDS.message as Uuid;
const view = (label: string, confirmed: number | null, finalized: number | null, over: Partial<ChainView> = {}): ChainView => ({ label, ok: confirmed !== null, slotConfirmed: confirmed as Slot | null, slotFinalized: finalized as Slot | null, blockHeight: confirmed === null ? null : confirmed - 10, latencyMs: 40, error: confirmed === null ? 'timeout' : null, ...over });
const prev = (headSlot: number, advancedAgoMs: number): PreviousHead => ({ headSlot: headSlot as Slot, observedAt: addMs(T0, -15_000), lastAdvanceAt: addMs(T0, -advancedAgoMs) });
const policy = DEFAULT_CHAIN_HEALTH_POLICY;

describe('chain health from independent RPC views (§14.7, §40.3)', () => {
  it('two agreeing, advancing views with normal finality lag are HEALTHY and do not block entries', () => {
    const r = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_968), view('secondary', 10_003, 9_970)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(r.snapshot).toMatchObject({ state: 'HEALTHY', headSlot: 10_003, slotAdvanced: true, confirmedFinalizedLagSlots: 33, viewDivergenceSlots: 3, effectOnEntries: 'NONE', reasons: [] });
    expect(r.lastAdvanceAt).toBe(T0);
    expect(chainAcceptsSubmissions(r.snapshot.state)).toBe(true);
  });

  it('a halt (no head advance for the policy window) is STALLED and blocks entries; a shorter pause is not yet a halt', () => {
    const halted = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_970)], previous: prev(10_000, policy.maxSlotStallMs), policy, now: T0 });
    expect(halted.snapshot).toMatchObject({ state: 'STALLED', slotAdvanced: false, effectOnEntries: 'BLOCK' });
    expect(halted.snapshot.reasons[0]).toMatch(/no confirmed slot advance/);
    expect(halted.lastAdvanceAt).toBe(addMs(T0, -policy.maxSlotStallMs));
    const brief = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_970)], previous: prev(10_000, 5_000), policy, now: T0 });
    expect(brief.snapshot).toMatchObject({ state: 'HEALTHY', slotAdvanced: false, effectOnEntries: 'NONE' });
    expect(chainAcceptsSubmissions('STALLED')).toBe(false);
  });

  it('finality lag: above the warn level is LAGGING (entries allowed), above the block level is STALLED', () => {
    const lagging = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 10_000 - policy.lagWarnSlots - 1)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(lagging.snapshot).toMatchObject({ state: 'LAGGING', effectOnEntries: 'NONE', confirmedFinalizedLagSlots: policy.lagWarnSlots + 1 });
    const stalled = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 10_000 - policy.lagBlockSlots - 1)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(stalled.snapshot).toMatchObject({ state: 'STALLED', effectOnEntries: 'BLOCK' });
    expect(stalled.snapshot.reasons.join()).toMatch(/finality lag/);
  });

  it('views that disagree by more than the policy allows are DIVERGENT and block entries', () => {
    const r = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_970), view('secondary', 10_000 - policy.maxViewDivergenceSlots - 1, 9_800)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(r.snapshot).toMatchObject({ state: 'DIVERGENT', effectOnEntries: 'BLOCK', viewDivergenceSlots: policy.maxViewDivergenceSlots + 1 });
  });

  it('no answering view is UNAVAILABLE and blocks; one failed view of two is recorded but the healthy one decides', () => {
    const none = evaluateChainHealth({ id: ID, views: [view('primary', null, null), view('secondary', null, null)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(none.snapshot).toMatchObject({ state: 'UNAVAILABLE', headSlot: null, effectOnEntries: 'BLOCK' });
    expect(none.snapshot.reasons).toEqual(['no RPC view answered', 'primary: timeout', 'secondary: timeout']);
    expect(none.lastAdvanceAt).toBe(addMs(T0, -5_000));
    const one = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_970), view('secondary', null, null)], previous: prev(9_990, 5_000), policy, now: T0 });
    expect(one.snapshot).toMatchObject({ state: 'HEALTHY', viewDivergenceSlots: null, effectOnEntries: 'NONE', reasons: ['secondary unavailable: timeout'] });
  });

  it('the first sample has no previous head: advancement is unknown and cannot be a halt', () => {
    const r = evaluateChainHealth({ id: ID, views: [view('primary', 10_000, 9_970)], previous: null, policy, now: T0 });
    expect(r.snapshot).toMatchObject({ state: 'HEALTHY', slotAdvanced: null });
    expect(r.lastAdvanceAt).toBe(T0);
  });
});
