-- §5.4 queue processing support and worker leases (P0 acceptance: workers recover leases).

-- Exact-once processing guard (D12). A message's idempotency key is claimed inside the handler's
-- transaction; a redelivery of an already-processed key is archived without re-running the handler.
create table ops.processed_messages (
  idempotency_key text primary key check (length(idempotency_key) between 8 and 128),
  queue text not null,
  kind text not null,
  message_id bigint not null,
  processed_at timestamptz not null default now(),
  processed_by text not null,
  result_hash core.sha256_hex
);
create index processed_messages_time_idx on ops.processed_messages (processed_at);

-- Dead letters: messages archived after exhausting retries or failing contract checks (§5.4).
create table ops.dead_letters (
  id uuid primary key default gen_random_uuid(),
  queue text not null,
  message_id bigint not null,
  idempotency_key text,
  kind text,
  reason text not null,
  attempts integer not null check (attempts >= 0),
  last_error text,
  message jsonb not null,
  dead_lettered_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id)
);
create index dead_letters_open_idx on ops.dead_letters (queue, dead_lettered_at) where resolved_at is null;

-- Leases: one holder per role; an expired lease may be taken over by another holder.
create or replace function ops.acquire_lease(p_role text, p_holder text, p_ttl_seconds integer)
returns boolean language plpgsql as $$
declare
  acquired boolean := false;
begin
  insert into ops.worker_leases (role, holder, acquired_at, heartbeat_at, expires_at)
  values (p_role, p_holder, now(), now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (role) do update
    set holder = excluded.holder, acquired_at = now(), heartbeat_at = now(), expires_at = excluded.expires_at
    where ops.worker_leases.expires_at < now() or ops.worker_leases.holder = excluded.holder
  returning true into acquired;
  return coalesce(acquired, false);
end $$;

create or replace function ops.heartbeat_lease(p_role text, p_holder text, p_ttl_seconds integer)
returns boolean language plpgsql as $$
declare
  ok boolean := false;
begin
  update ops.worker_leases
  set heartbeat_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
  where role = p_role and holder = p_holder and expires_at >= now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function ops.release_lease(p_role text, p_holder text)
returns boolean language plpgsql as $$
declare
  ok boolean := false;
begin
  delete from ops.worker_leases where role = p_role and holder = p_holder returning true into ok;
  return coalesce(ok, false);
end $$;

-- These are backend-only.
revoke all on function ops.acquire_lease(text, text, integer) from public, anon, authenticated;
revoke all on function ops.heartbeat_lease(text, text, integer) from public, anon, authenticated;
revoke all on function ops.release_lease(text, text) from public, anon, authenticated;
