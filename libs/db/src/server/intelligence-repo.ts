import type { Instant, IntelligenceEvent, MintAddress, Sha256Hex, Uuid } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';

/**
 * Intelligence events (blueprint §6.6, §10, §18.3; INV-13). Writes: one row per (provider,
 * sourceId), where a repeated fetch may only advance `last_seen_at` (source time, first-seen,
 * title and payload hash are the record of what was known and stay as written). Reads for
 * clustering look back a window; reads for decisions and replay take `at` and enforce
 * `first_seen_at <= at` in SQL, so no caller can be handed future evidence.
 */

export type EventInsert = Omit<IntelligenceEvent, 'id'> & { id?: Uuid };

export async function upsertEvent(sql: Sql, e: EventInsert): Promise<{ id: Uuid; outcome: 'INSERTED' | 'SEEN_AGAIN' }> {
  const rows = await sql<{ id: Uuid; inserted: boolean }[]>`
    insert into intelligence.events (id, kind, source_provider, source_id, source_url_hash, source_published_at, source_time_confidence, first_seen_at, last_seen_at, title, summary, source_quality, novelty_score, sentiment, classification, cluster_id, corroborates_event_id, payload_hash, raw_payload_ref)
    values (${e.id ?? sql`gen_random_uuid()`}, ${e.kind}, ${e.sourceProvider}, ${e.sourceId}, ${e.sourceUrlHash}, ${e.sourcePublishedAt}, ${e.sourceTimeConfidence}, ${e.firstSeenAt}, ${e.lastSeenAt}, ${e.title}, ${e.summary}, ${e.sourceQuality}, ${e.noveltyScore}, ${e.sentiment === null ? null : sql.json(e.sentiment)}, ${e.classification}, ${e.clusterId}, ${e.corroboratesEventId}, ${e.payloadHash}, ${e.rawPayloadRef})
    on conflict (source_provider, source_id) do update set last_seen_at = greatest(intelligence.events.last_seen_at, excluded.last_seen_at)
    returning id, (xmax = 0) as inserted`;
  const r = rows[0]!;
  if (r.inserted && e.assetIds.length) {
    for (const assetId of e.assetIds) await sql`insert into intelligence.event_assets (event_id, asset_id) values (${r.id}, ${assetId}) on conflict do nothing`;
  }
  return { id: r.id, outcome: r.inserted ? 'INSERTED' : 'SEEN_AGAIN' };
}

export interface ClusterCandidateRow {
  id: Uuid;
  clusterId: Uuid | null;
  sourceUrlHash: Sha256Hex | null;
  title: string | null;
  assetIds: Uuid[];
  firstSeenAt: Instant;
}

/** Events first seen inside the window before `at` (for clustering a new arrival at `at`), oldest first. */
export async function listEventsForClustering(sql: Sql, at: Instant, windowMs: number, limit = 500): Promise<ClusterCandidateRow[]> {
  const since = new Date(new Date(at).getTime() - windowMs).toISOString();
  const rows = await sql<{ id: Uuid; cluster_id: Uuid | null; source_url_hash: Sha256Hex | null; title: string | null; first_seen_at: string; asset_ids: Uuid[] | null }[]>`
    select e.id, e.cluster_id, e.source_url_hash, e.title, e.first_seen_at, array_remove(array_agg(a.asset_id), null) as asset_ids
    from intelligence.events e left join intelligence.event_assets a on a.event_id = e.id
    where e.first_seen_at >= ${since} and e.first_seen_at <= ${at}
    group by e.id order by e.first_seen_at asc, e.id asc limit ${limit}`;
  return rows.map((r) => ({ id: r.id, clusterId: r.cluster_id, sourceUrlHash: r.source_url_hash, title: r.title, assetIds: r.asset_ids ?? [], firstSeenAt: new Date(r.first_seen_at).toISOString() as Instant }));
}

const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;

function rowToEvent(r: Record<string, unknown>): IntelligenceEvent {
  return {
    id: r['id'] as Uuid,
    kind: r['kind'] as IntelligenceEvent['kind'],
    sourceProvider: r['source_provider'] as string,
    sourceId: r['source_id'] as string,
    sourceUrlHash: (r['source_url_hash'] as Sha256Hex | null) ?? null,
    sourcePublishedAt: r['source_published_at'] ? iso(r['source_published_at']) : null,
    sourceTimeConfidence: r['source_time_confidence'] as IntelligenceEvent['sourceTimeConfidence'],
    firstSeenAt: iso(r['first_seen_at']),
    lastSeenAt: iso(r['last_seen_at']),
    assetIds: (r['asset_ids'] as Uuid[] | null) ?? [],
    title: (r['title'] as string | null) ?? null,
    summary: (r['summary'] as string | null) ?? null,
    sourceQuality: r['source_quality'] as IntelligenceEvent['sourceQuality'],
    noveltyScore: (r['novelty_score'] as number | null) ?? null,
    sentiment: (r['sentiment'] as IntelligenceEvent['sentiment']) ?? null,
    classification: (r['classification'] as string | null) ?? null,
    clusterId: (r['cluster_id'] as Uuid | null) ?? null,
    corroboratesEventId: (r['corroborates_event_id'] as Uuid | null) ?? null,
    payloadHash: r['payload_hash'] as Sha256Hex,
    rawPayloadRef: (r['raw_payload_ref'] as string | null) ?? null,
  };
}

/**
 * Point-in-time read (INV-13): events about `assetId` that were first seen at or before `at`,
 * newest first. `at` is the decision or replay clock; there is no variant of this query without it.
 */
export async function listEventsVisibleAt(sql: Sql, assetId: Uuid, at: Instant, limit = 50): Promise<IntelligenceEvent[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select e.*, (select array_remove(array_agg(x.asset_id), null) from intelligence.event_assets x where x.event_id = e.id) as asset_ids
    from intelligence.events e join intelligence.event_assets a on a.event_id = e.id
    where a.asset_id = ${assetId} and e.first_seen_at <= ${at}
    order by e.first_seen_at desc, e.id desc limit ${limit}`;
  return rows.map(rowToEvent);
}

/** The asset universe for entity matching: every known asset, whatever its eligibility. */
export async function listAssetEntities(sql: Sql): Promise<{ id: Uuid; mint: MintAddress; symbol: string; name: string }[]> {
  const rows = await sql<{ id: Uuid; mint_address: MintAddress; symbol: string; name: string }[]>`select id, mint_address, symbol, name from core.assets order by id`;
  return rows.map((r) => ({ id: r.id, mint: r.mint_address, symbol: r.symbol, name: r.name }));
}
