import { addMs, toInstant, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { bucketsBetween } from '../candles/resolution.js';
import { planIngestCycle, type TrackedAsset } from './plan.js';

const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 30));
const LAST_CLOSED = toInstant(Date.UTC(2026, 8, 6, 11, 59, 0));

const asset = (n: number, priority: TrackedAsset['priority'], held: Instant[] = []): TrackedAsset => ({
  assetId: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid,
  mintAddress: `Mint${n}`,
  priority,
  held: { '1m': held },
});

const base = {
  now: NOW,
  resolutions: { POSITION: ['1m'] as const, CANDIDATE: ['1m'] as const, WATCH: ['1m'] as const },
  lookbackBuckets: { '15s': 240, '1m': 60, '5m': 48, '15m': 32, '1h': 48, '4h': 42 },
  discoveryDue: true,
};

describe('ingest cycle planning (§5.4 risk-first, D63 backfill tagging)', () => {
  it('positions come first: their prices are CRITICAL and their candle gaps precede candidates and discovery', () => {
    const full = bucketsBetween(addMs(LAST_CLOSED, -59 * 60_000), LAST_CLOSED, '1m');
    const plan = planIngestCycle({ ...base, tracked: [asset(3, 'WATCH'), asset(2, 'CANDIDATE'), asset(1, 'POSITION', full.slice(0, 55))], cuBudget: 10_000, requestBudget: 100 });
    const kinds = plan.actions.map((a) => (a.kind === 'CANDLES' ? `CANDLES:${a.priority}:${a.provenance}` : a.kind === 'PRICES' ? `PRICES:${a.priority}` : a.kind));
    expect(kinds[0]).toBe('PRICES:CRITICAL');
    expect(kinds[1]).toBe('CANDLES:POSITION:LIVE');
    expect(kinds.indexOf('CANDLES:CANDIDATE:LIVE')).toBeLessThan(kinds.indexOf('CANDLES:WATCH:LIVE'));
    expect(kinds.at(-2)).toBe('DISCOVERY_TRENDING');
    expect(kinds.at(-1)).toBe('DISCOVERY_NEW_LISTINGS');
    expect(plan.deferred).toBe(0);
  });

  it('a run of missing buckets that does not reach the last closed bucket is BACKFILL, one that does is LIVE', () => {
    const full = bucketsBetween(addMs(LAST_CLOSED, -59 * 60_000), LAST_CLOSED, '1m');
    const held = full.filter((_, i) => i < 10 || (i >= 20 && i <= 58)); // gap 10..19 (old) and 59 (latest)
    const plan = planIngestCycle({ ...base, discoveryDue: false, tracked: [asset(1, 'WATCH', held)], cuBudget: 10_000, requestBudget: 100 });
    const candles = plan.actions.filter((a) => a.kind === 'CANDLES');
    expect(candles.map((c) => c.provenance)).toEqual(['BACKFILL', 'LIVE']);
  });

  it('cuts NORMAL work to the budget but never the CRITICAL position prices', () => {
    const tracked = [asset(1, 'POSITION'), ...Array.from({ length: 30 }, (_, i) => asset(10 + i, 'WATCH'))];
    const plan = planIngestCycle({ ...base, tracked, cuBudget: 100, requestBudget: 3 });
    expect(plan.actions[0]).toMatchObject({ kind: 'PRICES', priority: 'CRITICAL' });
    expect(plan.actions.filter((a) => !(a.kind === 'PRICES' && a.priority === 'CRITICAL')).length).toBeLessThanOrEqual(3);
    expect(plan.cuPlanned).toBeLessThanOrEqual(100 + 3);
    expect(plan.deferred).toBeGreaterThan(0);
  });

  it('with everything held, nothing but prices and discovery is planned', () => {
    const full = bucketsBetween(addMs(LAST_CLOSED, -59 * 60_000), LAST_CLOSED, '1m');
    const plan = planIngestCycle({ ...base, tracked: [asset(1, 'CANDIDATE', full)], cuBudget: 1000, requestBudget: 10 });
    expect(plan.actions.map((a) => a.kind)).toEqual(['PRICES', 'DISCOVERY_TRENDING', 'DISCOVERY_NEW_LISTINGS']);
  });
});
