-- §30 research questions as queries (blueprint §30, §19; execution plan M10 "queries for the §30
-- research questions"). Every view reads the immutable replay record (research.replay_*) so an
-- answer always names the run, the strategy version, the variant and the sample split it came
-- from; the fidelity level rides on the run (§18.1: never conflated). security_invoker so the
-- operator's RLS applies underneath.

-- Strategy leaderboard per run: one row per strategy × variant × sample with the §19.1 core
-- metrics (Q1, Q8, Q12, Q13, Q19 by run).
create view research.replay_leaderboard with (security_invoker = true) as
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
  r.completed_at
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'comparison') as c
where r.status = 'COMPLETED';

-- Q1 (AI/gate value over the raw baseline), Q8 (adversarial review vs missed opportunities):
-- §19.3 pairing per run and strategy against the run's baseline.
create view research.replay_incremental_value with (security_invoker = true) as
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
  (i ->> 'incrementalNetExpectancy')::double precision as incremental_net_expectancy
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'incremental') as i
where r.status = 'COMPLETED';

-- Q8, Q16 (does proposer/adversary disagreement predict quality), Q18 (reviewed decisions vs the counterfactual).
create view research.replay_disagreement with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity,
  d ->> 'strategyVersionId' as strategy_version_id,
  (d ->> 'reviewed')::integer as reviewed,
  (d ->> 'confirmed')::integer as confirmed,
  (d ->> 'challenged')::integer as challenged,
  (d ->> 'rejected')::integer as rejected,
  (d ->> 'disagreementRate')::double precision as disagreement_rate,
  (d ->> 'expectancyAfterConfirm')::double precision as expectancy_after_confirm,
  (d ->> 'expectancyAfterChallenge')::double precision as expectancy_after_challenge,
  (d ->> 'rejectedWithCounterfactual')::integer as rejected_with_counterfactual,
  (d ->> 'rejectedCounterfactualNet')::double precision as rejected_counterfactual_net,
  (d ->> 'proposerOnlyNet')::double precision as proposer_only_net,
  (d ->> 'fullNet')::double precision as full_net,
  d -> 'topObjections' as top_objections
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'disagreement') as d
where r.status = 'COMPLETED';

-- Q17 (which speed tiers gain from AI context versus losing edge to reasoning latency), Q15 (edge lost to execution conditions).
create view research.replay_latency_cost with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity,
  l ->> 'strategyVersionId' as strategy_version_id,
  (l ->> 'decisions')::integer as decisions,
  (l ->> 'expiredByLatency')::integer as expired_by_latency,
  (l ->> 'chaseRejected')::integer as chase_rejected,
  (l ->> 'staleQuoteRejected')::integer as stale_quote_rejected,
  (l ->> 'missedBaselineNet')::double precision as missed_baseline_net,
  (l ->> 'averageDecisionLatencyMs')::double precision as average_decision_latency_ms,
  (l ->> 'edgeLostToLatency')::double precision as edge_lost_to_latency
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'latency') as l
where r.status = 'COMPLETED';

-- Q11 (does model confidence calibrate to outcomes): §11.14 bins against the run's declared target.
create view research.replay_calibration with (security_invoker = true) as
select r.id as run_id, r.name as run_name, r.fidelity, r.calibration_target ->> 'kind' as target_kind,
  c ->> 'strategyVersionId' as strategy_version_id,
  (c ->> 'scored')::integer as scored,
  (c ->> 'brierScore')::double precision as brier_score,
  b ->> 'label' as bin,
  (b ->> 'count')::integer as bin_count,
  (b ->> 'meanConfidence')::double precision as mean_confidence,
  (b ->> 'hitRate')::double precision as hit_rate,
  (b ->> 'realizedExpectancy')::double precision as realized_expectancy
from research.replay_runs r
  cross join lateral jsonb_array_elements(r.results -> 'calibration') as c
  cross join lateral jsonb_array_elements(c -> 'bins') as b
where r.status = 'COMPLETED';

-- Q6 (liquidity bands), Q7 (relative-volume / extension bands), Q10 (regimes), Q20 (sessions),
-- Q13/Q14 (duration and exit behaviour), Q3/Q4/Q5 (signal presence): §19.2 attribution rows per dimension.
create view research.replay_attribution with (security_invoker = true) as
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
  (g -> 'metrics' ->> 'executionShortfallBps')::double precision as execution_shortfall_bps
from research.replay_runs r
  cross join lateral jsonb_each(r.results -> 'attribution') as dim
  cross join lateral jsonb_array_elements(dim.value) as g
where r.status = 'COMPLETED';

-- Q19 (which strategies remain profitable after direct and platform costs): the three layers per run and strategy.
create view research.replay_economic_pnl with (security_invoker = true) as
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
  (e ->> 'costToEdgeRatio')::double precision as cost_to_edge_ratio
from research.replay_runs r cross join lateral jsonb_array_elements(r.results -> 'economic' -> 'rows') as e
where r.status = 'COMPLETED';

-- Q13 (are exits more important than entries), Q14 (trailing vs fixed), Q7 (chase): exit reasons and hold time per strategy from the trade rows themselves.
create view research.replay_exit_outcomes with (security_invoker = true) as
select t.run_id, t.strategy_version_id, t.variant, t.sample, t.exit_reason,
  count(*) as trades,
  sum(t.proceeds - t.cost - t.fees) as net_pnl,
  avg(t.proceeds - t.cost - t.fees) as expectancy,
  avg(extract(epoch from (t.closed_at - t.opened_at)) * 1000) as average_hold_ms,
  avg(t.execution_shortfall_bps) as average_execution_shortfall_bps
from research.replay_trades t
group by t.run_id, t.strategy_version_id, t.variant, t.sample, t.exit_reason;

-- Q2, Q21 (catalyst continuation by source-time age) and Q22 (attended vs unattended) need live evidence
-- rows the replay does not yet carry (event source age per trade; session attendance); they are
-- answered from the live ledger once M6 intelligence keys and Profile 1B sessions exist, and the
-- views are added then rather than faked here.

grant select on research.replay_leaderboard, research.replay_incremental_value, research.replay_disagreement, research.replay_latency_cost, research.replay_calibration, research.replay_attribution, research.replay_economic_pnl, research.replay_exit_outcomes to authenticated;
