-- pgTAP: watchlist membership is attention only, one active row per asset, dated removal (§20.27); scanner view reads (§20.4).
begin;
select plan(6);

select has_enum('enums', 'control_request_kind', 'control kinds exist');
select ok((select 'WATCH_ASSET' = any(enum_range(null::enums.control_request_kind)::text[])), 'WATCH_ASSET kind exists');
select ok((select 'REQUEST_RESEARCH_REFRESH' = any(enum_range(null::enums.control_request_kind)::text[])), 'REQUEST_RESEARCH_REFRESH kind exists');

insert into auth.users (id, email, instance_id, aud, role) values ('00000000-0000-4000-8000-00000000aa01', 'w@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into core.assets (id, mint_address, symbol, name, decimals, token_program, first_observed_at)
values ('00000000-0000-4000-8000-00000000a001', 'So11111111111111111111111111111111111111112', 'WSOL', 'Wrapped SOL', 9, 'TOKEN', now());

select lives_ok(
  $$ insert into intelligence.watchlist (asset_id, reason, added_by) values ('00000000-0000-4000-8000-00000000a001', 'operator interest', '00000000-0000-4000-8000-00000000aa01') $$,
  'an operator can watch an asset');
select throws_ok(
  $$ insert into intelligence.watchlist (asset_id, reason, added_by) values ('00000000-0000-4000-8000-00000000a001', 'again', '00000000-0000-4000-8000-00000000aa01') $$,
  '23505', null, 'one active watch per asset');
select throws_ok(
  $$ update intelligence.watchlist set removed_at = now() where asset_id = '00000000-0000-4000-8000-00000000a001' $$,
  '23514', null, 'a removal names who removed it');

select * from finish();
rollback;
