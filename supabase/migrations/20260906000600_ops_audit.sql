-- §6.17A, §6.16B, §6.16D, §6.22A, §6.22: funding events, spend budgets, notifications,
-- runtime sessions, control requests, hash-chained audit ledger.

-- §6.17A ops.wallet_funding_events: audit/reconciliation record only; never authority.
create table ops.wallet_funding_events (
  id uuid primary key default gen_random_uuid(),
  operator_user_id uuid not null references auth.users (id),
  source_wallet core.solana_address not null,
  destination_trading_wallet core.solana_address not null,
  destination_ata core.solana_address,
  funding_mint core.solana_address not null,
  requested_amount core.amount not null,
  cluster enums.solana_cluster not null,
  state enums.funding_event_state not null default 'PREPARED',
  tx_signature core.tx_signature,
  confirmed_deltas jsonb,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failure_reason text,
  updated_at timestamptz not null default now(),
  -- CONFIRMED comes only from chain reconciliation (service role), which records the deltas
  constraint confirmed_has_evidence check (state <> 'CONFIRMED' or (tx_signature is not null and confirmed_deltas is not null and confirmed_at is not null))
);
create trigger wallet_funding_events_touch before update on ops.wallet_funding_events for each row execute function core.touch_updated_at();

-- §6.16B ops.spend_budgets / spend_usage (D43)
create table ops.spend_budgets (
  id uuid primary key default gen_random_uuid(),
  version_id core.version_id not null,
  scope text not null check (scope in ('PLATFORM', 'STRATEGY', 'PROVIDER')),
  scope_id text,
  limits jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (scope, scope_id, version_id)
);

create table ops.spend_usage (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references ops.spend_budgets (id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  cycles integer not null default 0 check (cycles >= 0),
  model_usd double precision not null default 0 check (model_usd >= 0),
  provider_requests integer not null default 0 check (provider_requests >= 0),
  state text not null default 'OK' check (state in ('OK', 'BUDGET_PAUSED')),
  updated_at timestamptz not null default now(),
  unique (budget_id, window_start)
);
create trigger spend_usage_touch before update on ops.spend_usage for each row execute function core.touch_updated_at();

-- §6.16D ops.notifications / notification_deliveries (D42, §20.20)
create table ops.notifications (
  id uuid primary key default gen_random_uuid(),
  severity enums.alert_severity not null,
  alert_class text not null check (length(alert_class) between 1 and 64),
  summary text not null check (length(summary) between 1 and 512),
  affected jsonb not null default '{}'::jsonb,
  raised_at timestamptz not null default now(),
  automated_response text,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id),
  resolved_at timestamptz,
  escalation_level smallint not null default 0 check (escalation_level >= 0),
  dead_man_deadline timestamptz,
  dead_man_action_taken text check (dead_man_action_taken in ('PAUSE_NEW_ENTRIES')),
  updated_at timestamptz not null default now()
);
create trigger notifications_touch before update on ops.notifications for each row execute function core.touch_updated_at();
create index notifications_open_idx on ops.notifications (severity, raised_at desc) where resolved_at is null;

create table ops.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references ops.notifications (id),
  channel enums.notification_channel not null,
  attempted_at timestamptz not null default now(),
  confirmed_at timestamptz,
  error text
);
create index notification_deliveries_idx on ops.notification_deliveries (notification_id);

-- §6.22A ops.runtime_sessions (D60, D61, D63)
create table ops.runtime_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references trading.accounts (id),
  profile enums.deployment_profile not null,
  activity_state enums.activity_state not null default 'OFF',
  capital_authority enums.capital_authority not null default 'OBSERVE',
  paused jsonb not null default '{"active":false,"reason":null,"since":null,"by":null}'::jsonb,
  attended boolean not null default true,
  last_presence_heartbeat_at timestamptz,
  scheduled_start_at timestamptz,
  intended_end_at timestamptz,
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  market_sessions enums.market_session[] not null default '{}',
  regime enums.market_regime,
  event_window jsonb,
  cold_start_gates jsonb not null default '[]'::jsonb,
  exposure_at_last_transition jsonb not null default '{"managedCount":0,"offlineProtectedCount":0,"unmanagedCount":0,"unmanagedUsd":null}'::jsonb,
  wind_down_blockers text[] not null default '{}',
  in_flight_execution_ids uuid[] not null default '{}',
  offline_resume_deadline timestamptz,
  resume_watchdog jsonb not null default '{"expectedCheckAt":null,"lastCheckAt":null,"status":"NOT_REQUIRED"}'::jsonb,
  transitions jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- D61: OFF with unmanaged exposure is invalid
  constraint off_has_no_unmanaged_exposure check (activity_state <> 'OFF' or (exposure_at_last_transition->>'unmanagedCount')::integer = 0)
);
create trigger runtime_sessions_touch before update on ops.runtime_sessions for each row execute function core.touch_updated_at();
create index runtime_sessions_active_idx on ops.runtime_sessions (activity_state) where activity_state <> 'OFF';

