-- Persisted metered-provider spend (blueprint §21.1, D43; execution plan M4). Birdeye meters
-- compute units per calendar month; the worker's in-memory ledger resumes from this row so a
-- restart never resets the count. One row per provider and month; the increment is atomic.

create table ops.provider_spend (
  provider text not null check (length(provider) between 1 and 64),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  used_cu bigint not null default 0 check (used_cu >= 0),
  by_endpoint jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (provider, month)
);
create trigger provider_spend_touch before update on ops.provider_spend for each row execute function core.touch_updated_at();

create or replace function ops.charge_provider_spend(p_provider text, p_month text, p_endpoint text, p_cu bigint)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_used bigint;
begin
  if p_cu < 0 then
    raise exception 'charge must be non-negative' using errcode = 'P0001';
  end if;
  insert into ops.provider_spend (provider, month, used_cu, by_endpoint)
  values (p_provider, p_month, p_cu, jsonb_build_object(p_endpoint, p_cu))
  on conflict (provider, month) do update
    set used_cu = ops.provider_spend.used_cu + excluded.used_cu,
        by_endpoint = ops.provider_spend.by_endpoint
          || jsonb_build_object(p_endpoint, coalesce((ops.provider_spend.by_endpoint ->> p_endpoint)::bigint, 0) + p_cu)
  returning used_cu into v_used;
  return v_used;
end
$$;
revoke all on function ops.charge_provider_spend(text, text, text, bigint) from public, anon, authenticated;
grant execute on function ops.charge_provider_spend(text, text, text, bigint) to service_role;

alter table ops.provider_spend enable row level security;
alter table ops.provider_spend force row level security;
grant select on ops.provider_spend to authenticated;
create policy operators_read on ops.provider_spend for select to authenticated using (ops.has_role('viewer'));
