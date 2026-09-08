-- M5a: Level B capture (blueprint §18.1 "contemporaneous quote probes", §17.1–17.2, D48). Every quote a
-- decision or an execution actually used is written once, with the time it was taken and the ledger
-- object it served, so a captured-market replay can reproduce the executable expectation of the moment
-- instead of reconstructing it from candles. Rows are immutable; they are evidence, never authority.
create table market.quote_probes (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references core.assets (id),
  provider text not null check (provider in ('JUPITER', 'DIRECT_POOL')),
  /** Why the quote was taken: the risk reference at entry, the paper adapter's decision and executable quotes, the exit mark. */
  purpose text not null check (purpose in ('ENTRY_REFERENCE', 'DECISION', 'EXECUTABLE', 'EXIT_MARK')),
  input_mint core.solana_address not null,
  output_mint core.solana_address not null,
  input_amount core.amount not null,
  expected_output_amount core.amount not null,
  min_output_amount core.amount not null,
  price_impact_bps core.bps,
  slippage_bps core.bps not null,
  router_label text,
  route_program_ids core.solana_address[] not null default '{}',
  uses_address_lookup_tables boolean not null default false,
  quoted_at timestamptz not null,
  observed_at timestamptz not null default now(),
  action_cycle_id uuid references agents.action_cycles (id),
  intent_id uuid references trading.intents (id),
  position_id uuid references trading.positions (id),
  order_attempt_id uuid references trading.order_attempts (id)
);
create index quote_probes_asset_idx on market.quote_probes (asset_id, quoted_at desc);
create index quote_probes_cycle_idx on market.quote_probes (action_cycle_id) where action_cycle_id is not null;
create index quote_probes_position_idx on market.quote_probes (position_id, quoted_at desc) where position_id is not null;
create trigger quote_probes_immutable before update or delete on market.quote_probes for each row execute function core.forbid_update();

alter table market.quote_probes enable row level security;
alter table market.quote_probes force row level security;
grant select on market.quote_probes to authenticated;
create policy operators_read on market.quote_probes for select to authenticated using (ops.has_role('viewer'));
