-- pgTAP: chain-health snapshots are append-only and a blocking verdict carries its reasons (§14.7).
begin;
select plan(3);

select lives_ok(
  $$ insert into ops.chain_health (observed_at, policy_version, state, views, head_slot, slot_advanced, confirmed_finalized_lag_slots, view_divergence_slots, effect_on_entries, reasons)
     values (now(), 'chain-health-v1', 'STALLED', '[{"label":"primary","ok":true}]'::jsonb, 1000, false, 20, null, 'BLOCK', array['no confirmed slot advance for 40s']) $$,
  'a blocking verdict with a reason is recorded');
select throws_ok(
  $$ insert into ops.chain_health (observed_at, policy_version, state, views, head_slot, slot_advanced, confirmed_finalized_lag_slots, view_divergence_slots, effect_on_entries, reasons)
     values (now(), 'chain-health-v1', 'DIVERGENT', '[]'::jsonb, 1000, true, 20, 200, 'BLOCK', '{}') $$,
  '23514', null, 'a blocking verdict without a reason is refused');
select throws_ok(
  $$ update ops.chain_health set state = 'HEALTHY', effect_on_entries = 'NONE' where state = 'STALLED' $$,
  'P0001', null, 'a snapshot cannot be rewritten');

select * from finish();
rollback;
