-- pgTAP: delivery attempts carry their escalation level and a notification records the dead-man action once (§20.20).
begin;
select plan(3);

insert into ops.notifications (id, severity, alert_class, summary, affected)
values ('99999999-9999-4999-8999-999999999951', 'CRITICAL', 'UNABLE_TO_EXIT', 'cannot exit', '{}'::jsonb);

select lives_ok(
  $$ insert into ops.notification_deliveries (notification_id, channel, escalation_level, attempted_at, confirmed_at)
     values ('99999999-9999-4999-8999-999999999951', 'IN_APP', 1, now(), now()) $$,
  'a delivery records the escalation level it was made for');
select throws_ok(
  $$ insert into ops.notification_deliveries (notification_id, channel, escalation_level, attempted_at)
     values ('99999999-9999-4999-8999-999999999951', 'IN_APP', -1, now()) $$,
  '23514', null, 'a negative level is refused');
select throws_ok(
  $$ update ops.notifications set dead_man_action_taken = 'EMERGENCY_CLOSE_ALL' where id = '99999999-9999-4999-8999-999999999951' $$,
  '23514', null, 'the dead-man rule can only ever pause new entries');

select * from finish();
rollback;
