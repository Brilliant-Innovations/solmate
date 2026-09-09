-- Adversarial review 2026-09-09 (H-1, M-10, M-12, M-14, M-15, L-4): the replay record and the §30
-- views now carry what the run could actually measure, rather than leaving a zero or an omission to
-- be read as a measurement.
--
--   * `fees_lamports` per trade: network and priority fees are paid in SOL and had nowhere to go, so
--     `net_pnl` was identical to `gross_pnl` under a fill policy whose router and transfer basis
--     points are legitimately zero.
--   * the leaderboard exposes the dataset's observation discipline and its candle observation lag,
--     so a Level B label can be checked against the series it was applied to.
--   * incremental value exposes the risk-blocked buckets, which used to be credited to the model as
--     filtering skill.
--   * latency cost exposes the counters this data resolution cannot produce.
--   * `replay_attribution` and `replay_economic_pnl` state the variant they aggregate instead of
--     silently disagreeing with the leaderboard, which splits by variant.
--
-- IMPORTANT for anyone editing these views again: `create or replace view` matches the existing
-- columns **by position**, so a new column inserted in the middle of a select list is read as a
-- rename of whatever previously sat at that ordinal and Postgres refuses with 42P16. Every new
-- column below is therefore appended at the end of its view, in the same order as 003900 up to that
-- point. Nothing here renames, drops or retypes an existing column. Alphabetical order in
-- `libs/db/src/database.types.ts` is unaffected — `supabase gen types` sorts, so select-list
-- position and generated-type position are independent.

alter table research.replay_trades add column if not exists fees_lamports bigint not null default 0 check (fees_lamports >= 0);
comment on column research.replay_trades.fees_lamports is 'SOL-denominated network and priority fees for this trade, in lamports (blueprint 18.4).';

-- 003900 order, unchanged through `completed_at`; the dataset and SOL-fee columns are appended.
create or replace view research.replay_leaderboard with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity, r.window_from, r.window_to, r.in_sample_until, r.baseline_strategy_version_id,
  c ->> 'strategyVersionId' as strategy_version_id,
  c ->> 'variant' as variant,
  c ->> 'sample' as sample,
  (c -> 'metrics' ->> 'trades')::integer as trades,
  (c -> 'metrics' ->> 'netPnl')::double precision as net_pnl,
  (c -> 'metrics' ->> 'grossPnl')::double precision as gross_pnl,
  (c -> 'metrics' ->> 'fees')::double precision as fees,
  (c -> 'metrics' ->> 'slippageCost')::double precision as slippage_cost,
  (c -> 'metrics' ->> 'executionShortfallBps')::double precision as execution_shortfall_bps,
  (c -> 'metrics' ->> 'winRate')::double precision as win_rate,
  (c -> 'metrics' ->> 'expectancy')::double precision as expectancy,
  (c -> 'metrics' ->> 'profitFactor')::double precision as profit_factor,
  (c -> 'metrics' ->> 'maxDrawdown')::double precision as max_drawdown,
  (c -> 'metrics' ->> 'maxDrawdownFraction')::double precision as max_drawdown_fraction,
  (c -> 'metrics' ->> 'timeInMarketFraction')::double precision as time_in_market_fraction,
  (c -> 'metrics' ->> 'turnover')::double precision as turnover,
  (c -> 'metrics' ->> 'sharpe')::double precision as sharpe,
  (c -> 'metrics' ->> 'sortino')::double precision as sortino,
  (c -> 'metrics' ->> 'tailLoss')::double precision as tail_loss,
  (c -> 'metrics' ->> 'failedExecutionRate')::double precision as failed_execution_rate,
  (c -> 'metrics' ->> 'averageDecisionToFillMs')::double precision as average_decision_to_fill_ms,
  r.completed_at,
  -- appended 2026-09-09
  (c -> 'metrics' ->> 'feesLamports')::double precision as fees_lamports,
  (c -> 'metrics' ->> 'feesLamportsAsSettlement')::double precision as fees_lamports_as_settlement,
  (c -> 'metrics' ->> 'netIncludesSolFees')::boolean as net_includes_sol_fees,
  r.results -> 'dataset' ->> 'observationDiscipline' as observation_discipline,
  (r.results -> 'dataset' -> 'candles' ->> 'total')::bigint as dataset_candles,
  (r.results -> 'dataset' -> 'candles' ->> 'lateObserved')::bigint as dataset_candles_late_observed,
  (r.results -> 'dataset' -> 'candles' ->> 'maxLagMs')::double precision as dataset_max_observation_lag_ms,
  (r.results -> 'dataset' -> 'universe' ->> 'selected')::integer as universe_selected,
  (r.results -> 'dataset' -> 'universe' ->> 'available')::integer as universe_available,
  (r.results -> 'dataset' -> 'universe' ->> 'truncated')::boolean as universe_truncated
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'comparison') as c
where r.status = 'COMPLETED';

