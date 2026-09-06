-- §6.6–6.9: evidence events, tracked wallets, feature snapshots, candidates.

-- §6.6 intelligence.events: two clocks (source time vs first_seen_at), never rewritten (D8, D64).
create table intelligence.events (
  id uuid primary key default gen_random_uuid(),
  kind enums.event_kind not null,
  source_provider text not null,
  source_id text not null,
  source_url_hash core.sha256_hex,
  source_published_at timestamptz,
  source_time_confidence enums.source_time_confidence not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  title text check (length(title) <= 512),
  summary text check (length(summary) <= 4096),
  source_quality enums.source_quality_class not null,
  novelty_score core.fraction,
  sentiment jsonb,
  classification text check (length(classification) <= 64),
  cluster_id uuid,
  corroborates_event_id uuid references intelligence.events (id),
  payload_hash core.sha256_hex not null,
  raw_payload_ref text,
  unique (source_provider, source_id)
);
create index events_first_seen_idx on intelligence.events (first_seen_at);
create index events_cluster_idx on intelligence.events (cluster_id) where cluster_id is not null;

create table intelligence.event_assets (
  event_id uuid not null references intelligence.events (id) on delete cascade,
  asset_id uuid not null references core.assets (id),
  primary key (event_id, asset_id)
);
create index event_assets_asset_idx on intelligence.event_assets (asset_id);

-- Immutable except last_seen_at, cluster_id, novelty_score and corroborates_event_id (dedupe results).
create or replace function intelligence.events_guard_update()
returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.source_provider is distinct from old.source_provider
     or new.source_id is distinct from old.source_id or new.source_published_at is distinct from old.source_published_at
     or new.source_time_confidence is distinct from old.source_time_confidence or new.first_seen_at is distinct from old.first_seen_at
     or new.payload_hash is distinct from old.payload_hash or new.title is distinct from old.title or new.summary is distinct from old.summary then
    raise exception 'intelligence.events: source time, first_seen_at, payload and content are immutable (D8, D64)';
  end if;
  return new;
end $$;
create trigger events_guard before update on intelligence.events for each row execute function intelligence.events_guard_update();
create trigger events_no_delete before delete on intelligence.events for each row execute function core.forbid_delete();

-- §6.7 intelligence.wallets: labels are evidence with provenance; OWNED addresses are excluded from flow features (D26).
create table intelligence.wallets (
  address core.solana_address primary key,
  discovery_source text not null,
  labels jsonb not null default '[]'::jsonb,
  is_owned boolean not null default false,
  pnl_usd jsonb not null default '{"d7":null,"d30":null,"d90":null}'::jsonb,
  win_rate core.fraction,
  trade_count integer check (trade_count >= 0),
  first_seen_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create trigger wallets_touch before update on intelligence.wallets for each row execute function core.touch_updated_at();
create index wallets_owned_idx on intelligence.wallets (is_owned) where is_owned;

-- Owned-address registry (D26, §8.6): every application-controlled address, with its custody role.
create table intelligence.owned_addresses (
  address core.solana_address primary key,
  purpose text not null,
  registered_at timestamptz not null default now(),
  retired_at timestamptz
);

-- §6.8 signals.feature_snapshots: immutable feature vector at decision time (bridge to replay).
create table signals.feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  as_of timestamptz not null,
  feature_engine_version core.version_id not null,
  provenance enums.data_provenance not null,
  market_snapshot_id uuid references market.snapshots (id),
  features jsonb not null,
  regime enums.market_regime,
  market_sessions enums.market_session[] not null default '{}',
  self_influence_suppressed boolean not null default false,
  created_at timestamptz not null default now()
);
create index feature_snapshots_asset_idx on signals.feature_snapshots (asset_id, as_of desc);
create trigger feature_snapshots_immutable before update or delete on signals.feature_snapshots for each row execute function core.forbid_update();

-- §6.9 signals.candidates
create table signals.candidates (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references core.assets (id),
  discovered_at timestamptz not null,
  trigger_family enums.trigger_family not null,
  trigger_details jsonb not null default '{}'::jsonb,
  scanner_score double precision not null check (scanner_score between 0 and 100),
  status enums.candidate_status not null default 'DETECTED',
  feature_snapshot_id uuid not null references signals.feature_snapshots (id),
  eligibility_evaluation_id uuid not null references core.asset_eligibility (id),
  expires_at timestamptz not null,
  deterministic_rejection_reason core.reason_code,
  dedupe_key text not null check (length(dedupe_key) between 1 and 128),
  strategy_version_ids core.version_id[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger candidates_touch before update on signals.candidates for each row execute function core.touch_updated_at();
create index candidates_open_idx on signals.candidates (status, expires_at) where status in ('DETECTED', 'ENRICHING', 'AGENT_REVIEW');
create index candidates_dedupe_idx on signals.candidates (asset_id, dedupe_key, discovered_at desc);
