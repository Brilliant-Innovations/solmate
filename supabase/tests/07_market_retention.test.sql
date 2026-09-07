-- pgTAP: §25 retention jobs prune by resolution, keep permanent resolutions and snapshots, and are scheduled.
begin;
select plan(9);

insert into core.assets (id, mint_address, symbol, name, decimals, token_program, first_observed_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'So11111111111111111111111111111111111111112', 'SOL', 'Wrapped SOL', 9, 'TOKEN', now());

-- a partition for the old rows we are about to insert
select market.ensure_candle_partitions((date_trunc('month', now() - interval '3 years'))::date, 1);
select market.ensure_candle_partitions((date_trunc('month', now() - interval '40 days'))::date, 1);
select market.ensure_candle_partitions((date_trunc('month', now()))::date, 1);

insert into market.candles (asset_id, provider, resolution, bucket_time, observed_at, provenance, open, high, low, close, volume_usd)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'BIRDEYE', '15s', now() - interval '40 days', now() - interval '40 days', 'BACKFILL', 1, 1, 1, 1, 0),  -- older than 21 days → pruned
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'BIRDEYE', '15s', now() - interval '1 hour',  now() - interval '1 hour',  'LIVE',     1, 1, 1, 1, 0),  -- kept
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'BIRDEYE', '1m',  now() - interval '40 days', now() - interval '40 days', 'BACKFILL', 1, 1, 1, 1, 0),  -- within 730 days → kept
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'BIRDEYE', '1m',  now() - interval '3 years', now() - interval '3 years', 'BACKFILL', 1, 1, 1, 1, 0),  -- older than 730 days → pruned
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'BIRDEYE', '1h',  now() - interval '3 years', now() - interval '3 years', 'BACKFILL', 1, 1, 1, 1, 0);  -- permanent → kept

insert into market.snapshots (asset_id, as_of, observed_at, provenance, volume_usd, buy_volume_usd, sell_volume_usd, buy_count, sell_count, returns)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', now() - interval '3 years', now() - interval '3 years', 'BACKFILL', '{}', '{}', '{}', '{}', '{}', '{}');

select is((select count(*) from ops.retention_policies)::int, 6, 'every candle resolution has a retention row');
select is((select retention_days from ops.retention_policies where resolution = '15s'), 21, '15s bars keep three weeks (§25)');
select ok((select retention_days is null from ops.retention_policies where resolution = '1h'), '1h bars are permanent');

select is(
  (select sum(deleted) from market.prune_candles())::int,
  2, 'prune deletes exactly the two rows past their resolution retention');
select is((select count(*) from market.candles where asset_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')::int, 3, 'the recent 15s, the 40-day 1m and the 3-year 1h rows remain');
select is((select count(*) from market.snapshots where asset_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')::int, 1, 'snapshots are never pruned');

select ok((select count(*) from cron.job where jobname = 'market-prune-candles') = 1, 'daily prune job is scheduled');
select ok((select count(*) from cron.job where jobname = 'market-candle-partitions') = 1, 'monthly partition job is scheduled');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}', true);
select throws_ok($$ select * from market.prune_candles() $$, '42501', null, 'the browser role cannot run pruning');
reset role;

select * from finish();
rollback;
