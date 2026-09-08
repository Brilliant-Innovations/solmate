-- §20.27 Watchlist: manually watched mints with reason, note, alert rules and who added them.
-- Membership improves discovery/attention only; nothing reads it for eligibility or execution.
create table intelligence.watchlist (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  reason text not null check (length(reason) between 1 and 128),
  note text check (note is null or length(note) <= 1024),
  alert_rules jsonb not null default '{}'::jsonb,
  added_by uuid not null references auth.users (id),
  added_at timestamptz not null default now(),
  removed_by uuid references auth.users (id),
  removed_at timestamptz,
  constraint removal_is_dated check ((removed_by is null) = (removed_at is null))
);
create unique index watchlist_active_asset_idx on intelligence.watchlist (asset_id) where removed_at is null;
alter table intelligence.watchlist enable row level security;
alter table intelligence.watchlist force row level security;
grant select on intelligence.watchlist to authenticated;
create policy operators_read on intelligence.watchlist for select to authenticated using (ops.has_role('viewer'));

-- §20.4 "Request research refresh": the eligibility role treats a request newer than the last
-- evaluation as due now (libs/db eligibility-repo). It cannot bypass hard eligibility.
alter table core.assets add column research_refresh_requested_at timestamptz;

-- Scanner read model (§20.4): the latest eligibility, market snapshot, feature snapshot and
-- emergency-route snapshot per asset, with open candidates, the active action cycle, cohort tags,
-- watch state and any open position. security_invoker so the operator's RLS applies underneath.
create view signals.scanner with (security_invoker = true) as
select
  a.id as asset_id,
  a.symbol,
  a.name,
  a.mint_address as mint,
  a.decimals,
  a.status as asset_status,
  a.first_observed_at,
  a.research_refresh_requested_at,
  e.id as eligibility_id,
  e.evaluated_at as eligibility_at,
  e.eligible,
  e.hard_reject,
  e.rejection_reasons,
  e.grade,
  e.liquidity_usd as eligibility_liquidity_usd,
  e.holder_count,
  e.concentration,
  e.mint_authority,
  e.freeze_authority,
  e.security_flags,
  e.transfer_restrictions,
  e.jupiter_route_available,
  e.settlement_route_confirmed,
  e.price_impact_probes,
  e.insider_metrics,
  e.freshness as eligibility_freshness,
  r.id as route_id,
  r.last_refreshed_at as route_refreshed_at,
  r.hops as route_hops,
  r.last_dry_run as route_dry_run,
  s.as_of as snapshot_at,
  s.price_usd,
  s.liquidity_usd,
  s.returns,
  s.relative_volume,
  s.realized_volatility,
  s.atr,
  s.volume_usd,
  s.buy_volume_usd,
  s.sell_volume_usd,
  s.buy_count,
  s.sell_count,
  s.sol_relative_return,
  s.universe_relative_strength,
  s.route_probes,
  s.market_cap_usd,
  f.as_of as features_at,
  f.features,
  f.regime,
  f.self_influence_suppressed,
  coalesce(c.candidates, '[]'::jsonb) as open_candidates,
  cy.state as cycle_state,
  cy.proposed_action as cycle_action,
  cy.strategy_version_id as cycle_strategy,
  cy.id as cycle_id,
  coalesce(co.cohorts, '{}'::text[]) as cohorts,
  w.id as watch_id,
  w.reason as watch_reason,
  p.id as position_id,
  p.status as position_status,
  ev.n as event_count_24h
from core.assets a
left join lateral (select * from core.asset_eligibility x where x.asset_id = a.id order by x.evaluated_at desc limit 1) e on true
left join lateral (select * from core.emergency_exit_route_snapshots x where x.asset_id = a.id order by x.last_refreshed_at desc limit 1) r on true
left join lateral (select * from market.snapshots x where x.asset_id = a.id order by x.as_of desc limit 1) s on true
left join lateral (select * from signals.feature_snapshots x where x.asset_id = a.id order by x.as_of desc limit 1) f on true
left join lateral (
  select jsonb_agg(jsonb_build_object('id', x.id, 'triggerFamily', x.trigger_family, 'scannerScore', x.scanner_score, 'status', x.status, 'discoveredAt', x.discovered_at, 'expiresAt', x.expires_at, 'strategyVersionIds', x.strategy_version_ids, 'rejection', x.deterministic_rejection_reason) order by x.scanner_score desc) as candidates
  from signals.candidates x where x.asset_id = a.id and x.status in ('DETECTED', 'ENRICHING', 'AGENT_REVIEW', 'QUALIFIED') and x.expires_at > now()
) c on true
left join lateral (
  select y.id, y.state, y.proposed_action, y.strategy_version_id
  from agents.action_cycles y
  left join signals.candidates cc on cc.id = y.candidate_id
  left join trading.positions pp on pp.id = y.position_id
  where (cc.asset_id = a.id or pp.asset_id = a.id) and y.state in ('TRIGGERED', 'CONTEXT_BUILT', 'PROPOSED', 'REVISION_REQUESTED')
  order by y.started_at desc limit 1
) cy on true
left join lateral (
  select array_agg(rc.name order by rc.name) as cohorts
  from core.asset_cohort_memberships m join core.risk_cohorts rc on rc.id = m.cohort_id
  where m.asset_id = a.id and m.approval_state = 'ACTIVE'
) co on true
left join lateral (select x.id, x.reason from intelligence.watchlist x where x.asset_id = a.id and x.removed_at is null limit 1) w on true
left join lateral (select x.id, x.status from trading.positions x where x.asset_id = a.id and x.status <> 'CLOSED' order by x.opened_at desc limit 1) p on true
left join lateral (select count(*)::int as n from intelligence.event_assets ea join intelligence.events ie on ie.id = ea.event_id where ea.asset_id = a.id and ie.first_seen_at > now() - interval '24 hours') ev on true;
grant select on signals.scanner to authenticated;
