import { instantToMs, type Instant, type NormalizationPolicy, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { normalizeTitle } from './normalize.js';

/**
 * News deduplication (blueprint §10.2): ten sites repeating one press release are one catalyst.
 * A new event joins an existing cluster when it shares the canonical URL, when its normalized
 * title is similar enough, or (weaker, recorded as corroboration) when it names the same assets
 * and its title is at least loosely similar inside the window. Clusters are keyed by their first
 * event's id, so the cluster id is stable and never depends on processing order beyond arrival.
 * Duplicates are judged on word-pair shingles (same wording); corroboration on shared words
 * (same story, different wording). Novelty is one minus the strongest similarity to what was known.
 */

export interface ClusterCandidate {
  id: Uuid;
  clusterId: Uuid | null;
  sourceUrlHash: Sha256Hex | null;
  title: string | null;
  assetIds: readonly Uuid[];
  firstSeenAt: Instant;
}

export interface ClusterAssignment {
  relation: 'NEW' | 'DUPLICATE' | 'CORROBORATION';
  clusterId: Uuid | null;
  corroboratesEventId: Uuid | null;
  noveltyScore: number;
  similarity: number;
}

export function shingles(title: string | null, size: number): Set<string> {
  const tokens = normalizeTitle(title).split(' ').filter((t) => t.length > 0);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < size) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i + size <= tokens.length; i++) out.add(tokens.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function assignCluster(draft: { sourceUrlHash: Sha256Hex | null; title: string | null; assetIds: readonly Uuid[]; firstSeenAt: Instant }, recent: readonly ClusterCandidate[], policy: NormalizationPolicy): ClusterAssignment {
  const since = instantToMs(draft.firstSeenAt) - policy.dedupeWindowMs;
  const mine = shingles(draft.title, policy.shingleSize);
  const myWords = shingles(draft.title, 1);
  const myAssets = new Set(draft.assetIds);
  let best: { c: ClusterCandidate; similarity: number; relation: 'DUPLICATE' | 'CORROBORATION' } | null = null;
  // Deterministic order: oldest first, then id.
  const ordered = [...recent].filter((c) => instantToMs(c.firstSeenAt) >= since && instantToMs(c.firstSeenAt) <= instantToMs(draft.firstSeenAt)).sort((x, y) => instantToMs(x.firstSeenAt) - instantToMs(y.firstSeenAt) || (x.id < y.id ? -1 : 1));
  for (const c of ordered) {
    const sameUrl = draft.sourceUrlHash !== null && c.sourceUrlHash === draft.sourceUrlHash;
    const phrase = sameUrl ? 1 : jaccard(mine, shingles(c.title, policy.shingleSize));
    const words = sameUrl ? 1 : jaccard(myWords, shingles(c.title, 1));
    const similarity = Math.max(phrase, words);
    const sharesAsset = c.assetIds.some((a) => myAssets.has(a));
    let relation: 'DUPLICATE' | 'CORROBORATION' | null = null;
    if (sameUrl || phrase >= policy.titleSimilarityThreshold) relation = 'DUPLICATE';
    else if (sharesAsset && words >= policy.entitySimilarityThreshold) relation = 'CORROBORATION';
    if (relation && (!best || similarity > best.similarity)) best = { c, similarity, relation };
  }
  if (!best) return { relation: 'NEW', clusterId: null, corroboratesEventId: null, noveltyScore: 1, similarity: 0 };
  return { relation: best.relation, clusterId: best.c.clusterId ?? best.c.id, corroboratesEventId: best.c.id, noveltyScore: Math.max(0, 1 - best.similarity), similarity: best.similarity };
}
