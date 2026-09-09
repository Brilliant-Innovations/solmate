-- §18.5 reproducibility record and P9 replay results. A run names everything that shaped its
-- decisions (versions, cutoff, seed, model disclosures); its decisions and closed trades are
-- stored row by row (§18.5: model outputs are the record) and digested. Completed and failed runs
-- are immutable; nothing here is ever deleted.
create table research.replay_runs (
  id uuid primary key,
  name text not null check (length(name) between 1 and 120),
  fidelity text not null check (fidelity in ('A_HISTORICAL', 'B_CAPTURED', 'C_LIVE_PAPER')),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  requested_by uuid references auth.users (id),
  control_request_id uuid references ops.control_requests (id),
  window_from timestamptz not null,
  window_to timestamptz not null,
  dataset_cutoff timestamptz not null,
  in_sample_until timestamptz,
  strategy_version_ids core.version_id[] not null check (cardinality(strategy_version_ids) >= 1),
  baseline_strategy_version_id core.version_id not null,
  versions jsonb not null,
  models jsonb not null default '[]'::jsonb,
  seed integer not null default 0 check (seed >= 0),
  latency_matched_baseline boolean not null default true,
  proposer_only_shadow boolean not null default true,
  calibration_target jsonb not null,
  asset_ids uuid[],
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  decisions_digest core.sha256_hex,
  results_digest core.sha256_hex,
  results jsonb,
  error text,
  constraint window_order check (window_from < window_to and dataset_cutoff >= window_to and (in_sample_until is null or (in_sample_until > window_from and in_sample_until < window_to))),
  constraint completed_has_digests check (status <> 'COMPLETED' or (decisions_digest is not null and results_digest is not null and results is not null and completed_at is not null)),
  constraint failed_has_error check (status <> 'FAILED' or error is not null)
);
create index replay_runs_status_idx on research.replay_runs (status, created_at);

create or replace function research.replay_runs_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('COMPLETED', 'FAILED') then
    raise exception 'replay run % is % and immutable', old.id, old.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger replay_runs_immutable_when_done before update on research.replay_runs for each row execute function research.replay_runs_guard();
create trigger replay_runs_never_deleted before delete on research.replay_runs for each row execute function core.forbid_update();

create table research.replay_decisions (
  id uuid primary key,
  run_id uuid not null references research.replay_runs (id),
  strategy_version_id core.version_id not null,
  variant text not null check (variant in ('FULL', 'PROPOSER_ONLY', 'LATENCY_MATCHED')),
  at timestamptz not null,
  candidate_id uuid not null,
  asset_id uuid not null references core.assets (id),
  sample text not null check (sample in ('IN_SAMPLE', 'HOLD_OUT')),
  cycle_state enums.action_cycle_state not null,
  action enums.trading_action_type,
  proposer_confidence core.fraction,
  adversary_verdict enums.adversary_verdict,
  reason_codes text[] not null default '{}',
  decision_latency_ms integer not null check (decision_latency_ms >= 0),
  rejection text,
  fill jsonb,
  outcome jsonb
);
create index replay_decisions_run_idx on research.replay_decisions (run_id, strategy_version_id, variant, at);
create trigger replay_decisions_immutable before update or delete on research.replay_decisions for each row execute function core.forbid_update();

create table research.replay_trades (
  id uuid primary key,
  run_id uuid not null references research.replay_runs (id),
  strategy_version_id core.version_id not null,
  variant text not null check (variant in ('FULL', 'PROPOSER_ONLY', 'LATENCY_MATCHED')),
  sample text not null check (sample in ('IN_SAMPLE', 'HOLD_OUT')),
  asset_id uuid not null references core.assets (id),
  candidate_id uuid,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  cost double precision not null check (cost >= 0),
  proceeds double precision not null check (proceeds >= 0),
  fees double precision not null check (fees >= 0),
  slippage_cost double precision not null check (slippage_cost >= 0),
  execution_shortfall_bps double precision,
  execution_path enums.execution_path not null,
  exit_reason text not null,
  decision_to_fill_ms integer,
  attributes jsonb not null default '{}'::jsonb,
  constraint trade_order check (opened_at <= closed_at)
);
create index replay_trades_run_idx on research.replay_trades (run_id, strategy_version_id, variant);
create trigger replay_trades_immutable before update or delete on research.replay_trades for each row execute function core.forbid_update();

alter table research.replay_runs enable row level security;
alter table research.replay_runs force row level security;
alter table research.replay_decisions enable row level security;
alter table research.replay_decisions force row level security;
alter table research.replay_trades enable row level security;
alter table research.replay_trades force row level security;
grant select on research.replay_runs, research.replay_decisions, research.replay_trades to authenticated;
create policy operators_read on research.replay_runs for select to authenticated using (ops.has_role('viewer'));
create policy operators_read on research.replay_decisions for select to authenticated using (ops.has_role('viewer'));
create policy operators_read on research.replay_trades for select to authenticated using (ops.has_role('viewer'));
