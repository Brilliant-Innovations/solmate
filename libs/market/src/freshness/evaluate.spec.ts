import fc from 'fast-check';
import { addMs, toInstant, type FreshnessContract, FRESHNESS_REQUIREMENTS } from '@sol-agent-trader/contracts';
import { defaultFreshnessContracts, entriesBlocked, evaluateFreshness } from './evaluate.js';

const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));
const contract: FreshnessContract = { provider: 'BIRDEYE', dataClass: 'CANDIDATE_PRICE', freshMaxAgeMs: 30_000, degradedMaxAgeMs: 90_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' };

describe('freshness → health (§21.1, §21.2)', () => {
  it('a feed that never succeeded is FAILED and blocks entries; a stale WebSocket cannot look healthy', () => {
    const h = evaluateFreshness(contract, { lastSuccessAt: null, now: NOW });
    expect(h.state).toBe('FAILED');
    expect(h.effectOnEntries).toBe('BLOCK');
    expect(h.freshnessAgeMs).toBeNull();
    expect(entriesBlocked([h]).blocked).toBe(true);
  });

  /**
   * DEFECT-4 (2026-09-09), measured on the hosted project before being fixed: `BIRDEYE:CANDLES`
   * reported HEALTHY with `freshness_age_ms: 2306` while the newest 1m candle for all 43 eligible
   * assets was 232–347 minutes old, because the worker keeps calling OHLCV successfully and the call
   * returns nothing new 78% of the time. ADR-0011's BLOCK for candles could therefore never fire.
   */
  it('a succeeding call over a store that has stopped advancing is stale, not healthy', () => {
    const candles: FreshnessContract = { provider: 'BIRDEYE', dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' };
    // The exact shape observed: we spoke to the provider 2.3s ago, the newest datum is five hours old.
    const h = evaluateFreshness(candles, { lastSuccessAt: addMs(NOW, -2_306), newestDatumAt: addMs(NOW, -307 * 60_000), now: NOW });
    expect(h.state).toBe('FAILED');
    expect(h.effectOnEntries).toBe('BLOCK');
    expect(h.freshnessAgeMs).toBe(307 * 60_000);
    expect(entriesBlocked([h]).blocked).toBe(true);

    // The feed is only as fresh as the worse of the two: a recent datum does not excuse a provider
    // that has stopped answering either.
    const stalled = evaluateFreshness(candles, { lastSuccessAt: addMs(NOW, -600_000), newestDatumAt: addMs(NOW, -1_000), now: NOW });
    expect(stalled.state).toBe('FAILED');

    // Both current is the only way to be HEALTHY.
    const good = evaluateFreshness(candles, { lastSuccessAt: addMs(NOW, -2_000), newestDatumAt: addMs(NOW, -30_000), now: NOW });
    expect(good.state).toBe('HEALTHY');
    expect(good.effectOnEntries).toBe('NONE');

    // A class backed by a store that holds nothing is FAILED, not "as fresh as our last call".
    const empty = evaluateFreshness(candles, { lastSuccessAt: addMs(NOW, -1_000), newestDatumAt: null, now: NOW });
    expect(empty.state).toBe('FAILED');
    expect(empty.freshnessAgeMs).toBeNull();

    // A class where the call *is* the datum omits the field and keeps call-recency semantics.
    const callOnly = evaluateFreshness(candles, { lastSuccessAt: addMs(NOW, -2_000), now: NOW });
    expect(callOnly.state).toBe('HEALTHY');
  });

  it('property: state is monotone in age and HEALTHY never blocks entries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600_000 }), (age) => {
        const h = evaluateFreshness(contract, { lastSuccessAt: addMs(NOW, -age), now: NOW });
        const expected = age <= 30_000 ? 'HEALTHY' : age <= 90_000 ? 'DEGRADED' : 'FAILED';
        expect(h.state).toBe(expected);
        expect(h.effectOnEntries).toBe(expected === 'HEALTHY' ? 'NONE' : 'BLOCK');
        expect(h.freshnessAgeMs).toBe(age);
      }),
    );
  });

  it('an exhausted compute-unit budget degrades an otherwise fresh feed', () => {
    const h = evaluateFreshness(contract, { lastSuccessAt: NOW, now: NOW, rateLimitState: 'EXHAUSTED' });
    expect(h.state).toBe('DEGRADED');
  });

  it('contracts follow the strategy speed tier, not the purchased provider tier (ADR-0011); every class is covered', () => {
    const std = defaultFreshnessContracts(FRESHNESS_REQUIREMENTS.T2_SLOW);
    const prem = defaultFreshnessContracts(FRESHNESS_REQUIREMENTS.T0_FAST);
    expect(defaultFreshnessContracts()).toEqual(defaultFreshnessContracts(FRESHNESS_REQUIREMENTS.T1_STANDARD));
    const pick = (cs: FreshnessContract[], cls: string) => cs.find((c) => c.dataClass === cls && c.provider === 'BIRDEYE')!;
    expect(pick(std, 'ACTIVE_POSITION_PRICE').freshMaxAgeMs).toBeGreaterThan(pick(prem, 'ACTIVE_POSITION_PRICE').freshMaxAgeMs);
    for (const c of [...std, ...prem]) {
      expect(c.degradedMaxAgeMs).toBeGreaterThanOrEqual(c.freshMaxAgeMs);
    }
    const classes = new Set(std.map((c) => c.dataClass));
    expect(classes.size).toBe(9);
    expect(std.some((c) => c.provider === 'JUPITER_PRICE_V3' && c.dataClass === 'ACTIVE_POSITION_PRICE')).toBe(true);
  });
});
