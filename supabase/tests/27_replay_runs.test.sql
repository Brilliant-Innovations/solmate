-- pgTAP: replay runs are reproducibility records (§18.5): window-ordered, immutable once done, never deleted.
begin;
select plan(7);

insert into research.replay_runs (id, name, fidelity, window_from, window_to, dataset_cutoff, in_sample_until, strategy_version_ids, baseline_strategy_version_id, versions, calibration_target)
values ('10000000-0000-4000-8000-000000000001', 'test run', 'A_HISTORICAL', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-01T12:00:00Z', '{S0_RAW@1.0.0,S0_SAFE@1.0.0}', 'S0_RAW@1.0.0', '{"gitSha":"abcdef1"}'::jsonb, '{"kind":"NET_PNL_POSITIVE_AT_CLOSE","horizonMs":86400000}'::jsonb);

select throws_ok(
  $$ insert into research.replay_runs (id, name, fidelity, window_from, window_to, dataset_cutoff, strategy_version_ids, baseline_strategy_version_id, versions, calibration_target)
     values ('10000000-0000-4000-8000-000000000002', 'bad window', 'A_HISTORICAL', '2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '{S0_RAW@1.0.0}', 'S0_RAW@1.0.0', '{}'::jsonb, '{}'::jsonb) $$,
  '23514', null, 'a window that ends before it starts is refused');
select throws_ok(
  $$ insert into research.replay_runs (id, name, fidelity, window_from, window_to, dataset_cutoff, strategy_version_ids, baseline_strategy_version_id, versions, calibration_target)
     values ('10000000-0000-4000-8000-000000000003', 'early cutoff', 'A_HISTORICAL', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-01T12:00:00Z', '{S0_RAW@1.0.0}', 'S0_RAW@1.0.0', '{}'::jsonb, '{}'::jsonb) $$,
  '23514', null, 'a dataset cutoff before the window end is refused');

select lives_ok($$ update research.replay_runs set status = 'RUNNING', started_at = now() where id = '10000000-0000-4000-8000-000000000001' $$, 'a queued run can start');
select throws_ok(
  $$ update research.replay_runs set status = 'COMPLETED', completed_at = now() where id = '10000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'a run cannot complete without its digests and results');
select lives_ok(
  $$ update research.replay_runs set status = 'COMPLETED', completed_at = now(), decisions_digest = repeat('a', 64), results_digest = repeat('b', 64), results = '{"candidates":0}'::jsonb where id = '10000000-0000-4000-8000-000000000001' $$,
  'a run completes with digests and results');
select throws_ok(
  $$ update research.replay_runs set name = 'renamed' where id = '10000000-0000-4000-8000-000000000001' $$,
  'P0001', null, 'a completed run is immutable');
select throws_ok(
  $$ delete from research.replay_runs where id = '10000000-0000-4000-8000-000000000001' $$,
  'P0001', null, 'runs are never deleted');

select * from finish();
rollback;
