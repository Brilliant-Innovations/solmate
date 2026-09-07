import type { Candle, CandleResolution, DiscoveredToken, FeedHealth, Instant, MarketSnapshot, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Market-data persistence (blueprint §6.1, §6.4, §6.5, §21.1; execution plan M4).
 *
 * Rules enforced here, not left to callers:
 * - Assets are identified by mint. `first_observed_at` is written once and never moved: a token
 *   re-discovered later keeps the instant we first saw it (point-in-time first-seen, §31).
 * - Candles are idempotent by (asset, provider, resolution, bucket). A closed bucket is immutable;
 *   only a bucket that was still open when we last observed it may be replaced by a newer
 *   observation, and BACKFILL never overwrites LIVE.
 * - Snapshots are append-only (trigger) and written exactly as built.
 */

const RESOLUTION_MS: Readonly<Record<CandleResolution, number>> = { '15s': 15_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

export interface AssetRef {
  id: Uuid;
  mintAddress: string;
}

/** Upserts discovered tokens into core.assets and returns their ids; existing rows keep first_observed_at and status. */
export async function upsertDiscoveredAssets(sql: Sql, tokens: readonly DiscoveredToken[], now: Instant): Promise<AssetRef[]> {
  if (tokens.length === 0) return [];
  const rows = tokens.map((t) => ({
    mint_address: t.mintAddress,
    symbol: t.symbol.slice(0, 32),
    name: t.name.slice(0, 128),
    decimals: t.decimals,
    token_program: 'UNKNOWN',
    first_observed_at: now,
    estimated_created_at: t.listedAt,
  }));
  const out = await sql<{ id: string; mint_address: string }[]>`
    insert into core.assets (mint_address, symbol, name, decimals, token_program, first_observed_at, estimated_created_at)
    select mint_address, symbol, name, decimals, token_program::enums.token_program, first_observed_at, estimated_created_at
    from jsonb_to_recordset(${sql.json(asJson(rows))}) as x(
      mint_address text, symbol text, name text, decimals smallint, token_program text, first_observed_at timestamptz, estimated_created_at timestamptz)
    on conflict (mint_address) do update
      set symbol = excluded.symbol,
          name = excluded.name,
          estimated_created_at = coalesce(core.assets.estimated_created_at, excluded.estimated_created_at)
    returning id, mint_address`;
  return out.map((r) => ({ id: r.id as Uuid, mintAddress: r.mint_address }));
}

export interface CandleWriteResult {
  inserted: number;
  replacedOpen: number;
  ignored: number;
}

/** Idempotent candle write with the immutability rule above. */
export async function writeCandles(sql: Sql, candles: readonly Candle[]): Promise<CandleWriteResult> {
  if (candles.length === 0) return { inserted: 0, replacedOpen: 0, ignored: 0 };
  const rows = candles.map((c) => ({
    asset_id: c.assetId,
    provider: c.provider,
    resolution: c.resolution,
    bucket_time: c.bucketTime,
    observed_at: c.observedAt,
    provenance: c.provenance,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume_usd: c.volumeUsd,
    trade_count: c.tradeCount,
    resolution_ms: RESOLUTION_MS[c.resolution],
  }));
  const key = (r: { asset_id: string; provider: string; resolution: string; bucket_time: string }) => `${r.asset_id}|${r.provider}|${r.resolution}|${new Date(r.bucket_time).toISOString()}`;
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    const existing = await txSql<{ asset_id: string; provider: string; resolution: string; bucket_time: string }[]>`
      select c.asset_id, c.provider, c.resolution::text, c.bucket_time
      from market.candles c
      join jsonb_to_recordset(${txSql.json(asJson(rows))}) as x(asset_id uuid, provider text, resolution text, bucket_time timestamptz)
        on x.asset_id = c.asset_id and x.provider = c.provider and x.resolution::enums.candle_resolution = c.resolution and x.bucket_time = c.bucket_time`;
    const had = new Set(existing.map(key));
    const written = await txSql<{ asset_id: string; provider: string; resolution: string; bucket_time: string }[]>`
      with incoming as (
        select * from jsonb_to_recordset(${txSql.json(asJson(rows))}) as x(
          asset_id uuid, provider text, resolution text, bucket_time timestamptz, observed_at timestamptz, provenance text,
          open double precision, high double precision, low double precision, close double precision,
          volume_usd double precision, trade_count integer, resolution_ms bigint)
      )
      insert into market.candles (asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd, trade_count)
      select asset_id, provider, resolution::enums.candle_resolution, bucket_time, observed_at, provenance::enums.data_provenance, open, high, low, close, volume_usd, trade_count
      from incoming
      on conflict (asset_id, provider, resolution, bucket_time) do update
        set observed_at = excluded.observed_at, provenance = excluded.provenance,
            open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
            volume_usd = excluded.volume_usd, trade_count = excluded.trade_count
        where market.candles.observed_at < excluded.observed_at
          -- the stored row was written while its bucket was still open
          and market.candles.observed_at < market.candles.bucket_time + ((select resolution_ms from incoming i where i.asset_id = market.candles.asset_id and i.resolution::enums.candle_resolution = market.candles.resolution and i.bucket_time = market.candles.bucket_time limit 1) * interval '1 millisecond')
          -- backfill never overwrites a live observation
          and not (market.candles.provenance = 'LIVE' and excluded.provenance = 'BACKFILL')
      returning asset_id, provider, resolution::text, bucket_time`;
    let inserted = 0;
    let replacedOpen = 0;
    for (const w of written) {
      if (had.has(key(w))) replacedOpen++;
      else inserted++;
    }
    return { inserted, replacedOpen, ignored: candles.length - inserted - replacedOpen };
  });
}

