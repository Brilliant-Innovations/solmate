import { addMs, type Clock, type Instant, type IntelligenceEvent, type NormalizationPolicy, type Uuid } from '@sol-agent-trader/contracts';
import type { ClusterCandidateRow, EventInsert } from '@sol-agent-trader/db/server';
import { EntityIndex, assignCluster, normalizeEvent, type AssetEntity, type RawSourceEvent } from '@sol-agent-trader/intelligence';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `intel-ingest` (blueprint §3.4–3.5, §6.6, §10.1–10.4, §18.3, D64; execution plan
 * M6 P4). Each tick pulls recent news for the tracked symbols and social metrics per tracked asset,
 * normalizes every item through the shared pipeline (two clocks, pinned source quality, entity
 * resolution), assigns it to a dedupe cluster against the recent window, and upserts it: a repeat
 * only advances `last_seen_at`. Providers are behind interfaces so the role runs on fakes without
 * keys; with keys absent the loop is disabled with a logged reason.
 */

export interface IntelSources {
  /** Recent news for these symbols (batched by the provider's limit); null when the provider is not configured. */
  news: ((symbols: readonly string[]) => Promise<RawSourceEvent[]>) | null;
  /** Social metrics for one symbol; null when the provider is not configured. */
  social: ((symbol: string) => Promise<RawSourceEvent | null>) | null;
}

export interface IntelRepo {
  listAssetEntities(): Promise<AssetEntity[]>;
  /** Symbols worth polling: tracked assets first, capped. */
  listTrackedSymbols(limit: number): Promise<{ assetId: Uuid; symbol: string }[]>;
  listEventsForClustering(at: Instant, windowMs: number): Promise<ClusterCandidateRow[]>;
  upsertEvent(e: EventInsert): Promise<{ id: Uuid; outcome: 'INSERTED' | 'SEEN_AGAIN' }>;
}

export interface IntelIngestDeps {
  sources: IntelSources;
  repo: IntelRepo;
  policy: NormalizationPolicy;
  clock: Clock;
  logger: Logger;
  config: { symbolsPerTick: number; newsBatch: number; socialPerTick: number };
}

export interface IntelIngestReport {
  symbols: number;
  fetched: { news: number; social: number };
  inserted: number;
  seenAgain: number;
  unmatched: number;
  clusters: { NEW: number; DUPLICATE: number; CORROBORATION: number };
  errors: { provider: string; error: string }[];
}

export async function runIntelIngestCycle(deps: IntelIngestDeps): Promise<IntelIngestReport> {
  const now = deps.clock.now();
  const report: IntelIngestReport = { symbols: 0, fetched: { news: 0, social: 0 }, inserted: 0, seenAgain: 0, unmatched: 0, clusters: { NEW: 0, DUPLICATE: 0, CORROBORATION: 0 }, errors: [] };
  const [entities, tracked] = await Promise.all([deps.repo.listAssetEntities(), deps.repo.listTrackedSymbols(deps.config.symbolsPerTick)]);
  const index = new EntityIndex(entities);
  report.symbols = tracked.length;
  const raws: RawSourceEvent[] = [];

  if (deps.sources.news && tracked.length > 0) {
    const symbols = [...new Set(tracked.map((t) => t.symbol.toUpperCase()))];
    for (let i = 0; i < symbols.length; i += deps.config.newsBatch) {
      try {
        const batch = await deps.sources.news(symbols.slice(i, i + deps.config.newsBatch));
        report.fetched.news += batch.length;
        raws.push(...batch);
      } catch (err) {
        report.errors.push({ provider: 'CRYPTOPANIC', error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
  }
  if (deps.sources.social) {
    for (const t of tracked.slice(0, deps.config.socialPerTick)) {
      try {
        const ev = await deps.sources.social(t.symbol);
        if (ev) {
          report.fetched.social += 1;
          raws.push({ ...ev, mints: [...ev.mints, ...entities.filter((e) => e.id === t.assetId).map((e) => e.mint)] });
        }
      } catch (err) {
        report.errors.push({ provider: 'LUNARCRUSH', error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
  }

  // Cluster against what was known before this tick, then against earlier arrivals of the same tick (oldest source time first).
  const recent: ClusterCandidateRow[] = raws.length > 0 ? await deps.repo.listEventsForClustering(now, deps.policy.dedupeWindowMs) : [];
  const ordered = raws.map((r) => ({ r, t: r.publishedAt ? Date.parse(r.publishedAt) : Number.MAX_SAFE_INTEGER })).sort((a, b) => a.t - b.t).map((x) => x.r);
  for (const raw of ordered) {
    try {
      const n = await normalizeEvent(raw, { firstSeenAt: now, policy: deps.policy, entities: index });
      if (n.event.assetIds.length === 0) {
        report.unmatched += 1;
        continue; // evidence that names none of our assets is not stored (§10.1: metadata for our universe only)
      }
      const cluster = assignCluster({ sourceUrlHash: n.event.sourceUrlHash, title: n.event.title, assetIds: n.event.assetIds, firstSeenAt: now }, recent, deps.policy);
      report.clusters[cluster.relation] += 1;
      const insert: EventInsert = { ...n.event, noveltyScore: cluster.noveltyScore, clusterId: cluster.clusterId, corroboratesEventId: cluster.corroboratesEventId };
      const stored = await deps.repo.upsertEvent(insert);
      if (stored.outcome === 'INSERTED') {
        report.inserted += 1;
        recent.push({ id: stored.id, clusterId: cluster.clusterId ?? stored.id, sourceUrlHash: n.event.sourceUrlHash, title: n.event.title, assetIds: n.event.assetIds, firstSeenAt: now });
      } else report.seenAgain += 1;
    } catch (err) {
      report.errors.push({ provider: raw.provider, error: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.logger.info('intel_ingest_cycle', { symbols: report.symbols, fetched: report.fetched, inserted: report.inserted, seenAgain: report.seenAgain, unmatched: report.unmatched, clusters: report.clusters, errors: report.errors.length, policy: deps.policy.version, window: addMs(now, -deps.policy.dedupeWindowMs) });
  for (const e of report.errors.slice(0, 5)) deps.logger.warn('intel_ingest_failed', e);
  return report;
}

export type { IntelligenceEvent };
