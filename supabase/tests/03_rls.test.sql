-- pgTAP: row-level security from the browser's point of view (§23.2, §23.3, §20.23).
begin;
select plan(9);

-- two users: an operator and a person with no operator row
insert into auth.users (id, email, instance_id, aud, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'op@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stranger@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into ops.operators (user_id, role, display_name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'operator', 'Op');

insert into ops.notifications (severity, alert_class, summary) values ('HIGH', 'TEST', 'a test alert');

-- anon: nothing
set local role anon;
select throws_ok($$ select count(*) from ops.notifications $$, '42501', null, 'anon cannot read notifications');
reset role;

-- authenticated stranger (no operator row): reads nothing, cannot request control
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated"}', true);
select is((select count(*) from ops.notifications)::int, 0, 'a user without an operator row sees no rows');
select throws_ok(
  $$ insert into ops.control_requests (requested_by, kind) values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'PAUSE_NEW_ENTRIES') $$,
  '42501', null, 'a user without an operator row cannot file a control request'
);
reset role;

-- authenticated operator: reads, may file a control request as themselves only, cannot write ledgers
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select is((select count(*) from ops.notifications)::int, 1, 'an operator reads notifications');
select lives_ok(
  $$ insert into ops.control_requests (kind, payload) values ('PAUSE_NEW_ENTRIES', '{}') $$,
  'an operator may file a control request (requested_by defaults to auth.uid())'
);
select throws_ok(
  $$ insert into ops.control_requests (requested_by, kind) values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'PAUSE_NEW_ENTRIES') $$,
  '42501', null, 'an operator cannot file a control request on behalf of someone else'
);
select throws_ok(
  $$ update ops.notifications set acknowledged_at = now() $$,
  '42501', null, 'an operator cannot write notifications directly (acknowledge goes through a control request)'
);
select throws_ok(
  $$ insert into trading.accounts (name, cluster, trading_wallet, settlement_mint)
     values ('x', 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') $$,
  '42501', null, 'an operator cannot write ledger tables'
);
select throws_ok($$ select * from pgmq.q_trade_critical $$, '42501', null, 'queues are not reachable from the browser role');
reset role;

select * from finish();
rollback;
