-- §6.11–6.20, §6.14A, §6.16C: proposals, risk evaluations, intents, authorizations, projections,
-- approvals, sleeves, lots, custody, orders, attempts, fills, positions, portfolio snapshots,
-- position shadow journal. Rows here are an operational ledger, never execution authority (D21).

create table trading.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  cluster enums.solana_cluster not null,
  trading_wallet core.solana_address not null,
  settlement_mint core.solana_address not null,
  created_at timestamptz not null default now()
);

-- §6.17 trading.custody_accounts
create table trading.custody_accounts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  kind enums.custody_kind not null,
  address core.solana_address not null,
  owner_provider text not null,
  mint core.solana_address,
  allowed_movement_types enums.transaction_class[] not null default '{}',
  active_from timestamptz not null,
  active_to timestamptz,
  verification_state text not null check (verification_state in ('VERIFIED', 'PENDING', 'REVOKED')),
  unique (account_id, address)
);

-- §6.16 trading.strategy_sleeves
create table trading.strategy_sleeves (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  version_id core.version_id not null,
  settlement_mint core.solana_address not null,
  capital_cap_base_units core.amount not null,
  risk_budget_base_units core.amount not null,
  committed_base_units core.amount not null default 0,
  risk_used_base_units core.amount not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (account_id, strategy_version_id, version_id)
);

