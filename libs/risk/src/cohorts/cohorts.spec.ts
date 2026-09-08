import fc from 'fast-check';
import { DEFAULT_CORRELATION_CLUSTER_POLICY, toInstant, type Amount, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { clusterByCorrelation, clusterFor, clusterSetOf, pearson, sampledReturns, type ClusterInput } from './clusters.js';
import { clusterForAsset, cohortForAsset, cohortUsage } from './exposure.js';

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const policy = { ...DEFAULT_CORRELATION_CLUSTER_POLICY, minSamples: 20 };

/** A price path from a shared factor plus idiosyncratic noise, deterministic per seed. */
function series(seed: number, factor: number[], beta: number, noise: number): Map<number, number> {
  let x = seed * 7919;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  const out = new Map<number, number>();
  for (let i = 0; i < factor.length; i++) out.set(T0 + (i + 1) * 300_000, beta * factor[i]! + noise * rnd());
  return out;
}
function factor(seed: number, n: number): number[] {
  let x = seed * 104729;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  return Array.from({ length: n }, () => rnd() * 0.02);
}

describe('deterministic correlation clusters (§6.3, §8.4, D23)', () => {
  it('samples log returns at the policy spacing only across contiguous samples, and pearson behaves', () => {
    const closes = [0, 1, 2, 3, 4, 5, 10, 11].map((m) => ({ bucketTime: toInstant(T0 + m * 60_000) as Instant, close: 100 + m }));
    const r = sampledReturns(closes, 5);
    // 0 → 5 contiguous; 5 → 10 contiguous; nothing else lands on a 5m boundary
    expect([...r.keys()]).toEqual([T0 + 5 * 60_000, T0 + 10 * 60_000]);
    expect(r.get(T0 + 5 * 60_000)).toBeCloseTo(Math.log(105 / 100), 12);
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it('groups assets that share a factor, leaves independent and under-sampled assets unknown, and is a pure function of its inputs', () => {
    const fA = factor(1, 60);
    const fB = factor(2, 60);
    const inputs: ClusterInput[] = [
      { assetId: id(1), returns: series(11, fA, 1, 0.002) },
      { assetId: id(2), returns: series(12, fA, 1.2, 0.002) },
      { assetId: id(3), returns: series(13, fA, 0.8, 0.002) },
      { assetId: id(4), returns: series(14, fB, 1, 0.002) },
      { assetId: id(5), returns: series(15, fB, 1.1, 0.002) },
      { assetId: id(6), returns: series(16, factor(6, 60), 0, 0.02) }, // pure noise
      { assetId: id(7), returns: new Map([...series(17, fA, 1, 0.002)].slice(0, 5)) }, // too few samples
    ];
    const r = clusterByCorrelation(inputs, policy);
    expect(r.clusters.map((c) => c.assetIds)).toEqual([[id(1), id(2), id(3)], [id(4), id(5)]]);
    expect(r.unclustered).toEqual([id(6), id(7)]);
    // permutation invariance
    const shuffled = clusterByCorrelation([...inputs].reverse(), policy);
    expect(shuffled).toEqual(r);
    const set = clusterSetOf(id(99), r, policy, toInstant(T0 + 3_600_000) as Instant, toInstant(T0 + 3_600_000) as Instant);
    expect(set.versionId).toBe(`clusters-v1@${toInstant(T0 + 3_600_000)}`);
    expect(clusterFor(set, id(2))).toBe(r.clusters[0]!.clusterId);
    expect(clusterFor(set, id(6))).toBeNull();
    expect(clusterFor(null, id(1))).toBeNull();
  });

  it('property: clusters partition the eligible assets, respect the minimum size, and never depend on input order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 2, max: 8 }), (seed, n) => {
        const f = factor(seed, 40);
        const inputs: ClusterInput[] = Array.from({ length: n }, (_, i) => ({ assetId: id(i + 1), returns: series(seed + i, f, i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 0.002 : 0.02) }));
        const r = clusterByCorrelation(inputs, policy);
        const placed = [...r.clusters.flatMap((c) => c.assetIds), ...r.unclustered].sort();
        expect(placed).toEqual(inputs.map((i) => i.assetId).sort());
        for (const c of r.clusters) expect(c.assetIds.length).toBeGreaterThanOrEqual(policy.minClusterSize);
        expect(clusterByCorrelation([...inputs].reverse(), policy)).toEqual(r);
      }),
      { numRuns: 40 },
    );
  });
});

