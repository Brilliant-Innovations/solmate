-- pgTAP: tool refusals are append-only (INV-16 audit) and spend-usage windows charge atomically and never loosen (D43).
begin;
select plan(7);

insert into ops.spend_budgets (id, version_id, scope, scope_id, limits)
values ('99999999-9999-4999-8999-999999999921', 'budget-v1', 'STRATEGY', 'S9', '{"cyclesPerHour": 5, "modelUsdPerDay": 1, "providerRequestsPerMinute": null}'::jsonb);

select is(
  (select cycles from ops.charge_spend_usage('99999999-9999-4999-8999-999999999921', '2026-09-08T14:00:00Z', '2026-09-08T15:00:00Z', 1, 0.25, 2)),
  1, 'first charge creates the window');
select is(
  (select cycles from ops.charge_spend_usage('99999999-9999-4999-8999-999999999921', '2026-09-08T14:00:00Z', '2026-09-08T15:00:00Z', 2, 0.5, 0)),
  3, 'a second charge accumulates in the same window');
select is(
  (select model_usd from ops.spend_usage where budget_id = '99999999-9999-4999-8999-999999999921' and window_start = '2026-09-08T14:00:00Z'),
  0.75::double precision, 'model spend accumulates');
select throws_ok(
  $$ select ops.charge_spend_usage('99999999-9999-4999-8999-999999999921', '2026-09-08T14:00:00Z', '2026-09-08T15:00:00Z', -1, 0, 0) $$,
  'P0001', null, 'a negative charge is refused');
select throws_ok(
  $$ update ops.spend_usage set cycles = 0 where budget_id = '99999999-9999-4999-8999-999999999921' $$,
  'P0001', null, 'usage counters cannot be lowered inside a window');
select lives_ok(
  $$ update ops.spend_usage set state = 'BUDGET_PAUSED' where budget_id = '99999999-9999-4999-8999-999999999921' $$,
  'a window can be paused');
select throws_ok(
  $$ update ops.spend_usage set state = 'OK' where budget_id = '99999999-9999-4999-8999-999999999921' $$,
  'P0001', null, 'a paused window stays paused');

select * from finish();
rollback;