-- §6.11 trading.proposals: immutable proposer artifact referenced by the cycle
create table trading.proposals (
  id uuid primary key default gen_random_uuid(),
  action_cycle_id uuid not null references agents.action_cycles (id),
  candidate_id uuid references signals.candidates (id),
  position_id uuid,
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  source enums.proposal_source not null,
  proposal jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index proposals_cycle_idx on trading.proposals (action_cycle_id);
create trigger proposals_immutable before update or delete on trading.proposals for each row execute function core.forbid_update();

-- §6.12 trading.risk_evaluations: immutable deterministic decision
create table trading.risk_evaluations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references trading.proposals (id),
  action_cycle_id uuid not null references agents.action_cycles (id),
  policy_version core.version_id not null,
  allowed boolean not null,
  reason_codes core.reason_code[] not null default '{}',
  settlement_mint core.solana_address not null,
  equity_base_units core.amount not null,
  equity_usd double precision check (equity_usd >= 0),
  exposure_base_units core.amount not null,
  cohort_exposure jsonb not null default '{}'::jsonb,
  cluster_exposure jsonb not null default '{}'::jsonb,
  sleeve_exposure core.fraction,
  asset_eligibility_evaluation_id uuid references core.asset_eligibility (id),
  computed_max_loss_base_units core.amount,
  computed_position_amount core.amount,
  max_slippage_bps core.bps not null,
  max_price_impact_bps core.bps not null,
  stop_policy jsonb,
  target_policy jsonb,
  daily_drawdown_fraction core.fraction not null,
  circuit_breaker_tripped boolean not null,
  stale_data_checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create trigger risk_evaluations_immutable before update or delete on trading.risk_evaluations for each row execute function core.forbid_update();

-- §6.13 trading.intents: immutable; idempotency key unique forever (D12, INV-04)
create table trading.intents (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 128),
  account_id uuid not null references trading.accounts (id),
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  sleeve_id uuid references trading.strategy_sleeves (id),
  asset_id uuid not null references core.assets (id),
  action enums.intent_action not null,
  side enums.trade_side not null,
  exposure_effect enums.exposure_effect not null,
  input_mint core.solana_address not null,
  output_mint core.solana_address not null,
  max_input_amount core.amount not null,
  risk_evaluation_id uuid not null references trading.risk_evaluations (id),
  action_cycle_id uuid not null references agents.action_cycles (id),
  cleared_cutoff_version integer not null check (cleared_cutoff_version > 0),
  constraints jsonb not null,
  protection_policy_ref core.version_id,
  target_lot_ids uuid[] not null default '{}',
  approval_required boolean not null,
  lifecycle_state text not null default 'CREATED' check (lifecycle_state in ('CREATED', 'AUTHORIZED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create trigger intents_touch before update on trading.intents for each row execute function core.touch_updated_at();
-- Everything but lifecycle_state/updated_at is immutable after insert.
create or replace function trading.intents_guard_update()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(old) - 'lifecycle_state' - 'updated_at') <> (to_jsonb(new) - 'lifecycle_state' - 'updated_at') then
    raise exception 'trading.intents: authorized fields are immutable; create a new intent (D21)';
  end if;
  return new;
end $$;
create trigger intents_guard before update on trading.intents for each row execute function trading.intents_guard_update();
create trigger intents_no_delete before delete on trading.intents for each row execute function core.forbid_delete();
alter table agents.action_cycles add constraint action_cycles_intent_fk foreign key (intent_id) references trading.intents (id);
alter table agents.action_cycles add constraint action_cycles_risk_evaluation_fk foreign key (risk_evaluation_id) references trading.risk_evaluations (id);

-- §6.14A risk.state_projections: append-only signed inputs to authorization (D52)
create table risk.state_projections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  sequence bigint not null check (sequence >= 0),
  envelope jsonb not null,
  payload_hash core.sha256_hex not null,
  key_id core.key_id not null,
  as_of timestamptz not null,
  chain_slot bigint not null check (chain_slot >= 0),
  created_at timestamptz not null default now(),
  unique (account_id, sequence)
);
create trigger state_projections_immutable before update or delete on risk.state_projections for each row execute function core.forbid_update();

-- §6.14 trading.risk_authorizations: the stored signed envelope; executor verifies, never trusts the row
create table trading.risk_authorizations (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references trading.intents (id),
  authorization_hash core.sha256_hex not null unique,
  envelope jsonb not null,
  key_id core.key_id not null,
  nonce core.nonce not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index risk_authorizations_intent_idx on trading.risk_authorizations (intent_id);
create trigger risk_authorizations_immutable before update or delete on trading.risk_authorizations for each row execute function core.forbid_update();

-- §6.15 trading.approvals: short-lived, bound to the exact authorization hash
create table trading.approvals (
  id uuid primary key default gen_random_uuid(),
  authorization_hash core.sha256_hex not null references trading.risk_authorizations (authorization_hash),
  intent_id uuid not null references trading.intents (id),
  approver_id uuid not null references auth.users (id),
  role enums.operator_role not null check (role in ('operator', 'admin')),
  step_up_assertion_ref text,
  granted_at timestamptz not null,
  expires_at timestamptz not null,
  nonce core.nonce not null unique,
  envelope jsonb not null,
  revoked_at timestamptz
);
create index approvals_hash_idx on trading.approvals (authorization_hash);
create or replace function trading.approvals_guard_update()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(old) - 'revoked_at') <> (to_jsonb(new) - 'revoked_at') then
    raise exception 'trading.approvals: only revoked_at may change (§15.6)';
  end if;
  return new;
end $$;
create trigger approvals_guard before update on trading.approvals for each row execute function trading.approvals_guard_update();
create trigger approvals_no_delete before delete on trading.approvals for each row execute function core.forbid_delete();

-- §6.19 trading.positions and §6.16 position_lots
create table trading.positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  asset_id uuid not null references core.assets (id),
  mint core.solana_address not null,
  quantity core.amount not null default 0,
  average_entry_price double precision check (average_entry_price >= 0),
  cost_basis_base_units core.amount not null default 0,
  realized_pnl_base_units core.signed_amount not null default 0,
  unrealized_pnl_base_units core.signed_amount,
  stop jsonb,
  target jsonb,
  unreviewed_stop double precision check (unreviewed_stop >= 0),
  custody_split jsonb not null default '[]'::jsonb,
  status enums.position_status not null default 'OPEN',
  review_state enums.position_review_state not null default 'REVIEWED',
  review_state_reason enums.unresolved_reason,
  review_state_since timestamptz not null,
  last_reviewed_cycle_id uuid references agents.action_cycles (id),
  next_reassessment_at timestamptz,
  safety_state enums.position_safety_state not null default 'NORMAL',
  opened_at timestamptz not null,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint review_reason_iff_not_reviewed check ((review_state = 'REVIEWED') = (review_state_reason is null))
);
create trigger positions_touch before update on trading.positions for each row execute function core.touch_updated_at();
create index positions_open_idx on trading.positions (account_id, status) where status <> 'CLOSED';
alter table agents.action_cycles add constraint action_cycles_position_fk foreign key (position_id) references trading.positions (id);
alter table agents.runs add constraint runs_position_fk foreign key (position_id) references trading.positions (id);
alter table trading.proposals add constraint proposals_position_fk foreign key (position_id) references trading.positions (id);

