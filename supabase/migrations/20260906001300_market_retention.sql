-- Market data retention jobs (blueprint §25, §6.4; execution plan M4 "retention jobs per §25").
--
-- Policy is configuration (ops.retention_policies), pruning is a function the scheduler runs
-- daily, and partition creation runs monthly so no insert ever lands outside a partition.
-- Snapshots (§6.5) are decision evidence and are never pruned. pg_cron is the scheduler on both the
-- local stack and hosted Supabase (enable the extension on the hosted project first).

create extension if not exists pg_cron;

create table ops.retention_policies (
  resolution enums.candle_resolution primary key,
  -- null = permanent
  retention_days integer check (retention_days is null or retention_days > 0),
  updated_at timestamptz not null default now()
);
create trigger retention_policies_touch before update on ops.retention_policies for each row execute function core.touch_updated_at();

-- §25 initial policy (mirrors DEFAULT_CANDLE_RETENTION in libs/contracts).
insert into ops.retention_policies (resolution, retention_days) values
  ('15s', 21), ('1m', 730), ('5m', 1825), ('15m', 1825), ('1h', null), ('4h', null);

-- Delete candles older than their resolution's retention. Returns what was deleted per resolution.
create or replace function market.prune_candles()
returns table (resolution enums.candle_resolution, deleted bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
  n bigint;
begin
  for p in select r.resolution, r.retention_days from ops.retention_policies r where r.retention_days is not null loop
    delete from market.candles c
     where c.resolution = p.resolution
       and c.bucket_time < now() - make_interval(days => p.retention_days);
    get diagnostics n = row_count;
    resolution := p.resolution;
    deleted := n;
    return next;
  end loop;
end
$$;
revoke all on function market.prune_candles() from public, anon, authenticated;

-- Keep partitions for the current month plus the next three.
create or replace function market.maintain_candle_partitions()
returns void
language sql
security definer
set search_path = ''
as $$
  select market.ensure_candle_partitions(date_trunc('month', now())::date, 4)
$$;
revoke all on function market.maintain_candle_partitions() from public, anon, authenticated;

-- Schedules (idempotent: cron.schedule by name replaces).
select cron.schedule('market-prune-candles', '17 3 * * *', $$select market.prune_candles()$$);
select cron.schedule('market-candle-partitions', '5 2 1 * *', $$select market.maintain_candle_partitions()$$);

-- Operators may read the policy (Settings, read-only); only backend roles change it.
alter table ops.retention_policies enable row level security;
alter table ops.retention_policies force row level security;
grant select on ops.retention_policies to authenticated;
create policy retention_policies_read on ops.retention_policies for select to authenticated using (ops.has_role('viewer'));