/** Bucket times held for an asset and resolution within [from, to]. */
export async function heldBucketTimes(sql: Sql, assetId: Uuid, resolution: CandleResolution, from: Instant, to: Instant): Promise<Instant[]> {
  const rows = await sql<{ bucket_time: string }[]>`
    select bucket_time from market.candles
    where asset_id = ${assetId} and resolution = ${resolution} and bucket_time between ${from} and ${to}
    order by bucket_time`;
  return rows.map((r) => new Date(r.bucket_time).toISOString() as Instant);
}

export async function loadCandles(sql: Sql, assetId: Uuid, resolution: CandleResolution, from: Instant, to: Instant): Promise<Candle[]> {
  const rows = await sql<
    { asset_id: string; provider: string; resolution: CandleResolution; bucket_time: string; observed_at: string; provenance: Candle['provenance']; open: number; high: number; low: number; close: number; volume_usd: number; trade_count: number | null }[]
  >`
    select asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd, trade_count
    from market.candles
    where asset_id = ${assetId} and resolution = ${resolution} and bucket_time between ${from} and ${to}
    order by bucket_time`;
  return rows.map((r) => ({
    assetId: r.asset_id as Uuid,
    provider: r.provider,
    resolution: r.resolution,
    bucketTime: new Date(r.bucket_time).toISOString() as Instant,
    observedAt: new Date(r.observed_at).toISOString() as Instant,
    provenance: r.provenance,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volumeUsd: r.volume_usd,
    tradeCount: r.trade_count,
  }));
}

export async function insertSnapshot(sql: Sql, s: MarketSnapshot): Promise<void> {
  await sql`
    insert into market.snapshots (id, asset_id, as_of, observed_at, provenance, price_usd, liquidity_usd, volume_usd, buy_volume_usd, sell_volume_usd, buy_count, sell_count,
      relative_volume, atr, realized_volatility, returns, market_cap_usd, fdv_usd, sol_relative_return, universe_relative_strength, route_probes)
    values (${s.id}, ${s.assetId}, ${s.asOf}, ${s.observedAt}, ${s.provenance}, ${s.priceUsd}, ${s.liquidityUsd},
      ${sql.json(asJson(s.volumeUsd))}, ${sql.json(asJson(s.buyVolumeUsd))}, ${sql.json(asJson(s.sellVolumeUsd))}, ${sql.json(asJson(s.buyCount))}, ${sql.json(asJson(s.sellCount))},
      ${s.relativeVolume}, ${s.atr}, ${s.realizedVolatility}, ${sql.json(asJson(s.returns))}, ${s.marketCapUsd}, ${s.fdvUsd}, ${s.solRelativeReturn}, ${s.universeRelativeStrength},
      ${sql.json(asJson(s.routeProbes))})`;
}

export async function upsertFeedHealth(sql: Sql, h: FeedHealth): Promise<void> {
  await sql`
    insert into ops.provider_health (provider, state, last_success_at, latency_ms, freshness_age_ms, rate_limit_state, effect_on_entries, effect_on_exits, last_error, updated_at)
    values (${h.provider}, ${h.state}, ${h.lastSuccessAt}, ${h.latencyMs}, ${h.freshnessAgeMs}, ${h.rateLimitState}, ${h.effectOnEntries}, ${h.effectOnExits}, ${h.lastError}, ${h.updatedAt})
    on conflict (provider) do update
      set state = excluded.state, last_success_at = excluded.last_success_at, latency_ms = excluded.latency_ms, freshness_age_ms = excluded.freshness_age_ms,
          rate_limit_state = excluded.rate_limit_state, effect_on_entries = excluded.effect_on_entries, effect_on_exits = excluded.effect_on_exits,
          last_error = excluded.last_error, updated_at = excluded.updated_at`;
}

/** Assets the ingestion loop keeps continuous: newest discovered first, capped. */
export async function listTrackedAssets(sql: Sql, limit: number): Promise<AssetRef[]> {
  const rows = await sql<{ id: string; mint_address: string }[]>`
    select id, mint_address from core.assets
    where status in ('DISCOVERED', 'EVALUATING', 'ELIGIBLE')
    order by first_observed_at desc
    limit ${limit}`;
  return rows.map((r) => ({ id: r.id as Uuid, mintAddress: r.mint_address }));
}
