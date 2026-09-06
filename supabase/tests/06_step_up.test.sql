-- pgTAP: operator step-up substrate (§5.7, §20.26, D41; ADR-0006 incl. review hardening R2-01/R2-04).
begin;
select plan(21);

insert into auth.users (id, email, instance_id, aud, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'op@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stranger@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into ops.operators (user_id, role, display_name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'operator', 'Op');

-- 1. an aal1 session cannot file any control request, not even pause, nor begin step-up
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$ insert into ops.control_requests (kind, payload) values ('PAUSE_NEW_ENTRIES', '{}') $$,
  '42501', null, 'aal1 session cannot file a control request');
select throws_ok(
  $$ select * from ops.begin_step_up('ARM_RELEASE', repeat('a', 64)) $$,
  '42501', null, 'aal1 session cannot begin step-up');
reset role;

-- 2. aal2 without a fresh TOTP: fast path works, no passkey → ARM refused, first passkey refused
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":0}]}', true);
select lives_ok(
  $$ insert into ops.control_requests (kind, payload) values ('PAUSE_NEW_ENTRIES', '{}') $$,
  'aal2 operator files a pause without any passkey');
select throws_ok(
  $$ select * from ops.begin_step_up('ARM_RELEASE', repeat('a', 64)) $$,
  'P0001', 'NO_PASSKEY', 'no passkey: step-up for ARM_RELEASE is refused');
select throws_ok(
  $$ select * from ops.begin_step_up('REGISTER_PASSKEY', repeat('b', 64)) $$,
  'P0001', 'FRESH_TOTP_REQUIRED', 'the first passkey needs a TOTP verified within five minutes (R2-01)');
reset role;

-- 3. aal2 with a fresh TOTP in amr: first-passkey challenge is issued; browser still cannot write passkeys
set local role authenticated;
select set_config('request.jwt.claims',
  format('{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2","amr":[{"method":"password","timestamp":0},{"method":"totp","timestamp":%s}]}',
         extract(epoch from now())::bigint), true);
select lives_ok(
  $$ select * from ops.begin_step_up('REGISTER_PASSKEY', repeat('b', 64)) $$,
  'REGISTER_PASSKEY challenge is issued for the first passkey with fresh TOTP');
select throws_ok(
  $$ insert into ops.operator_passkeys (user_id, credential_id, public_key_cose, label)
     values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'browserwritten_credential_id', 'pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAA', 'x') $$,
  '42501', null, 'the browser role cannot write passkeys');
select throws_ok(
  $$ select * from ops.consume_step_up_challenge('00000000-0000-4000-8000-000000000000', null, true, null, null) $$,
  '42501', null, 'the browser role cannot consume challenges or record assertions');
reset role;

-- 4. the worker (service role, here postgres) registers a passkey after verifying the ceremony
insert into ops.operator_passkeys (id, user_id, credential_id, public_key_cose, label, usable_from)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Y3JlZGVudGlhbC1pZC0x', 'pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAA', 'YubiKey', now() + interval '1 hour');
select is(
  (select count(*) from ops.notifications
    where severity = 'CRITICAL' and alert_class = 'OPERATOR_PASSKEY_REGISTERED'
      and affected ->> 'system' = 'operator-security:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::int,
  1, 'registering a passkey raises a CRITICAL notification for that operator');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":0}]}', true);
select is(
  (select length(challenge) from ops.begin_step_up('ARM_RELEASE', repeat('a', 64))),
  43, 'with a passkey, a 32-byte base64url challenge is issued');
select lives_ok(
  $$ select * from ops.begin_step_up('REGISTER_PASSKEY', repeat('b', 64)) $$,
  'a second passkey challenge is issued without fresh TOTP (the worker demands an existing-passkey assertion)');
select is(
  (select count(*) from ops.step_up_challenges where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and consumed_at is null)::int,
  3, 'the operator reads their own open challenges');
select isnt(
  (select challenge from ops.begin_step_up('ARM_RELEASE', repeat('a', 64))),
  (select challenge from ops.begin_step_up('ARM_RELEASE', repeat('a', 64))),
  'every challenge is fresh randomness');
select throws_ok(
  $$ update ops.step_up_challenges set consumed_at = now() $$,
  '42501', null, 'the browser role cannot consume or alter challenges');
select throws_ok(
  $$ insert into ops.step_up_assertions (challenge_id, user_id, kind, binding_hash, verified, expires_at)
     select id, user_id, kind, binding_hash, true, now() + interval '5 minutes' from ops.step_up_challenges limit 1 $$,
  '42501', null, 'the browser role cannot forge a verified assertion');
reset role;

-- 5. a stranger sees nothing and cannot begin step-up
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}', true);
select is((select count(*) from ops.step_up_challenges)::int, 0, 'a stranger reads no challenges');
select throws_ok(
  $$ select * from ops.begin_step_up('PAUSE_NEW_ENTRIES', repeat('a', 64)) $$,
  '42501', null, 'a user without an operator row cannot begin step-up');
reset role;

-- 6. atomic consumption by the backend (R2-04)
create temp table target as
  select c.id from ops.step_up_challenges c where c.kind = 'ARM_RELEASE' order by c.issued_at limit 1;
select is(
  (select verified from ops.consume_step_up_challenge((select id from target), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true, null, null)),
  true, 'the backend consumes a challenge and records the assertion in one call');
select throws_ok(
  $$ select * from ops.consume_step_up_challenge((select id from target), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true, null, null) $$,
  'P0001', 'CHALLENGE_UNAVAILABLE', 'the same challenge cannot be consumed twice (second worker loses the race)');
select throws_ok(
  $$ update ops.step_up_assertions set verified = false $$,
  null, null, 'a recorded assertion cannot be rewritten');

-- 7. an expired challenge that an assertion references never blocks later step-up (R2-04)
insert into ops.step_up_challenges (id, user_id, kind, binding_hash, challenge, issued_at, expires_at)
values ('99999999-9999-4999-8999-999999999999', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'ARM_RELEASE', repeat('c', 64), rpad('expired', 43, 'x'), now() - interval '10 minutes', now() - interval '5 minutes');
insert into ops.step_up_assertions (challenge_id, user_id, kind, binding_hash, verified, failure_reason, expires_at)
values ('99999999-9999-4999-8999-999999999999', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'ARM_RELEASE', repeat('c', 64), false, 'ASSERTION_INVALID', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}', true);
select lives_ok(
  $$ select * from ops.begin_step_up('ARM_RELEASE', repeat('a', 64)) $$,
  'begin_step_up still works when an expired challenge is referenced by a failed assertion');
reset role;

select * from finish();
rollback;
