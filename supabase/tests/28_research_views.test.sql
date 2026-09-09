-- pgTAP: the §30 research views read the immutable replay record and name run, strategy, variant and sample.
begin;
select plan(6);

insert into research.replay_runs (id, name, fidelity, status, window_from, window_to, dataset_cutoff, in_sample_until, strategy_version_ids, baseline_strategy_version_id, versions, calibration_target, completed_at, decisions_digest, results_digest, results)
values ('10000000-0000-4000-8000-000000000009', 'views run', 'B_CAPTURED', 'COMPLETED', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-01T12:00:00Z', '{S0_RAW@1.0.0,S1@1.0.0}', 'S0_RAW@1.0.0', '{"gitSha":"abcdef1"}'::jsonb, '{"kind":"NET_PNL_POSITIVE_AT_CLOSE","horizonMs":86400000}'::jsonb, now(), repeat('a', 64), repeat('b', 64),
  '{"comparison":[{"strategyVersionId":"S0_RAW@1.0.0","variant":"FULL","sample":"ALL","metrics":{"trades":4,"netPnl":11,"winRate":0.5,"expectancy":2.75,"profitFactor":1.65,"maxDrawdown":11}},{"strategyVersionId":"S1@1.0.0","variant":"FULL","sample":"HOLD_OUT","metrics":{"trades":1,"netPnl":2}}],
    "incremental":[{"baselineStrategyVersionId":"S0_RAW@1.0.0","aiStrategyVersionId":"S1@1.0.0","candidates":8,"byCategory":{"BOTH_TRADED":{"count":1,"baselineNet":10,"aiNet":10},"AI_FILTERED_LOSER":{"count":1,"baselineNet":-5,"aiNet":0},"AI_REJECTED_WINNER":{"count":4,"baselineNet":40,"aiNet":0},"AI_ADMITTED_NOT_BASELINE":{"count":1,"baselineNet":0,"aiNet":2},"BOTH_PASSED":{"count":1,"baselineNet":0,"aiNet":0}},"baselineNetTotal":45,"aiNetTotal":12,"modelCost":1.5,"incrementalNetExpectancy":-4.3125}],
    "disagreement":[{"strategyVersionId":"S1@1.0.0","reviewed":5,"confirmed":1,"challenged":1,"rejected":3,"disagreementRate":0.8,"expectancyAfterConfirm":10,"expectancyAfterChallenge":2,"rejectedWithCounterfactual":2,"rejectedCounterfactualNet":5,"proposerOnlyNet":-3,"fullNet":12,"topObjections":[{"code":"THESIS_WEAK","count":2}]}],
    "latency":[{"strategyVersionId":"S1@1.0.0","decisions":8,"expiredByLatency":1,"chaseRejected":1,"staleQuoteRejected":0,"missedBaselineNet":20,"averageDecisionLatencyMs":2500,"edgeLostToLatency":2}],
    "calibration":[{"strategyVersionId":"S1@1.0.0","targetKind":"NET_PNL_POSITIVE_AT_CLOSE","scored":2,"brierScore":0.17,"bins":[{"label":"0.80–0.89","count":1,"meanConfidence":0.8,"hitRate":1,"realizedExpectancy":10},{"label":"0.50–0.59","count":1,"meanConfidence":0.55,"hitRate":0,"realizedExpectancy":2}]}],
    "attribution":{"session":[{"strategyVersionId":"S0_RAW@1.0.0","key":"US","sampleSupported":false,"metrics":{"trades":2,"netPnl":8,"winRate":1}}],"regime":[]},
    "economic":{"windowDays":1,"platformCostForWindowUsd":2.8,"allocation":"BY_TURNOVER","rows":[{"strategyVersionId":"S0_RAW@1.0.0","tradingNetUsd":11,"directCostUsd":0,"strategyEconomicUsd":11,"platformShareUsd":2.8,"platformEconomicUsd":8.2,"costToEdgeRatio":0}]},
    "perStrategy":[],"candidates":8,"ticks":1440}'::jsonb);

select is((select count(*)::integer from research.replay_leaderboard where run_id = '10000000-0000-4000-8000-000000000009'), 2, 'leaderboard rows per strategy × variant × sample');
select is((select net_pnl from research.replay_leaderboard where run_id = '10000000-0000-4000-8000-000000000009' and strategy_version_id = 'S0_RAW@1.0.0' and sample = 'ALL'), 11::double precision, 'leaderboard reads net P&L');
select is((select rejected_winners from research.replay_incremental_value where run_id = '10000000-0000-4000-8000-000000000009'), 4, 'incremental value reads the §19.3 categories');
select is((select disagreement_rate from research.replay_disagreement where run_id = '10000000-0000-4000-8000-000000000009'), 0.8::double precision, 'disagreement rate is exposed for Q16');
select is((select count(*)::integer from research.replay_calibration where run_id = '10000000-0000-4000-8000-000000000009'), 2, 'one calibration row per bin');
select is((select platform_economic_usd from research.replay_economic_pnl where run_id = '10000000-0000-4000-8000-000000000009'), 8.2::double precision, 'economic P&L exposes the third layer for Q19');

select * from finish();
rollback;