-- 003900 order, unchanged through `incremental_net_expectancy`; the risk-blocked buckets are appended.
create or replace view research.replay_incremental_value with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity, r.window_from, r.window_to,
  i ->> 'baselineStrategyVersionId' as baseline_strategy_version_id,
  i ->> 'aiStrategyVersionId' as strategy_version_id,
  (i ->> 'candidates')::integer as candidates,
  (i -> 'byCategory' -> 'BOTH_TRADED' ->> 'count')::integer as both_traded,
  (i -> 'byCategory' -> 'AI_FILTERED_LOSER' ->> 'count')::integer as filtered_losers,
  (i -> 'byCategory' -> 'AI_FILTERED_LOSER' ->> 'baselineNet')::double precision as filtered_losers_baseline_net,
  (i -> 'byCategory' -> 'AI_REJECTED_WINNER' ->> 'count')::integer as rejected_winners,
  (i -> 'byCategory' -> 'AI_REJECTED_WINNER' ->> 'baselineNet')::double precision as rejected_winners_baseline_net,
  (i -> 'byCategory' -> 'AI_ADMITTED_NOT_BASELINE' ->> 'count')::integer as admitted_not_baseline,
  (i -> 'byCategory' -> 'AI_ADMITTED_NOT_BASELINE' ->> 'aiNet')::double precision as admitted_not_baseline_net,
  (i -> 'byCategory' -> 'BOTH_PASSED' ->> 'count')::integer as both_passed,
  (i ->> 'baselineNetTotal')::double precision as baseline_net_total,
  (i ->> 'aiNetTotal')::double precision as strategy_net_total,
  (i ->> 'modelCost')::double precision as model_cost,
  (i ->> 'incrementalNetExpectancy')::double precision as incremental_net_expectancy,
  -- appended 2026-09-09
  coalesce((i ->> 'riskBlocked')::integer, 0) as risk_blocked,
  coalesce((i -> 'byCategory' -> 'RISK_BLOCKED_AI' ->> 'count')::integer, 0) as risk_blocked_ai,
  coalesce((i -> 'byCategory' -> 'RISK_BLOCKED_BASELINE' ->> 'count')::integer, 0) as risk_blocked_baseline,
  coalesce((i -> 'byCategory' -> 'RISK_BLOCKED_BOTH' ->> 'count')::integer, 0) as risk_blocked_both
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'incremental') as i
where r.status = 'COMPLETED';

-- 003900 order, unchanged through `edge_lost_to_latency`; the unreachable-counter list is appended.
create or replace view research.replay_latency_cost with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity,
  l ->> 'strategyVersionId' as strategy_version_id,
  (l ->> 'decisions')::integer as decisions,
  (l ->> 'expiredByLatency')::integer as expired_by_latency,
  (l ->> 'chaseRejected')::integer as chase_rejected,
  (l ->> 'staleQuoteRejected')::integer as stale_quote_rejected,
  (l ->> 'missedBaselineNet')::double precision as missed_baseline_net,
  (l ->> 'averageDecisionLatencyMs')::double precision as average_decision_latency_ms,
  (l ->> 'edgeLostToLatency')::double precision as edge_lost_to_latency,
  -- appended 2026-09-09
  coalesce(l -> 'structurallyUnreachable', '[]'::jsonb) as structurally_unreachable
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'latency') as l
where r.status = 'COMPLETED';

-- Attribution and economic rows are computed over the FULL variant only; saying so stops them being
-- read beside a leaderboard that splits by variant (review 2026-09-09, L-4). Appended, not inserted.
create or replace view research.replay_attribution with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity,
  dim.key as dimension,
  g ->> 'strategyVersionId' as strategy_version_id,
  g ->> 'key' as group_key,
  (g ->> 'sampleSupported')::boolean as sample_supported,
  (g -> 'metrics' ->> 'trades')::integer as trades,
  (g -> 'metrics' ->> 'netPnl')::double precision as net_pnl,
  (g -> 'metrics' ->> 'winRate')::double precision as win_rate,
  (g -> 'metrics' ->> 'expectancy')::double precision as expectancy,
  (g -> 'metrics' ->> 'maxDrawdown')::double precision as max_drawdown,
  (g -> 'metrics' ->> 'executionShortfallBps')::double precision as execution_shortfall_bps,
  -- appended 2026-09-09
  'FULL'::text as variant
from research.replay_runs r
  cross join lateral jsonb_each(r.results -> 'attribution') as dim
  cross join lateral jsonb_array_elements(dim.value) as g
where r.status = 'COMPLETED';

create or replace view research.replay_economic_pnl with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity,
  (r.results -> 'economic' ->> 'windowDays')::double precision as window_days,
  (r.results -> 'economic' ->> 'platformCostForWindowUsd')::double precision as platform_cost_for_window_usd,
  r.results -> 'economic' ->> 'allocation' as allocation,
  e ->> 'strategyVersionId' as strategy_version_id,
  (e ->> 'tradingNetUsd')::double precision as trading_net_usd,
  (e ->> 'directCostUsd')::double precision as direct_cost_usd,
  (e ->> 'strategyEconomicUsd')::double precision as strategy_economic_usd,
  (e ->> 'platformShareUsd')::double precision as platform_share_usd,
  (e ->> 'platformEconomicUsd')::double precision as platform_economic_usd,
  (e ->> 'costToEdgeRatio')::double precision as cost_to_edge_ratio,
  -- appended 2026-09-09
  'FULL'::text as variant
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'economic' -> 'rows') as e
where r.status = 'COMPLETED';

-- Exit outcomes carry the SOL-denominated fees too, so the exit table and the leaderboard agree.
create or replace view research.replay_exit_outcomes with (security_invoker = true) as
select t.run_id, t.strategy_version_id, t.variant, t.sample, t.exit_reason,
  count(*) as trades,
  sum(t.proceeds - t.cost - t.fees) as net_pnl,
  avg(t.proceeds - t.cost - t.fees) as expectancy,
  avg(extract(epoch from (t.closed_at - t.opened_at)) * 1000) as average_hold_ms,
  avg(t.execution_shortfall_bps) as average_execution_shortfall_bps,
  -- appended 2026-09-09
  sum(t.fees_lamports) as fees_lamports
from research.replay_trades t
group by t.run_id, t.strategy_version_id, t.variant, t.sample, t.exit_reason;

grant select on research.replay_leaderboard, research.replay_incremental_value, research.replay_latency_cost, research.replay_attribution, research.replay_economic_pnl, research.replay_exit_outcomes to authenticated;
