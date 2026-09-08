import { type CorrelationClusterPolicy, type CorrelationClusterSet, type Instant, type Uuid, type VersionId, instantToMs, toInstant } from '@sol-agent-trader/contracts';

/**
 * Deterministic rolling return-correlation clusters (blueprint §6.3, §8.4, D23). Pure functions
 * of candle closes and the versioned policy: the same inputs always yield the same cluster set,
 * so a cluster limit can be audited and replayed. No provider, no randomness, no LLM.
 */

export interface CloseSample {
  bucketTime: Instant;
  close: number;
}

/** Log returns sampled every `sampleMinutes` from 1m closes, keyed by the sample's bucket time. */
export function sampledReturns(closes: readonly CloseSample[], sampleMinutes: number): Map<number, number> {
  const step = sampleMinutes * 60_000;
  const byBucket = new Map<number, number>();
  for (const c of closes) {
    const t = instantToMs(c.bucketTime);
    if (t % step === 0 && c.close > 0) byBucket.set(t, c.close);
  }
  const times = [...byBucket.keys()].sort((a, b) => a - b);
  const out = new Map<number, number>();
  for (let i = 1; i < times.length; i++) {
    const t = times[i]!;
    const prev = times[i - 1]!;
    if (t - prev !== step) continue;
    out.set(t, Math.log(byBucket.get(t)! / byBucket.get(prev)!));
  }
  return out;
}

export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

export interface ClusterInput {
  assetId: Uuid;
  returns: Map<number, number>;
}

export interface ClusterResult {
  clusters: { clusterId: string; assetIds: Uuid[] }[];
  /** Assets with too few aligned samples to be placed anywhere. */
  unclustered: Uuid[];
  pairs: number;
}

/**
 * Average-linkage agglomerative clustering over pairwise Pearson correlation of aligned returns.
 * Assets are processed in id order; at each step the pair of groups with the highest mean
 * correlation merges if it is at least `linkThreshold` (ties: lexicographically smaller member
 * ids first). Groups below `minClusterSize` are reported as singletons and count as unknown.
 */
export function clusterByCorrelation(inputs: readonly ClusterInput[], policy: CorrelationClusterPolicy): ClusterResult {
  const sorted = [...inputs].sort((x, y) => (x.assetId < y.assetId ? -1 : x.assetId > y.assetId ? 1 : 0));
  const eligible = sorted.filter((i) => i.returns.size >= policy.minSamples);
  const unclustered = sorted.filter((i) => i.returns.size < policy.minSamples).map((i) => i.assetId);
  const n = eligible.length;
  const corr: (number | null)[][] = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a: number[] = [];
      const b: number[] = [];
      for (const [t, r] of eligible[i]!.returns) {
        const s = eligible[j]!.returns.get(t);
        if (s !== undefined) {
          a.push(r);
          b.push(s);
        }
      }
      const c = a.length >= policy.minSamples ? pearson(a, b) : null;
      corr[i]![j] = c;
      corr[j]![i] = c;
      if (c !== null) pairs++;
    }
  }
  let groups: number[][] = eligible.map((_, i) => [i]);
  const linkage = (g1: number[], g2: number[]): number | null => {
    let sum = 0;
    let count = 0;
    for (const i of g1) for (const j of g2) {
      const c = corr[i]![j];
      if (c === null) return null; // a missing pair means the groups cannot be judged together
      sum += c;
      count++;
    }
    return count ? sum / count : null;
  };
  for (;;) {
    let best: { a: number; b: number; score: number } | null = null;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const score = linkage(groups[a]!, groups[b]!);
        if (score === null || score < policy.linkThreshold) continue;
        if (!best || score > best.score) best = { a, b, score };
      }
    }
    if (!best) break;
    const merged = [...groups[best.a]!, ...groups[best.b]!].sort((x, y) => x - y);
    groups = groups.filter((_, i) => i !== best!.a && i !== best!.b);
    groups.push(merged);
    groups.sort((x, y) => x[0]! - y[0]!);
  }
  const clusters: ClusterResult['clusters'] = [];
  let ordinal = 0;
  for (const g of groups) {
    const assetIds = g.map((i) => eligible[i]!.assetId);
    if (assetIds.length < policy.minClusterSize) {
      unclustered.push(...assetIds);
      continue;
    }
    clusters.push({ clusterId: `c${++ordinal}-${assetIds[0]!.slice(0, 8)}`, assetIds });
  }
  unclustered.sort();
  return { clusters, unclustered, pairs };
}

export function clusterSetOf(id: Uuid, result: ClusterResult, policy: CorrelationClusterPolicy, windowEnd: Instant, calculatedAt: Instant): CorrelationClusterSet {
  return {
    id,
    versionId: `${policy.version}@${windowEnd}` as VersionId,
    windowStart: toInstant(instantToMs(windowEnd) - policy.windowMs),
    windowEnd,
    calculatedAt,
    method: `average-linkage pearson log-returns ${policy.sampleMinutes}m threshold ${policy.linkThreshold} min ${policy.minSamples} samples`,
    clusters: result.clusters,
  };
}

/** The cluster an asset belongs to in a set, or null when it was not clustered (unknown capacity). */
export function clusterFor(set: CorrelationClusterSet | null, assetId: Uuid): string | null {
  if (!set) return null;
  return set.clusters.find((c) => c.assetIds.includes(assetId))?.clusterId ?? null;
}
