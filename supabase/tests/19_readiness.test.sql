-- pgTAP: readiness rows and verdicts are append-only; a READY verdict cannot name missing, stale or failed rows (§29, ADR-0010).
begin;
select plan(4);

select lives_ok(
  $$ insert into ops.readiness_rows (row_id, kind, verdict, strategy_class, profile, binding, recorded_by, evaluated_at)
     values ('RECONCILIATION_CLEAN', 'COMPUTED', 'PASS', 'DETERMINISTIC', 'P2', '{"gitSha":"abcdef1"}'::jsonb, 'worker:readiness', now()) $$,
  'a bound row is recorded');
select throws_ok(
  $$ update ops.readiness_rows set verdict = 'PASS' where row_id = 'RECONCILIATION_CLEAN' $$,
  'P0001', null, 'a row cannot be rewritten');
select throws_ok(
  $$ insert into ops.readiness_verdicts (name, profile, strategy_class, verdict, rows, missing, binding, policy_version, computed_at)
     values ('READY_FOR_ATTENDED_TINY_LIVE', 'P2', 'DETERMINISTIC', 'READY', '[]'::jsonb, array['SIGNER_OUTAGE_DRILL'], '{}'::jsonb, 'readiness-v1', now()) $$,
  '23514', null, 'a READY verdict with a missing row is refused');
select lives_ok(
  $$ insert into ops.readiness_verdicts (name, profile, strategy_class, verdict, rows, missing, binding, policy_version, computed_at)
     values ('READY_FOR_ATTENDED_TINY_LIVE', 'P2', 'DETERMINISTIC', 'NOT_READY', '[]'::jsonb, array['SIGNER_OUTAGE_DRILL'], '{}'::jsonb, 'readiness-v1', now()) $$,
  'a NOT_READY verdict names what is missing');

select * from finish();
rollback;
