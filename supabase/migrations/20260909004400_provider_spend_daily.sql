-- A daily row per provider alongside the monthly total (WP1, 2026-09-09).
--
-- `ops.provider_spend` keeps one cumulative row per provider and month, which is exactly what the
-- monthly allowance needs and nothing else. It cost the WP1 budget report a day of excavation: every
-- per-day figure in `docs/probes/data-budget-2026-09-09.md` had to be reconstructed from
-- `market.candles` observation timestamps, and the run-rate error that started the whole exercise —
-- dividing month-to-date compute units by elapsed *calendar* days rather than days actually ingesting
-- — is precisely the mistake a daily series makes impossible to write.
--
-- So the monthly row stays the authority for the allowance, and this adds the series next to it. The
-- charge function writes both in the same statement, so they cannot disagree about a charge.

create table ops.provider_spend_daily (
  provider text not null check (length(provider) between 1 and 64),
  day date not null,
  used_cu bigint not null default 0 check (used_cu >= 0),
  by_endpoint jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (provider, day)
);
create index provider_spend_daily_day_idx on ops.provider_spend_daily (day desc);
create trigger provider_spend_daily_touch before update on ops.provider_spend_daily for each row execute function core.touch_updated_at();

comment on table ops.provider_spend_daily is
  'Metered-provider compute units per provider per UTC day. The monthly ops.provider_spend row remains the allowance authority; this is the series for run-rate and per-endpoint questions (§21.1, D43).';

-- Charge both in one statement. The monthly return value is unchanged, so every existing caller and
-- the worker''s in-memory ledger keep the same contract.
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

  -- The day is taken from the clock rather than parsed out of p_month: a charge always belongs to the
  -- day it happened, even on the boundary where the caller's month string and now() briefly disagree.
  insert into ops.provider_spend_daily (provider, day, used_cu, by_endpoint)
  values (p_provider, (now() at time zone 'utc')::date, p_cu, jsonb_build_object(p_endpoint, p_cu))
  on conflict (provider, day) do update
    set used_cu = ops.provider_spend_daily.used_cu + excluded.used_cu,
        by_endpoint = ops.provider_spend_daily.by_endpoint
          || jsonb_build_object(p_endpoint, coalesce((ops.provider_spend_daily.by_endpoint ->> p_endpoint)::bigint, 0) + p_cu);

  return v_used;
end
$$;

alter table ops.provider_spend_daily enable row level security;
revoke all on table ops.provider_spend_daily from anon, authenticated;
grant select on table ops.provider_spend_daily to authenticated;
create policy provider_spend_daily_read on ops.provider_spend_daily for select to authenticated using (ops.has_role('viewer'));
