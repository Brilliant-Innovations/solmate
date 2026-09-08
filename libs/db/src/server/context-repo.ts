import { instantToMs, type AssetEligibility, type FeatureSnapshot, type HeldAssetSafety, type Instant, type MarketSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';

/**
 * Point-in-time reads for the Trading Skill context (blueprint §11.3, §18.3, INV-13). Every query
 * bounds its result by `asOf` in SQL; there is deliberately no variant without the bound, so a
 * packet built for a cutoff can never contain a later observation. Read-only.
 */

const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;

export async function featureSnapshotAt(sql: Sql, assetId: Uuid, asOf: Instant): Promise<FeatureSnapshot | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from signals.feature_snapshots where asset_id = ${assetId} and as_of <= ${asOf} order by as_of desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid, assetId: r['asset_id'] as Uuid, asOf: iso(r['as_of']), featureEngineVersion: r['feature_engine_version'] as FeatureSnapshot['featureEngineVersion'], provenance: r['provenance'] as FeatureSnapshot['provenance'],
    marketSnapshotId: (r['market_snapshot_id'] as Uuid | null) ?? null, features: r['features'] as FeatureSnapshot['features'], regime: (r['regime'] as FeatureSnapshot['regime']) ?? null, marketSessions: r['market_sessions'] as FeatureSnapshot['marketSessions'], selfInfluenceSuppressed: r['self_influence_suppressed'] as boolean,
  };
}

export async function marketSnapshotAt(sql: Sql, assetId: Uuid, asOf: Instant): Promise<MarketSnapshot | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from market.snapshots where asset_id = ${assetId} and observed_at <= ${asOf} order by observed_at desc limit 1`;
  if (!r) return null;
  const n = (k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  return {
    id: r['id'] as Uuid, assetId: r['asset_id'] as Uuid, asOf: iso(r['as_of']), observedAt: iso(r['observed_at']), provenance: r['provenance'] as MarketSnapshot['provenance'],
    priceUsd: n('price_usd'), liquidityUsd: n('liquidity_usd'), volumeUsd: r['volume_usd'] as MarketSnapshot['volumeUsd'], buyVolumeUsd: r['buy_volume_usd'] as MarketSnapshot['buyVolumeUsd'], sellVolumeUsd: r['sell_volume_usd'] as MarketSnapshot['sellVolumeUsd'],
    buyCount: r['buy_count'] as MarketSnapshot['buyCount'], sellCount: r['sell_count'] as MarketSnapshot['sellCount'], relativeVolume: n('relative_volume'), atr: n('atr'), realizedVolatility: n('realized_volatility'), returns: r['returns'] as MarketSnapshot['returns'],
    marketCapUsd: n('market_cap_usd'), fdvUsd: n('fdv_usd'), solRelativeReturn: n('sol_relative_return'), universeRelativeStrength: n('universe_relative_strength'), routeProbes: (r['route_probes'] as MarketSnapshot['routeProbes']) ?? [],
  };
}

export async function eligibilityAt(sql: Sql, assetId: Uuid, asOf: Instant): Promise<AssetEligibility | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from core.asset_eligibility where asset_id = ${assetId} and evaluated_at <= ${asOf} order by evaluated_at desc limit 1`;
  if (!r) return null;
  const freshness = r['freshness'] as { securityProviderAt: string | null; chainReadAt: string; chainSlot: number };
  return {
    id: r['id'] as Uuid, assetId: r['asset_id'] as Uuid, evaluatedAt: iso(r['evaluated_at']), policyVersion: r['policy_version'] as AssetEligibility['policyVersion'], eligible: r['eligible'] as boolean, hardReject: r['hard_reject'] as boolean,
    rejectionReasons: r['rejection_reasons'] as AssetEligibility['rejectionReasons'], grade: r['grade'] as number | null, liquidityUsd: r['liquidity_usd'] as number | null, volume24hUsd: r['volume_24h_usd'] as number | null, holderCount: r['holder_count'] as number | null,
    concentration: r['concentration'] as AssetEligibility['concentration'], mintAuthority: r['mint_authority'] as AssetEligibility['mintAuthority'], freezeAuthority: r['freeze_authority'] as AssetEligibility['freezeAuthority'], token2022: r['token2022'] as AssetEligibility['token2022'],
    securityFlags: r['security_flags'] as AssetEligibility['securityFlags'], transferRestrictions: r['transfer_restrictions'] as AssetEligibility['transferRestrictions'], jupiterRouteAvailable: r['jupiter_route_available'] as boolean, settlementRouteConfirmed: r['settlement_route_confirmed'] as boolean,
    priceImpactProbes: r['price_impact_probes'] as AssetEligibility['priceImpactProbes'], insiderMetrics: r['insider_metrics'] as AssetEligibility['insiderMetrics'], emergencyExitRouteSnapshotId: (r['emergency_exit_route_snapshot_id'] as Uuid | null) ?? null,
    freshness: { securityProviderAt: freshness.securityProviderAt, chainReadAt: freshness.chainReadAt, chainSlot: freshness.chainSlot } as AssetEligibility['freshness'],
  };
}

