import { DEFAULT_COHORT_TAXONOMY, DEFAULT_CORRELATION_CLUSTER_POLICY, addMs, fixedClock, toInstant, type Candle, type CorrelationClusterSet, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { clusterWindowEnd, installCohortTaxonomy, runCohortsCycle, type CohortsRepo } from './cohorts.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 27, 42));
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const logger = createLogger({ service: 'worker', sink: () => undefined });

function candlesFor(assetId: Uuid, from: Instant, minutes: number, path: (i: number) => number): Candle[] {
  return Array.from({ length: minutes }, (_, i) => {
    const t = addMs(from, i * 60_000);
    const close = path(i);
    return { assetId, provider: 'BIRDEYE', resolution: '1m', bucketTime: t, observedAt: t, provenance: 'LIVE', open: close, high: close, low: close, close, volumeUsd: 1, tradeCount: null } as Candle;
  });
}

describe('worker cohorts role (§6.3, §8.4, D23)', () => {
  it('installs the taxonomy once per start, clusters assets that move together from stored candles, and stores one set per hourly window', async () => {
    const stored: CorrelationClusterSet[] = [];
    const installs: string[] = [];
    const windowEnd = clusterWindowEnd(NOW);
    expect(windowEnd).toBe('2026-09-08T15:00:00.000Z');
    const windowStart = addMs(windowEnd, -DEFAULT_CORRELATION_CLUSTER_POLICY.windowMs);
    const wave = (phase: number, amp: number) => (i: number) => 100 + amp * Math.sin(i / 37 + phase) + 0.01 * Math.cos(i / 5 + phase * 3);
    const repo: CohortsRepo = {
      installTaxonomy: async (t) => { installs.push(t.version); return { version: t.version, cohorts: t.cohorts.length, memberships: 3, unknownMints: t.memberships.length - 3 }; },
      listAssetsWithCandles: async () => [id(1), id(2), id(3), id(4)].map((assetId) => ({ assetId, candles: 1440 })),
      loadCandles: async (assetId, _r, from) => {
        if (assetId === id(1)) return candlesFor(assetId, from, 1440, wave(0, 5));
        if (assetId === id(2)) return candlesFor(assetId, from, 1440, wave(0.01, 6));
        if (assetId === id(3)) return candlesFor(assetId, from, 1440, wave(1.9, 5));
        return candlesFor(assetId, from, 30, wave(0, 5)); // too short to sample
      },
      insertClusterSet: async (set) => { if (stored.some((s) => s.versionId === set.versionId)) return 'EXISTS'; stored.push(set); return 'INSERTED'; },
    };
    await installCohortTaxonomy({ repo, logger, taxonomy: DEFAULT_COHORT_TAXONOMY });
    expect(installs).toEqual([DEFAULT_COHORT_TAXONOMY.version]);
    const deps = { repo, clock: fixedClock(NOW), logger, taxonomy: DEFAULT_COHORT_TAXONOMY, clusterPolicy: DEFAULT_CORRELATION_CLUSTER_POLICY, config: { maxAssets: 100 } };
    const r = await runCohortsCycle(deps);
    expect(r).toMatchObject({ windowEnd, assets: 4, clusters: 1, clustered: 2, unclustered: 2, stored: 'INSERTED', errors: [] });
    expect(stored[0]!.clusters[0]!.assetIds).toEqual([id(1), id(2)]);
    expect(stored[0]!.windowStart).toBe(windowStart);
    expect(stored[0]!.versionId).toBe(`clusters-v1@${windowEnd}`);
    // the same hour again: nothing new is stored
    const again = await runCohortsCycle(deps);
    expect(again.stored).toBe('EXISTS');
    expect(stored).toHaveLength(1);
  });
});
