-- ops.record_operator_presence(): who may hold presence, and what it refuses (D2, §20.21, §5.7).
begin;
select plan(9);

-- Fixtures: an operator, an admin, a stranger, and one open attended session.
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-00000000e001', 'presence-operator@example.test'),
  ('a0000000-0000-4000-8000-00000000e002', 'presence-stranger@example.test');
insert into ops.operators (user_id, role, display_name) values
  ('a0000000-0000-4000-8000-00000000e001', 'operator', 'presence operator');

insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint, mode)
values ('c0000000-0000-4000-8000-00000000e001', 'presence-paper', 'devnet', 'PresenceWa11et11111111111111111111111111', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'PAPER')
on conflict (name) do nothing;

insert into ops.runtime_sessions (id, account_id, profile, activity_state, capital_authority, attended, actual_start_at, created_at)
values ('d0000000-0000-4000-8000-00000000e001', 'c0000000-0000-4000-8000-00000000e001', 'P1A', 'ACTIVE', 'PAPER', true, now() - interval '1 hour', now() - interval '1 hour');

-- The function deliberately takes the *newest* open session, so any session a local worker run left
-- behind would be chosen ahead of this fixture and the last two cases would silently test that row
-- instead. Close them for the duration; this is inside the transaction and the rollback restores them.
update ops.runtime_sessions set activity_state = 'OFF'
where id <> 'd0000000-0000-4000-8000-00000000e001' and activity_state <> 'OFF';

-- --- anonymous ------------------------------------------------------------------------------------
set local role anon;
-- Stopped at the schema, before the function is even resolved: a stronger refusal than a
-- function-level denial, and the one the RLS migration already put in place.
select throws_ok(
  $q$select ops.record_operator_presence()$q$,
  '42501',
  'permission denied for schema ops',
  'anon cannot reach it at all'
);

-- --- an authenticated non-operator ---------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000e002","role":"authenticated","aal":"aal2"}';
select is(
  (ops.record_operator_presence() ->> 'reason'),
  'NOT_AN_OPERATOR',
  'a signed-in stranger holds no presence'
);
select is((ops.record_operator_presence() ->> 'stamped')::boolean, false, 'and nothing is stamped for them');

-- The heartbeat survives the refusals above untouched.
select is(
  (select last_presence_heartbeat_at from ops.runtime_sessions where id = 'd0000000-0000-4000-8000-00000000e001'),
  null,
  'the heartbeat is still unset after the refused calls'
);

-- --- an operator on an aal1 session ---------------------------------------------------------------
-- Presence deliberately needs no step-up (20260909004300). `aal` is a property of the session, so a
-- stolen aal2 token would carry aal2 anyway; requiring it stopped only the password-only operator,
-- which made the control unusable without defending against the threat it appeared to. Step-up stays
-- on arming and every risk-increasing control (§5.7, D41), which presence is not: it cannot arm,
-- increase exposure or clear a pause.
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000e001","role":"authenticated","aal":"aal1"}';
select is((ops.record_operator_presence() ->> 'stamped')::boolean, true, 'a password-only operator session still holds presence');

-- --- an operator on an aal2 session ---------------------------------------------------------------
set local role postgres;
update ops.runtime_sessions set last_presence_heartbeat_at = null where id = 'd0000000-0000-4000-8000-00000000e001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000e001","role":"authenticated","aal":"aal2"}';
select is((ops.record_operator_presence() ->> 'stamped')::boolean, true, 'and so does a TOTP-verified one');
select isnt(
  (select last_presence_heartbeat_at from ops.runtime_sessions where id = 'd0000000-0000-4000-8000-00000000e001'),
  null,
  'and the heartbeat is stamped'
);

-- --- an unattended session is not promoted -------------------------------------------------------
set local role postgres;
update ops.runtime_sessions set attended = false, last_presence_heartbeat_at = null where id = 'd0000000-0000-4000-8000-00000000e001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000e001","role":"authenticated","aal":"aal2"}';
select is(
  (ops.record_operator_presence() ->> 'reason'),
  'SESSION_NOT_ATTENDED',
  'presence never promotes a session the operator declared unattended'
);

-- --- no open session ------------------------------------------------------------------------------
set local role postgres;
update ops.runtime_sessions set activity_state = 'OFF' where id = 'd0000000-0000-4000-8000-00000000e001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000e001","role":"authenticated","aal":"aal2"}';
select is(
  (ops.record_operator_presence() ->> 'reason'),
  'NO_OPEN_SESSION',
  'with nothing running there is nothing to attend'
);

select * from finish();
rollback;