-- Deployment-profile registry mirrored from config so the UI can show which checks each profile
-- requires (D65, ADR-0002). Source of truth is config/profiles in the repo; this is a projection.
create table ops.deployment_profiles (
  profile enums.deployment_profile primary key,
  description text not null,
  required_checks text[] not null default '{}',
  physical_isolation boolean not null,
  live_capital_allowed boolean not null,
  updated_at timestamptz not null default now()
);

-- Browser write surface (§20.23, §23.3): the only table an authenticated operator may INSERT into.
-- The worker (service role) validates each request against role, step-up and state, then acts.
create table ops.control_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users (id) default auth.uid(),
  kind enums.control_request_kind not null,
  payload jsonb not null default '{}'::jsonb,
  step_up_assertion_ref text,
  state enums.control_request_state not null default 'PENDING',
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index control_requests_pending_idx on ops.control_requests (state, created_at) where state = 'PENDING';

-- Provider health projection for System Health (§20.19)
create table ops.provider_health (
  provider text primary key,
  state enums.provider_health not null,
  last_success_at timestamptz,
  latency_ms integer check (latency_ms >= 0),
  freshness_age_ms integer check (freshness_age_ms >= 0),
  rate_limit_state text,
  effect_on_entries text,
  effect_on_exits text,
  last_error text,
  updated_at timestamptz not null default now()
);

-- Worker heartbeats / leases (P0 acceptance: workers recover leases)
create table ops.worker_leases (
  role text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- §6.22 audit.events: append-only, hash-chained; checkpoints replicated outside Postgres (§20.25)
create sequence audit.events_sequence;

create table audit.events (
  id uuid primary key default gen_random_uuid(),
  sequence bigint not null unique default nextval('audit.events_sequence'),
  at timestamptz not null default now(),
  actor enums.actor_kind not null,
  actor_ref text not null check (length(actor_ref) between 1 and 256),
  action_class text not null check (length(action_class) between 1 and 64),
  entity jsonb not null,
  before_summary jsonb,
  after_summary jsonb,
  authority_evidence text,
  origin enums.audit_origin not null default 'NORMAL',
  live_impacting boolean not null default false,
  previous_hash core.sha256_hex not null,
  hash core.sha256_hex not null,
  original_local_at timestamptz,
  imported_at timestamptz
);

create or replace function audit.chain_event()
returns trigger language plpgsql as $$
declare
  prev core.sha256_hex;
  body text;
begin
  -- serialize chain writers so the chain is linear
  perform pg_advisory_xact_lock(hashtext('audit.events'));
  select e.hash into prev from audit.events e order by e.sequence desc limit 1;
  if prev is null then
    prev := repeat('0', 64);
  end if;
  new.sequence := nextval('audit.events_sequence');
  new.previous_hash := prev;
  body := (to_jsonb(new) - 'hash' - 'previous_hash')::text;
  new.hash := encode(extensions.digest(convert_to(prev || body, 'utf8'), 'sha256'), 'hex');
  return new;
end $$;
create trigger audit_events_chain before insert on audit.events for each row execute function audit.chain_event();
create trigger audit_events_immutable before update or delete on audit.events for each row execute function core.forbid_update();

create table audit.checkpoints (
  sequence bigint primary key references audit.events (sequence),
  hash core.sha256_hex not null,
  checkpointed_at timestamptz not null default now(),
  replicated_to text[] not null default '{}'
);

-- Verifies the chain from the genesis row; used by the Audit Log screen and readiness.
create or replace function audit.verify_chain()
returns table (ok boolean, checked bigint, first_bad_sequence bigint)
language plpgsql stable as $$
declare
  r record;
  prev core.sha256_hex := repeat('0', 64);
  expected core.sha256_hex;
  n bigint := 0;
begin
  for r in select * from audit.events e order by e.sequence loop
    expected := encode(extensions.digest(convert_to(prev || (to_jsonb(r) - 'hash' - 'previous_hash')::text, 'utf8'), 'sha256'), 'hex');
    if r.previous_hash <> prev or r.hash <> expected then
      return query select false, n, r.sequence;
      return;
    end if;
    prev := r.hash;
    n := n + 1;
  end loop;
  return query select true, n, null::bigint;
end $$;
