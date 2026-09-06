-- §6.1–6.5: assets, eligibility, cohorts, candles, snapshots.

-- §6.1 core.assets: canonical identity by mint, never by symbol.
create table core.assets (
  id uuid primary key default gen_random_uuid(),
  chain text not null default 'solana' check (chain = 'solana'),
  mint_address core.solana_address not null unique,
  symbol text not null check (length(symbol) between 1 and 32),
  name text not null check (length(name) between 1 and 128),
  decimals smallint not null check (decimals between 0 and 18),
  token_program enums.token_program not null,
  token_program_id core.solana_address,
  first_observed_at timestamptz not null,
  estimated_created_at timestamptz,
  status enums.asset_status not null default 'DISCOVERED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger assets_touch before update on core.assets for each row execute function core.touch_updated_at();
create index assets_status_idx on core.assets (status);

-- §6.2 emergency exit route snapshots (persisted at eligibility time, never discovered in a panic)
create table core.emergency_exit_route_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  hops jsonb not null,
  settlement_mint core.solana_address not null,
  pool_state_ref text not null,
  last_refreshed_at timestamptz not null,
  last_refresh_slot bigint not null check (last_refresh_slot >= 0),
  capacity jsonb not null default '[]'::jsonb,
  token2022_compatible boolean not null,
  last_dry_run jsonb,
  created_at timestamptz not null default now()
);
create index emergency_routes_asset_idx on core.emergency_exit_route_snapshots (asset_id, last_refreshed_at desc);

-- §6.2 core.asset_eligibility: latest deterministic decision plus versioned history (append-only)
create table core.asset_eligibility (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  evaluated_at timestamptz not null,
  policy_version core.version_id not null,
  eligible boolean not null,
  hard_reject boolean not null,
  rejection_reasons core.reason_code[] not null default '{}',
  grade double precision check (grade between 0 and 100),
  liquidity_usd double precision check (liquidity_usd >= 0),
  volume_24h_usd double precision check (volume_24h_usd >= 0),
  holder_count integer check (holder_count >= 0),
  concentration jsonb,
  mint_authority enums.authority_state not null,
  freeze_authority enums.authority_state not null,
  token2022 jsonb,
  security_flags core.reason_code[] not null default '{}',
  transfer_restrictions core.reason_code[] not null default '{}',
  jupiter_route_available boolean not null,
  settlement_route_confirmed boolean not null,
  price_impact_probes jsonb not null default '[]'::jsonb,
  insider_metrics jsonb,
  emergency_exit_route_snapshot_id uuid references core.emergency_exit_route_snapshots (id),
  freshness jsonb not null,
  created_at timestamptz not null default now()
);
create index asset_eligibility_latest_idx on core.asset_eligibility (asset_id, evaluated_at desc);
create trigger asset_eligibility_immutable before update or delete on core.asset_eligibility for each row execute function core.forbid_update();

-- §6.3 deterministic, versioned cohorts (D23)
create table core.risk_cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 64),
  kind text not null default 'TAXONOMY' check (kind = 'TAXONOMY'),
  version_id core.version_id not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name, version_id)
);

create table core.asset_cohort_memberships (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  cohort_id uuid not null references core.risk_cohorts (id),
  source text not null check (source in ('MANUAL', 'PROVIDER', 'LLM_SUGGESTION')),
  effective_version core.version_id not null,
  confidence core.fraction not null,
  approval_state text not null check (approval_state in ('ACTIVE', 'PENDING', 'REJECTED', 'INACTIVE_SUGGESTION')),
  created_at timestamptz not null default now(),
  -- D23: an LLM suggestion can never be active membership
  constraint llm_suggestions_never_active check (not (source = 'LLM_SUGGESTION' and approval_state = 'ACTIVE'))
);
create index cohort_memberships_asset_idx on core.asset_cohort_memberships (asset_id) where approval_state = 'ACTIVE';

create table risk.correlation_clusters (
  id uuid primary key default gen_random_uuid(),
  version_id core.version_id not null unique,
  window_start timestamptz not null,
  window_end timestamptz not null,
  calculated_at timestamptz not null,
  method text not null,
  clusters jsonb not null,
  check (window_end > window_start)
);

-- §6.4 market.candles: partitioned by month on bucket_time; §25 retention by resolution.
create table market.candles (
  asset_id uuid not null references core.assets (id),
  provider text not null,
  resolution enums.candle_resolution not null,
  bucket_time timestamptz not null,
  observed_at timestamptz not null,
  provenance enums.data_provenance not null,
  open double precision not null check (open >= 0),
  high double precision not null check (high >= 0),
  low double precision not null check (low >= 0),
  close double precision not null check (close >= 0),
  volume_usd double precision not null check (volume_usd >= 0),
  trade_count integer check (trade_count >= 0),
  primary key (asset_id, provider, resolution, bucket_time)
) partition by range (bucket_time);

create or replace function market.ensure_candle_partitions(from_month date, months integer)
returns void language plpgsql as $$
declare
  m date := date_trunc('month', from_month)::date;
  i integer;
  part text;
begin
  for i in 0 .. months - 1 loop
    part := format('candles_%s', to_char(m, 'YYYY_MM'));
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'market' and c.relname = part) then
      execute format('create table market.%I partition of market.candles for values from (%L) to (%L)', part, m, (m + interval '1 month')::date);
    end if;
    m := (m + interval '1 month')::date;
  end loop;
end $$;

select market.ensure_candle_partitions('2026-09-01', 6);

-- §6.5 market.snapshots: point-in-time market state persisted at every score/decision
create table market.snapshots (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  as_of timestamptz not null,
  observed_at timestamptz not null,
  provenance enums.data_provenance not null,
  price_usd double precision check (price_usd >= 0),
  liquidity_usd double precision check (liquidity_usd >= 0),
  volume_usd jsonb not null,
  buy_volume_usd jsonb not null,
  sell_volume_usd jsonb not null,
  buy_count jsonb not null,
  sell_count jsonb not null,
  relative_volume double precision check (relative_volume >= 0),
  atr double precision check (atr >= 0),
  realized_volatility double precision check (realized_volatility >= 0),
  returns jsonb not null,
  market_cap_usd double precision check (market_cap_usd >= 0),
  fdv_usd double precision check (fdv_usd >= 0),
  sol_relative_return double precision,
  universe_relative_strength double precision,
  route_probes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index snapshots_asset_asof_idx on market.snapshots (asset_id, as_of desc);
create trigger snapshots_immutable before update or delete on market.snapshots for each row execute function core.forbid_update();
