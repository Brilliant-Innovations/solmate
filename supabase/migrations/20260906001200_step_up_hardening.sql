-- Step-up hardening after the interim adversarial review
-- (docs/reviews/review-m2-interim-containers-and-step-up.md: R2-01, R2-04, R2-11; ADR-0006 amendment).
--
-- - R2-01: only the FIRST passkey may be added with TOTP alone, and only from a session whose TOTP
--   verification is fresh (JWT `amr` claim); every later registration needs an assertion from an
--   existing passkey (enforced by the worker) and a first passkey enters a cooling period. Every
--   registration raises a CRITICAL notification.
-- - R2-04: challenges are consumed atomically by a backend-only function that also records the
--   assertion; begin_step_up no longer deletes rows (an assertion may reference an expired one).
-- - R2-11: bound the stored COSE public key.

alter table ops.operator_passkeys
  add column usable_from timestamptz not null default now(),
  add constraint operator_passkeys_public_key_len check (length(public_key_cose) <= 2048);

-- Was the session's TOTP verification recent? Supabase puts {method, timestamp} entries in `amr`.
create or replace function ops.session_recent_totp(p_within interval)
returns boolean
language sql
stable
set search_path = ''
as $$
  with claims as (
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c
  )
  select exists (
    select 1
    from claims,
         jsonb_array_elements(case when jsonb_typeof(claims.c -> 'amr') = 'array' then claims.c -> 'amr' else '[]'::jsonb end) a
    where a ->> 'method' = 'totp'
      and (a ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$'
      and to_timestamp((a ->> 'timestamp')::double precision) >= now() - p_within
  )
$$;
revoke all on function ops.session_recent_totp(interval) from public;
grant execute on function ops.session_recent_totp(interval) to authenticated;

-- Challenge issuance (replaces the M2 version). Same signature.
create or replace function ops.begin_step_up(p_kind enums.control_request_kind, p_binding_hash core.sha256_hex)
returns table (id uuid, challenge text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_active_passkeys integer;
  v_challenge text;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_user is null or not ops.has_role('operator') then
    raise exception 'step-up requires an operator session' using errcode = '42501';
  end if;
  if not ops.has_aal2() then
    raise exception 'step-up requires an aal2 (TOTP-verified) session' using errcode = '42501';
  end if;

  select count(*) into v_active_passkeys
  from ops.operator_passkeys p where p.user_id = v_user and p.revoked_at is null;

  if p_kind = 'REGISTER_PASSKEY' then
    -- First passkey: TOTP alone is accepted only when it was verified moments ago (R2-01).
    -- Later passkeys: the challenge is issued; the worker demands an existing-passkey assertion.
    if v_active_passkeys = 0 and not ops.session_recent_totp(interval '5 minutes') then
      raise exception 'FRESH_TOTP_REQUIRED' using errcode = 'P0001', hint = 'verify your authenticator code again, then register the first passkey';
    end if;
  elsif v_active_passkeys = 0 then
    raise exception 'NO_PASSKEY' using errcode = 'P0001', hint = 'register a passkey first';
  end if;

  if (select count(*) from ops.step_up_challenges c
       where c.user_id = v_user and c.consumed_at is null and c.expires_at > now()) >= 10 then
    raise exception 'too many open step-up challenges' using errcode = 'P0001';
  end if;

  v_challenge := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_expires := now() + interval '5 minutes';
  insert into ops.step_up_challenges (user_id, kind, binding_hash, challenge, expires_at)
  values (v_user, p_kind, p_binding_hash, v_challenge, v_expires)
  returning step_up_challenges.id into v_id;

  return query select v_id, v_challenge, v_expires;
end
$$;

-- Backend-only: consume a challenge and record the verdict in one statement. The worker acts on a
-- request only after this returns a row; a second caller for the same challenge gets an error,
-- which closes the two-workers race (R2-04).
create or replace function ops.consume_step_up_challenge(
  p_challenge_id uuid,
  p_passkey_id uuid,
  p_verified boolean,
  p_failure_reason text,
  p_control_request_id uuid
)
returns ops.step_up_assertions
language plpgsql
set search_path = ''
as $$
declare
  c ops.step_up_challenges;
  a ops.step_up_assertions;
begin
  update ops.step_up_challenges s
     set consumed_at = now()
   where s.id = p_challenge_id and s.consumed_at is null and s.expires_at > now()
  returning s.* into c;
  if c.id is null then
    raise exception 'CHALLENGE_UNAVAILABLE' using errcode = 'P0001', hint = 'consumed, expired or unknown';
  end if;
  insert into ops.step_up_assertions (challenge_id, user_id, passkey_id, kind, binding_hash, verified, failure_reason, expires_at, control_request_id)
  values (c.id, c.user_id, p_passkey_id, c.kind, c.binding_hash, p_verified, p_failure_reason, now() + interval '5 minutes', p_control_request_id)
  returning * into a;
  return a;
end
$$;
revoke all on function ops.consume_step_up_challenge(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;
grant execute on function ops.consume_step_up_challenge(uuid, uuid, boolean, text, uuid) to service_role;

-- Every passkey registration is a CRITICAL, out-of-app alert (§20.20, D42): a hijacked session that
-- adds a credential must be visible before the cooling period ends.
create or replace function ops.notify_passkey_registered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into ops.notifications (severity, alert_class, summary, affected)
  values (
    'CRITICAL',
    'OPERATOR_PASSKEY_REGISTERED',
    format('Passkey "%s" registered for operator %s; usable from %s', new.label, new.user_id, to_char(new.usable_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    jsonb_build_object('assetId', null, 'strategyVersionId', null, 'positionId', null, 'system', 'operator-security:' || new.user_id::text)
  );
  return new;
end
$$;
create trigger operator_passkeys_notify after insert on ops.operator_passkeys
  for each row execute function ops.notify_passkey_registered();