create table trading.position_lots (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references trading.positions (id),
  sleeve_id uuid not null references trading.strategy_sleeves (id),
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  asset_id uuid not null references core.assets (id),
  mint core.solana_address not null,
  quantity core.amount not null,
  cost_basis_base_units core.amount not null,
  entry_intent_id uuid not null references trading.intents (id),
  entry_fill_ids uuid[] not null default '{}',
  exit_fill_ids uuid[] not null default '{}',
  realized_pnl_base_units core.signed_amount not null default 0,
  protection_mode enums.protection_mode not null,
  provider_order_id text,
  reserved_for_protection core.amount not null default 0,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  opened_at timestamptz not null,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint reserve_within_quantity check (reserved_for_protection <= quantity)
);
create trigger position_lots_touch before update on trading.position_lots for each row execute function core.touch_updated_at();
create index position_lots_position_idx on trading.position_lots (position_id) where status = 'OPEN';

-- §6.18 orders, attempts, fills
create table trading.orders (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references trading.intents (id),
  authorization_hash core.sha256_hex references trading.risk_authorizations (authorization_hash),
  execution_path enums.execution_path not null,
  transaction_class enums.transaction_class not null,
  created_at timestamptz not null default now()
);

create table trading.order_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references trading.orders (id),
  intent_id uuid not null references trading.intents (id),
  authorization_hash core.sha256_hex references trading.risk_authorizations (authorization_hash),
  attempt_number smallint not null check (attempt_number > 0),
  state enums.order_attempt_state not null default 'PREPARED',
  jupiter_request_id text,
  router text,
  signed_tx_hash core.sha256_hex,
  wallet_signature core.tx_signature,
  expected_tx_signature core.tx_signature,
  blockhash text,
  last_valid_block_height bigint check (last_valid_block_height >= 0),
  quote_expires_at timestamptz,
  signed_at timestamptz,
  submitted_at timestamptz,
  submissions jsonb not null default '[]'::jsonb,
  landed_without_submission_record boolean not null default false,
  confirmed_at timestamptz,
  confirmed_slot bigint check (confirmed_slot >= 0),
  finalized_at timestamptz,
  finalized_slot bigint check (finalized_slot >= 0),
  reorg_detected_at timestamptz,
  not_landed_reason text,
  reconciliation_outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, attempt_number),
  -- D12 / §6.18: a signed attempt is identifiable before submission
  constraint submitted_implies_signed check (state in ('PREPARED') or signed_tx_hash is not null),
  constraint finalized_has_slot check (state <> 'FINALIZED' or finalized_slot is not null)
);
create trigger order_attempts_touch before update on trading.order_attempts for each row execute function core.touch_updated_at();
create index order_attempts_inflight_idx on trading.order_attempts (state) where state in ('SIGNED_NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED_PROVISIONAL', 'REORG_PENDING');
create trigger order_attempts_no_delete before delete on trading.order_attempts for each row execute function core.forbid_delete();

create table trading.fills (
  id uuid primary key default gen_random_uuid(),
  order_attempt_id uuid not null references trading.order_attempts (id),
  tx_signature core.tx_signature not null,
  commitment enums.chain_commitment not null check (commitment <> 'processed'),
  slot bigint not null check (slot >= 0),
  input_mint core.solana_address not null,
  output_mint core.solana_address not null,
  input_amount core.amount not null,
  output_amount core.amount not null,
  fees jsonb not null,
  execution_shortfall_bps double precision,
  execution_path enums.execution_path not null,
  lot_allocations jsonb not null default '[]'::jsonb,
  filled_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tx_signature, commitment)
);
create trigger fills_immutable before update or delete on trading.fills for each row execute function core.forbid_update();

-- §6.20 trading.portfolio_snapshots
create table trading.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  as_of timestamptz not null,
  settlement_mint core.solana_address not null,
  equity_base_units core.amount not null,
  equity_usd double precision check (equity_usd >= 0),
  exposure_base_units core.amount not null,
  exposure_fraction core.fraction not null,
  per_sleeve jsonb not null default '[]'::jsonb,
  per_cohort jsonb not null default '[]'::jsonb,
  drawdown jsonb not null,
  created_at timestamptz not null default now()
);
create index portfolio_snapshots_idx on trading.portfolio_snapshots (account_id, as_of desc);
create trigger portfolio_snapshots_immutable before update or delete on trading.portfolio_snapshots for each row execute function core.forbid_update();

-- §6.16C trading.position_shadow_journal: durable mirror of the executor/worker shadow
create table trading.position_shadow_journal (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  sequence bigint not null check (sequence >= 0),
  hash core.sha256_hex not null,
  shadow jsonb not null,
  created_at timestamptz not null default now(),
  synchronized_at timestamptz,
  unique (account_id, sequence)
);
create trigger position_shadow_journal_no_delete before delete on trading.position_shadow_journal for each row execute function core.forbid_delete();
