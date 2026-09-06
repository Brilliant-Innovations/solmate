-- pgTAP: operator step-up substrate (§5.7, §20.26, D41; ADR-0006).
begin;
select plan(14);

insert into auth.users (id, email, instance_id, aud, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'op@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stranger@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into ops.operators (user_id, role, display_name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'operator', 'Op');

-- 1. an operator whose session is only aal1 cannot file any control request, not even pause
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$ insert into ops.control_requests (kind, payload) values ('PAUSE_NEW_ENTRIES', '{}') $$,
  '42501', null, 'aal1 session cannot file a control request');
select throws_ok(
  $$ select * from ops.begin_step_up('ARM_RELEASE', repeat('a', 64)) $$,
  '42501', null, 'aal1 session cannot begin step-up');
reset role;

-- 2. at aal2 the fast path works, but step-up for an authority-widening kind needs a passkey
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}', true);
select lives_ok(
  $$ insert into ops.control_requests (kind, payload) values ('PAUSE_NEW_ENTRIES', '{}') $$,
  'aal2 operator files a pause without any passkey');
select throws_ok(
  $$ select * from ops.begin_step_up('ARM_RELEASE', repeat('a', 64)) $$,
  'P0001', 'NO_PASSKEY', 'no passkey: step-up for ARM_RELEASE is refused');
select lives_ok(
  $$ select * from ops.begin_step_up('REGISTER_PASSKEY', repeat('b', 64)) $$,
  'REGISTER_PASSKEY challenge is issued without an existing passkey');
select throws_ok(
  $$ insert into ops.operator_passkeys (user_id, credential_id, public_key_cose, label)
     values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'browserwritten_credential_id', 'pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAA', 'x') $$,
  '42501', null, 'the browser role cannot write passkeys');
reset role;

-- 3. the worker (service role, here postgres) registers a passkey after verifying the ceremony
insert into ops.operator_passkeys (id, user_id, credential_id, public_key_cose, label)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Y3JlZGVudGlhbC1pZC0x', 'pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAA', 'YubiKey');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}', true);
select is(
  (select length(challenge) from ops.begin_step_up('ARM_RELEASE', repeat('a', 64))),
  43, 'with a passkey, a 32-byte base64url challenge is issued');
select is(
  (select count(*) from ops.step_up_challenges where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and consumed_at is null)::int,
  2, 'the operator reads their own open challenges (REGISTER_PASSKEY + ARM_RELEASE)');
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

-- 4. a stranger sees nothing and cannot begin step-up
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}', true);
select is((select count(*) from ops.step_up_challenges)::int, 0, 'a stranger reads no challenges');
select throws_ok(
  $$ select * from ops.begin_step_up('PAUSE_NEW_ENTRIES', repeat('a', 64)) $$,
  '42501', null, 'a user without an operator row cannot begin step-up');
reset role;

-- 5. assertions written by the worker are immutable
insert into ops.step_up_assertions (id, challenge_id, user_id, passkey_id, kind, binding_hash, verified, expires_at)
select 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', c.id, c.user_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', c.kind, c.binding_hash, true, now() + interval '5 minutes'
from ops.step_up_challenges c where c.kind = 'ARM_RELEASE' order by c.issued_at limit 1;
select throws_ok(
  $$ update ops.step_up_assertions set verified = false where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' $$,
  null, null, 'a recorded assertion cannot be rewritten');

select * from finish();
rollback;