export async function safetyAt(sql: Sql, positionId: Uuid, asOf: Instant): Promise<HeldAssetSafety | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select * from trading.position_safety_evaluations where position_id = ${positionId} and evaluated_at <= ${asOf} order by evaluated_at desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid, positionId: r['position_id'] as Uuid, assetId: r['asset_id'] as Uuid, evaluatedAt: iso(r['evaluated_at']), policyVersion: r['policy_version'] as HeldAssetSafety['policyVersion'], state: r['state'] as HeldAssetSafety['state'],
    previousState: (r['previous_state'] as HeldAssetSafety['previousState']) ?? null, reasons: r['reasons'] as HeldAssetSafety['reasons'], triggers: r['triggers'] as HeldAssetSafety['triggers'], exitCompatibility: r['exit_compatibility'] as HeldAssetSafety['exitCompatibility'],
    positionQuantity: String(r['position_quantity']) as HeldAssetSafety['positionQuantity'], chainSlot: Number(r['chain_slot']) as HeldAssetSafety['chainSlot'], liquidityUsd: r['liquidity_usd'] === null ? null : Number(r['liquidity_usd']), observed: r['observed'] as HeldAssetSafety['observed'], baseline: r['baseline'] as HeldAssetSafety['baseline'],
  };
}

export interface PositionContextRow {
  id: Uuid;
  accountId: Uuid;
  assetId: Uuid;
  symbol: string;
  quantity: string;
  averageEntryPrice: number | null;
  costBasisBaseUnits: string;
  unrealizedPnlBaseUnits: string | null;
  stop: { model: string; level: number | null; distanceFraction: number } | null;
  target: { policy: string; level: number | null } | null;
  unreviewedStop: number | null;
  protectionMode: string | null;
  safetyState: string;
  reviewState: string;
  reviewStateSince: Instant;
  openedAt: Instant;
  lastReviewedCycleId: Uuid | null;
  /** From the latest proposal for this position at or before asOf (its own entry proposal when none since). */
  thesis: string | null;
  invalidation: string | null;
  expectedHorizonEndsAt: Instant | null;
  /** Latest market price observed at or before asOf, with its time. */
  markPrice: number | null;
  markAt: Instant | null;
}

/** The position as it was at `asOf`: rows opened after it are invisible; the mark and the thesis come from what existed then. */
export async function positionContextAt(sql: Sql, positionId: Uuid, asOf: Instant): Promise<PositionContextRow | null> {
  const [p] = await sql<Record<string, unknown>[]>`
    select p.id, p.account_id, p.asset_id, a.symbol, p.quantity::text as quantity, p.average_entry_price, p.cost_basis_base_units::text as cost_basis, p.unrealized_pnl_base_units::text as unrealized,
      p.stop, p.target, p.unreviewed_stop, p.safety_state, p.review_state, p.review_state_since, p.opened_at, p.last_reviewed_cycle_id,
      (select l.protection_mode from trading.position_lots l where l.position_id = p.id and l.status = 'OPEN' order by l.opened_at limit 1) as protection_mode
    from trading.positions p join core.assets a on a.id = p.asset_id
    where p.id = ${positionId} and p.opened_at <= ${asOf}`;
  if (!p) return null;
  const positionAssetId = p['asset_id'] as Uuid;
  const [pr] = await sql<{ proposal: Record<string, unknown>; created_at: string }[]>`
    select proposal, created_at from trading.proposals where (position_id = ${positionId} or action_cycle_id = (select c.id from agents.action_cycles c where c.intent_id = (select l.entry_intent_id from trading.position_lots l where l.position_id = ${positionId} order by l.opened_at limit 1)))
      and created_at <= ${asOf} order by created_at desc limit 1`;
  const [m] = await sql<{ price_usd: number | null; observed_at: string }[]>`
    select price_usd, observed_at from market.snapshots where asset_id = ${positionAssetId} and observed_at <= ${asOf} and price_usd is not null order by observed_at desc limit 1`;
  const horizonMinutes = pr && typeof pr.proposal['expectedHorizonMinutes'] === 'number' ? (pr.proposal['expectedHorizonMinutes'] as number) : null;
  return {
    id: p['id'] as Uuid, accountId: p['account_id'] as Uuid, assetId: p['asset_id'] as Uuid, symbol: p['symbol'] as string, quantity: p['quantity'] as string, averageEntryPrice: (p['average_entry_price'] as number | null) ?? null, costBasisBaseUnits: p['cost_basis'] as string,
    unrealizedPnlBaseUnits: (p['unrealized'] as string | null) ?? null, stop: (p['stop'] as PositionContextRow['stop']) ?? null, target: (p['target'] as PositionContextRow['target']) ?? null, unreviewedStop: (p['unreviewed_stop'] as number | null) ?? null, protectionMode: (p['protection_mode'] as string | null) ?? null,
    safetyState: p['safety_state'] as string, reviewState: p['review_state'] as string, reviewStateSince: iso(p['review_state_since']), openedAt: iso(p['opened_at']), lastReviewedCycleId: (p['last_reviewed_cycle_id'] as Uuid | null) ?? null,
    thesis: pr && typeof pr.proposal['thesis'] === 'string' ? (pr.proposal['thesis'] as string) : null, invalidation: pr && typeof pr.proposal['invalidation'] === 'string' ? (pr.proposal['invalidation'] as string) : null,
    expectedHorizonEndsAt: pr && horizonMinutes !== null ? (new Date(instantToMs(iso(pr.created_at)) + horizonMinutes * 60_000).toISOString() as Instant) : null,
    markPrice: m ? (m.price_usd === null ? null : Number(m.price_usd)) : null, markAt: m ? iso(m.observed_at) : null,
  };
}

