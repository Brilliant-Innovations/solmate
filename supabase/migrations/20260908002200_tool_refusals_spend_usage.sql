-- §11.4 / INV-16: a tool call that never reached a handler (unregistered name, bad arguments, out-of-scope id,
-- hallucinated evidence, budget) is audited next to tool_invocations, append-only.
create table agents.tool_refusals (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agents.runs (id),
  action_cycle_id uuid not null references agents.action_cycles (id),
  requested_tool text not null check (length(requested_tool) <= 64),
  reason text not null check (reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  detail text not null check (length(detail) <= 1024),
  request_hash core.sha256_hex not null,
  cutoff_version integer not null check (cutoff_version > 0),
  created_at timestamptz not null default now()
);
create index tool_refusals_run_idx on agents.tool_refusals (agent_run_id);
create trigger tool_refusals_immutable before update or delete on agents.tool_refusals for each row execute function core.forbid_update();
alter table agents.tool_refusals enable row level security;

-- D43: one atomic charge against a spend-usage window; creates the window on first use. The row that comes back
-- is the post-charge state so the caller can compare it with the budget limits it already holds.
create or replace function ops.charge_spend_usage(p_budget_id uuid, p_window_start timestamptz, p_window_end timestamptz, p_cycles integer, p_model_usd double precision, p_provider_requests integer)
returns ops.spend_usage language plpgsql as $$
declare
  r ops.spend_usage;
begin
  if p_cycles < 0 or p_model_usd < 0 or p_provider_requests < 0 then
    raise exception 'ops.charge_spend_usage: charges are non-negative';
  end if;
  insert into ops.spend_usage (budget_id, window_start, window_end, cycles, model_usd, provider_requests, state, updated_at)
  values (p_budget_id, p_window_start, p_window_end, p_cycles, p_model_usd, p_provider_requests, 'OK', now())
  on conflict (budget_id, window_start) do update
    set cycles = ops.spend_usage.cycles + excluded.cycles,
        model_usd = ops.spend_usage.model_usd + excluded.model_usd,
        provider_requests = ops.spend_usage.provider_requests + excluded.provider_requests,
        updated_at = now()
  returning * into r;
  return r;
end $$;
revoke all on function ops.charge_spend_usage(uuid, timestamptz, timestamptz, integer, double precision, integer) from public, anon, authenticated;
grant execute on function ops.charge_spend_usage(uuid, timestamptz, timestamptz, integer, double precision, integer) to service_role;

-- A paused window may only be un-paused by a new window; state moves OK → BUDGET_PAUSED once.
create or replace function ops.spend_usage_guard_update()
returns trigger language plpgsql as $$
begin
  if old.state = 'BUDGET_PAUSED' and new.state <> 'BUDGET_PAUSED' then
    raise exception 'ops.spend_usage: a paused window stays paused (D43)';
  end if;
  if new.cycles < old.cycles or new.model_usd < old.model_usd or new.provider_requests < old.provider_requests then
    raise exception 'ops.spend_usage: usage counters only increase within a window';
  end if;
  return new;
end $$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'spend_usage_guard' and tgrelid = 'ops.spend_usage'::regclass) then
    create trigger spend_usage_guard before update on ops.spend_usage for each row execute function ops.spend_usage_guard_update();
  end if;
end $$;
