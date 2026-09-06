-- Operator step-up substrate (blueprint §5.7, §15.6, §20.26, D41; ADR-0006).
--
-- Model:
-- - Supabase Auth owns identity and TOTP. A browser session may write a control request only at
--   AAL2 (TOTP verified): ops.has_aal2() gates the single browser write surface.
-- - Passkeys (WebAuthn) are the primary step-up for authority-widening controls. The database
--   issues the challenge (server-side randomness, bound to one exact request), the worker verifies
--   the assertion with SimpleWebAuthn and writes the immutable assertion row. The browser never
--   writes a passkey or an assertion; database rows alone remain no authority (§31).

create domain core.base64url as text check (value ~ '^[A-Za-z0-9_-]+$');

-- Session assurance level from the JWT (Supabase sets aal1/aal2). Missing claim = aal1.
create or replace function ops.session_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1')
$$;
revoke all on function ops.session_aal() from public;
grant execute on function ops.session_aal() to authenticated;

create or replace function ops.has_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select ops.session_aal() = 'aal2'
$$;
revoke all on function ops.has_aal2() from public;
grant execute on function ops.has_aal2() to authenticated;

-- The browser write surface now requires an aal2 session in addition to the operator role.
drop policy if exists operators_request_control on ops.control_requests;
create policy operators_request_control on ops.control_requests
  for insert to authenticated
  with check (ops.has_role('operator') and requested_by = auth.uid() and ops.has_aal2());

-- ---------------------------------------------------------------------------------------------
-- Passkeys: public credential material per operator. Written by the worker only.
-- ---------------------------------------------------------------------------------------------
create table ops.operator_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  credential_id core.base64url not null unique check (length(credential_id) between 16 and 1024),
  public_key_cose core.base64url not null check (length(public_key_cose) >= 16),
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  aaguid uuid,
  backed_up boolean not null default false,
  label text not null check (length(label) between 1 and 64),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index operator_passkeys_user_idx on ops.operator_passkeys (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------------------------
-- Challenges: one per intended control request, issued by the database, five-minute life.
-- ---------------------------------------------------------------------------------------------
create table ops.step_up_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind enums.control_request_kind not null,
  binding_hash core.sha256_hex not null,
  challenge core.base64url not null unique check (length(challenge) = 43),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at)
);
create index step_up_challenges_user_idx on ops.step_up_challenges (user_id, expires_at);

-- ---------------------------------------------------------------------------------------------
-- Assertions: immutable verification outcomes, written by the worker after verification.
-- ---------------------------------------------------------------------------------------------
create table ops.step_up_assertions (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null unique references ops.step_up_challenges (id),
  user_id uuid not null references auth.users (id),
  passkey_id uuid references ops.operator_passkeys (id),
  kind enums.control_request_kind not null,
  binding_hash core.sha256_hex not null,
  verified boolean not null,
  failure_reason text check (failure_reason is null or length(failure_reason) between 1 and 256),
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  control_request_id uuid references ops.control_requests (id),
  check (verified or failure_reason is not null)
);
create index step_up_assertions_request_idx on ops.step_up_assertions (control_request_id);
create trigger step_up_assertions_immutable before update or delete on ops.step_up_assertions
  for each row execute function core.forbid_update();

-- ---------------------------------------------------------------------------------------------
-- Challenge issuance. Callable by an aal2 operator session for itself only. REGISTER_PASSKEY is
-- the one kind that needs no existing passkey (it is how the first one is added).
-- ---------------------------------------------------------------------------------------------
create or replace function ops.begin_step_up(p_kind enums.control_request_kind, p_binding_hash core.sha256_hex)
returns table (id uuid, challenge text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
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
  if p_kind <> 'REGISTER_PASSKEY'
     and not exists (select 1 from ops.operator_passkeys p where p.user_id = v_user and p.revoked_at is null) then
    raise exception 'NO_PASSKEY' using errcode = 'P0001', hint = 'register a passkey first';
  end if;

  delete from ops.step_up_challenges c
   where c.user_id = v_user and c.consumed_at is null and c.expires_at < now();
  if (select count(*) from ops.step_up_challenges c where c.user_id = v_user and c.consumed_at is null) >= 10 then
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
revoke all on function ops.begin_step_up(enums.control_request_kind, core.sha256_hex) from public;
grant execute on function ops.begin_step_up(enums.control_request_kind, core.sha256_hex) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS: operators read their own rows (admins read all passkeys for §20.26); nobody in the browser
-- role writes any of these tables.
-- ---------------------------------------------------------------------------------------------
alter table ops.operator_passkeys enable row level security;
alter table ops.operator_passkeys force row level security;
alter table ops.step_up_challenges enable row level security;
alter table ops.step_up_challenges force row level security;
alter table ops.step_up_assertions enable row level security;
alter table ops.step_up_assertions force row level security;

grant select on ops.operator_passkeys, ops.step_up_challenges, ops.step_up_assertions to authenticated;

create policy passkeys_self_or_admin on ops.operator_passkeys
  for select to authenticated using (user_id = auth.uid() or ops.has_role('admin'));
create policy challenges_self on ops.step_up_challenges
  for select to authenticated using (user_id = auth.uid());
create policy assertions_self_or_admin on ops.step_up_assertions
  for select to authenticated using (user_id = auth.uid() or ops.has_role('admin'));
