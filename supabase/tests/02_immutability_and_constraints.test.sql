-- pgTAP: immutable artifacts, D23 cohort rule, action-cycle constraints, candle partitions.
begin;
select plan(10);

-- fixtures
insert into core.assets (id, mint_address, symbol, name, decimals, token_program, first_observed_at)
values ('22222222-2222-4222-8222-222222222222', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'RISK', 'Risk Token', 6, 'TOKEN', now());

insert into research.strategy_versions (
  id, strategy_id, version_id, variant, git_sha, feature_version, risk_policy_version, speed_tier,
  max_decision_latency_ms, max_candidate_age_ms, max_quote_age_ms, chase_tolerance_bps, allowed_action_types,
  adversary_policy, session_rules, outside_window_behavior, warmup, event_window_policy, offline_protection,
  human_reaction_floor_ms, live_intent_expiry_ms, eligible_capital_authorities, active_from
) values (
  '77777777-7777-4777-8777-777777777771', 'S0_SAFE', 'S0_SAFE@1.0.0', 'research', 'abcdef1', 'features@1', 'risk@1', 'T1_MOMENTUM',
  60000, 120000, 5000, 200, '{ENTER,IGNORE}',
  '{"proposerModel":null,"adversaryModel":null,"deterministicGate":true}', '{"allowedSessions":[],"blockedWeekdays":[],"customWindowsUtc":[]}',
  'WATCH', '{"minBarsByResolution":{},"baselineWindowMs":0}', '{"maxDurationMs":0,"maxExtensions":0,"requireRetestAfterMs":null}',
  '{"permitted":false,"maxOfflineMs":null}', 30000, 60000, '{PAPER}', now()
);

-- D7: a versioned artifact cannot be edited in place, but status may advance
select throws_ok(
  $$ update research.strategy_versions set chase_tolerance_bps = 500 where version_id = 'S0_SAFE@1.0.0' $$,
  'P0001', null, 'strategy version parameters are immutable'
);
select lives_ok(
  $$ update research.strategy_versions set status = 'PAPER' where version_id = 'S0_SAFE@1.0.0' $$,
  'strategy version status may advance'
);
select throws_ok($$ delete from research.strategy_versions $$, 'P0001', null, 'strategy versions cannot be deleted');

-- D23: an LLM suggestion can never be ACTIVE cohort membership
insert into core.risk_cohorts (id, name, version_id) values ('11111111-1111-4111-8111-111111111110', 'memes', 'cohorts@1');
select throws_ok(
  $$ insert into core.asset_cohort_memberships (asset_id, cohort_id, source, effective_version, confidence, approval_state)
     values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111110', 'LLM_SUGGESTION', 'cohorts@1', 0.9, 'ACTIVE') $$,
  '23514', null, 'LLM_SUGGESTION cannot be ACTIVE'
);
select lives_ok(
  $$ insert into core.asset_cohort_memberships (asset_id, cohort_id, source, effective_version, confidence, approval_state)
     values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111110', 'LLM_SUGGESTION', 'cohorts@1', 0.9, 'INACTIVE_SUGGESTION') $$,
  'LLM_SUGGESTION may be stored as INACTIVE_SUGGESTION'
);

-- Action cycle: exactly one target; UNRESOLVED needs a reason; CLEARED needs a cutoff
select throws_ok(
  $$ insert into agents.action_cycles (trigger_id, strategy_version_id, speed_tier, decision_budget_ms, cutoffs, started_at)
     values (gen_random_uuid(), 'S0_SAFE@1.0.0', 'T1_MOMENTUM', 1000, '[{"version":1}]', now()) $$,
  '23514', null, 'a cycle without candidate or position is rejected'
);
select throws_ok(
  $$ insert into agents.action_cycles (trigger_id, position_id, strategy_version_id, speed_tier, decision_budget_ms, cutoffs, started_at, state)
     values (gen_random_uuid(), gen_random_uuid(), 'S0_SAFE@1.0.0', 'T1_MOMENTUM', 1000, '[{"version":1}]', now(), 'UNRESOLVED') $$,
  '23514', null, 'UNRESOLVED without a reason is rejected'
);

-- Candles: partitions exist and accept rows in range; out-of-range rows are refused
select lives_ok(
  $$ insert into market.candles (asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd)
     values ('22222222-2222-4222-8222-222222222222', 'birdeye', '1m', '2026-09-06T12:00:00Z', now(), 'LIVE', 1, 1, 1, 1, 0) $$,
  'candle in an existing partition inserts'
);
select throws_ok(
  $$ insert into market.candles (asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd)
     values ('22222222-2222-4222-8222-222222222222', 'birdeye', '1m', '2030-01-01T00:00:00Z', now(), 'LIVE', 1, 1, 1, 1, 0) $$,
  '23514', null, 'candle outside created partitions is refused until ensure_candle_partitions runs'
);
select market.ensure_candle_partitions('2030-01-01', 1);
select lives_ok(
  $$ insert into market.candles (asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd)
     values ('22222222-2222-4222-8222-222222222222', 'birdeye', '1m', '2030-01-01T00:00:00Z', now(), 'LIVE', 1, 1, 1, 1, 0) $$,
  'after ensure_candle_partitions the row inserts'
);

select * from finish();
rollback;
