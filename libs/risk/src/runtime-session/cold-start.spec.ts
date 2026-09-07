import fc from 'fast-check';
import { addMs, DEFAULT_SESSION_POLICY, toInstant } from '@sol-agent-trader/contracts';
import { coldStartPassed, evaluateColdStartGates, presenceState, type ColdStartFacts } from './cold-start.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const healthy: ColdStartFacts = { authority: 'PAPER', reconciliations: [], blockingFeeds: [], universeRefreshedAt: addMs(NOW, -3_600_000), eligibleAssets: 9, trackedAssets: 40, warmAssets: 3, openPositions: 1, positionsWithStaleSafety: 0, liveChecksHealthy: null };

describe('cold-start gates and presence (D63, D2)', () => {
  it('a healthy paper deployment passes every gate; each fact failure fails exactly its gate', () => {
    const gates = evaluateColdStartGates(healthy, DEFAULT_SESSION_POLICY, NOW);
    expect(gates.map((g) => g.name)).toEqual(['RECONCILIATION_CLEAN', 'FEEDS_FRESH', 'UNIVERSE_REFRESHED', 'WARMUP_SUFFICIENT', 'HELD_ASSET_SAFETY_FRESH', 'AUTHORITY_CHECKS']);
    expect(coldStartPassed(gates)).toBe(true);
    const cases: [Partial<ColdStartFacts>, string][] = [
      [{ reconciliations: [{ accountId: 'a', status: 'MISMATCH' }] }, 'RECONCILIATION_CLEAN'],
      [{ reconciliations: [{ accountId: 'a', status: 'UNAVAILABLE' }] }, 'RECONCILIATION_CLEAN'],
      [{ blockingFeeds: ['birdeye'] }, 'FEEDS_FRESH'],
      [{ universeRefreshedAt: null }, 'UNIVERSE_REFRESHED'],
      [{ universeRefreshedAt: addMs(NOW, -2 * 86_400_000) }, 'UNIVERSE_REFRESHED'],
      [{ eligibleAssets: 0 }, 'UNIVERSE_REFRESHED'],
      [{ warmAssets: 0 }, 'WARMUP_SUFFICIENT'],
      [{ positionsWithStaleSafety: 1 }, 'HELD_ASSET_SAFETY_FRESH'],
      [{ authority: 'LIVE_AUTO', liveChecksHealthy: null }, 'AUTHORITY_CHECKS'],
      [{ authority: 'LIVE_APPROVAL', liveChecksHealthy: false }, 'AUTHORITY_CHECKS'],
    ];
    for (const [over, name] of cases) {
      const g = evaluateColdStartGates({ ...healthy, ...over }, DEFAULT_SESSION_POLICY, NOW);
      expect(g.filter((x) => !x.passed).map((x) => x.name), name).toEqual([name]);
      expect(coldStartPassed(g), name).toBe(false);
    }
    expect(coldStartPassed([])).toBe(false);
  });

  it('property: STARTING can never leave while any fact is unhealthy; warm-up needs real warm assets, not a zero threshold (D63)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 2 }), fc.constantFrom('PAPER', 'OBSERVE', 'LIVE_AUTO'), (mismatches, blocking, warm, stale, authority) => {
        const facts: ColdStartFacts = { ...healthy, authority: authority as ColdStartFacts['authority'], reconciliations: Array.from({ length: mismatches }, (_, i) => ({ accountId: String(i), status: 'MISMATCH' as const })), blockingFeeds: Array.from({ length: blocking }, (_, i) => `p${i}`), warmAssets: warm, positionsWithStaleSafety: stale, liveChecksHealthy: authority === 'LIVE_AUTO' ? false : null };
        const passed = coldStartPassed(evaluateColdStartGates(facts, { ...DEFAULT_SESSION_POLICY, minWarmAssets: 0 }, NOW));
        const expected = mismatches === 0 && blocking === 0 && warm > 0 && stale === 0 && authority !== 'LIVE_AUTO';
        expect(passed).toBe(expected);
      }),
    );
  });

  it('presence: attended sessions need a heartbeat inside the timeout; unattended never do', () => {
    expect(presenceState(true, null, NOW, DEFAULT_SESSION_POLICY)).toBe('ABSENT');
    expect(presenceState(true, addMs(NOW, -60_000), NOW, DEFAULT_SESSION_POLICY)).toBe('PRESENT');
    expect(presenceState(true, addMs(NOW, -DEFAULT_SESSION_POLICY.presenceTimeoutMs - 1), NOW, DEFAULT_SESSION_POLICY)).toBe('ABSENT');
    expect(presenceState(false, null, NOW, DEFAULT_SESSION_POLICY)).toBe('NOT_REQUIRED');
  });
});