describe('cohort and cluster exposure for the risk core (§13.1, ADR-0007)', () => {
  const memberships = [
    { assetId: id(1), cohortId: id(90), cohortName: 'memes' },
    { assetId: id(2), cohortId: id(90), cohortName: 'memes' },
    { assetId: id(2), cohortId: id(91), cohortName: 'dex-defi' },
    { assetId: id(3), cohortId: id(91), cohortName: 'dex-defi' },
  ];
  const positions = [{ assetId: id(1), costBasis: '300' as Amount }, { assetId: id(3), costBasis: '100' as Amount }];
  const equity = '1000' as Amount;

  it('sums cost basis per cohort as a fraction of equity, judges a multi-cohort asset against its most used cohort, and leaves an unlisted asset unknown', () => {
    const usage = cohortUsage(positions, memberships, equity);
    expect(usage.get('memes')).toEqual({ id: 'memes', usedFraction: 0.3 });
    expect(usage.get('dex-defi')).toEqual({ id: 'dex-defi', usedFraction: 0.1 });
    expect(cohortForAsset(id(2), positions, memberships, equity)).toEqual({ id: 'memes', usedFraction: 0.3 });
    expect(cohortForAsset(id(3), positions, memberships, equity)).toEqual({ id: 'dex-defi', usedFraction: 0.1 });
    expect(cohortForAsset(id(4), positions, memberships, equity)).toBeNull();
    expect(cohortForAsset(id(1), [], memberships, '0' as Amount)).toEqual({ id: 'memes', usedFraction: 0 });
  });

  it('cluster exposure follows the cluster set and is unknown outside it', () => {
    const set = { id: id(99), versionId: 'clusters-v1@x' as never, windowStart: toInstant(T0) as Instant, windowEnd: toInstant(T0) as Instant, calculatedAt: toInstant(T0) as Instant, method: 'm', clusters: [{ clusterId: 'c1', assetIds: [id(1), id(2)] }] };
    expect(clusterForAsset(id(2), positions, set, equity)).toEqual({ id: 'c1', usedFraction: 0.3 });
    expect(clusterForAsset(id(3), positions, set, equity)).toBeNull();
    expect(clusterForAsset(id(1), positions, null, equity)).toBeNull();
  });

  it('property: every usage fraction is in [0, 1] when exposure never exceeds equity, and the chosen cohort is the maximum over the asset\'s memberships', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ asset: fc.integer({ min: 1, max: 5 }), cohort: fc.integer({ min: 1, max: 3 }) }), { maxLength: 10 }), fc.array(fc.record({ asset: fc.integer({ min: 1, max: 5 }), cost: fc.integer({ min: 0, max: 200 }) }), { maxLength: 5 }), (ms, ps) => {
        const mem = ms.map((m) => ({ assetId: id(m.asset), cohortId: id(80 + m.cohort), cohortName: `c${m.cohort}` }));
        const pos = ps.map((p) => ({ assetId: id(p.asset), costBasis: String(p.cost) as Amount }));
        const usage = cohortUsage(pos, mem, '1000' as Amount);
        for (const u of usage.values()) expect(u.usedFraction >= 0 && u.usedFraction <= 1).toBe(true);
        for (let a = 1; a <= 5; a++) {
          const chosen = cohortForAsset(id(a), pos, mem, '1000' as Amount);
          const mine = mem.filter((m) => m.assetId === id(a)).map((m) => usage.get(m.cohortName)!.usedFraction);
          if (mine.length === 0) expect(chosen).toBeNull();
          else expect(chosen!.usedFraction).toBe(Math.max(...mine));
        }
      }),
    );
  });
});