export interface OnchainFlowRow {
  assetId: Uuid;
  asOf: Instant;
  /** Net tracked-wallet quote-asset flow per window (buys minus sells, base units of the quote mint as text), own wallets excluded (§18.3). */
  netQuoteFlow: Record<'h1' | 'h4' | 'h24', string>;
  buyers: Record<'h1' | 'h4' | 'h24', number>;
  sellers: Record<'h1' | 'h4' | 'h24', number>;
  ownWalletActivityExcluded: true;
}

/** Tracked-wallet flow into `mint` first seen at or before asOf; wallets flagged is_owned never count (own activity cannot become evidence). */
export async function onchainFlowAt(sql: Sql, assetId: Uuid, mint: string, asOf: Instant): Promise<OnchainFlowRow> {
  const rows = await sql<{ window: string; net: string | null; buyers: string | number; sellers: string | number }[]>`
    with w as (select unnest(array['h1','h4','h24']) as window, unnest(array[interval '1 hour', interval '4 hours', interval '24 hours']) as span)
    select w.window,
      coalesce(sum(case when e.kind = 'BUY' then e.quote_amount::numeric when e.kind = 'SELL' then -e.quote_amount::numeric else 0 end), 0)::text as net,
      count(distinct case when e.kind = 'BUY' then e.wallet end) as buyers,
      count(distinct case when e.kind = 'SELL' then e.wallet end) as sellers
    from w left join intelligence.wallet_events e on e.mint = ${mint} and e.kind in ('BUY', 'SELL') and e.first_seen_at <= ${asOf}::timestamptz and coalesce(e.block_time, e.first_seen_at) > ${asOf}::timestamptz - w.span
      and not exists (select 1 from intelligence.wallets iw where iw.address = e.wallet and iw.is_owned)
    group by w.window`;
  const net: Record<string, string> = { h1: '0', h4: '0', h24: '0' };
  const buyers: Record<string, number> = { h1: 0, h4: 0, h24: 0 };
  const sellers: Record<string, number> = { h1: 0, h4: 0, h24: 0 };
  for (const r of rows) {
    net[r.window] = r.net ?? '0';
    buyers[r.window] = Number(r.buyers);
    sellers[r.window] = Number(r.sellers);
  }
  return { assetId, asOf, netQuoteFlow: net as OnchainFlowRow['netQuoteFlow'], buyers: buyers as OnchainFlowRow['buyers'], sellers: sellers as OnchainFlowRow['sellers'], ownWalletActivityExcluded: true };
}

/** Assets sharing an ACTIVE cohort with `assetId` under the given taxonomy version. */
export async function cohortPeersOf(sql: Sql, assetId: Uuid, taxonomyVersion: string): Promise<Uuid[]> {
  const rows = await sql<{ asset_id: string }[]>`
    select distinct m2.asset_id
    from core.asset_cohort_memberships m1
      join core.risk_cohorts c on c.id = m1.cohort_id and c.active and c.version_id = ${taxonomyVersion}
      join core.asset_cohort_memberships m2 on m2.cohort_id = m1.cohort_id and m2.asset_id <> m1.asset_id
    where m1.asset_id = ${assetId} and m1.approval_state = 'ACTIVE' and m2.approval_state = 'ACTIVE' and m1.source <> 'LLM_SUGGESTION' and m2.source <> 'LLM_SUGGESTION'
    order by m2.asset_id`;
  return rows.map((r) => r.asset_id as Uuid);
}
