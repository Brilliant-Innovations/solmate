-- §14.7 / §40.3 chain health: what each independent RPC view said and the verdict the policy drew. Append-only
-- history; the newest row is what the worker mirrors into ops.provider_health ('SOLANA_CHAIN') so that halts,
-- stalled finality, divergence and an unreadable chain block new entries through the same gate as stale feeds.
create table ops.chain_health (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null,
  policy_version text not null,
  state text not null check (state in ('HEALTHY', 'LAGGING', 'STALLED', 'DIVERGENT', 'UNAVAILABLE')),
  views jsonb not null,
  head_slot bigint check (head_slot >= 0),
  slot_advanced boolean,
  confirmed_finalized_lag_slots integer,
  view_divergence_slots integer check (view_divergence_slots >= 0),
  effect_on_entries text not null check (effect_on_entries in ('NONE', 'BLOCK')),
  reasons text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- a blocking verdict always says why
  constraint block_has_reason check (effect_on_entries = 'NONE' or cardinality(reasons) > 0)
);
create index chain_health_latest_idx on ops.chain_health (observed_at desc);
create trigger chain_health_immutable before update or delete on ops.chain_health for each row execute function core.forbid_update();
alter table ops.chain_health enable row level security;
