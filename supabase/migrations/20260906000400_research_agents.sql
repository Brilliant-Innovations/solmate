-- §6.21, §6.16A, §6.10–6.10D: strategy versions, releases, attestations, agent runs, skills, tools,
-- automations, action cycles, adversarial reviews.

-- §6.21 research.strategy_versions (D7 immutable; only status/active_to may change)
create table research.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id enums.strategy_id not null,
  version_id core.version_id not null unique,
  variant text not null check (length(variant) between 1 and 32),
  git_sha text not null check (git_sha ~ '^[0-9a-f]{7,40}$'),
  feature_version core.version_id not null,
  prompt_versions jsonb not null default '{}'::jsonb,
  model_selections jsonb not null default '{}'::jsonb,
  thresholds jsonb not null default '{}'::jsonb,
  risk_policy_version core.version_id not null,
  skill_version_id core.version_id,
  guideline_version_id core.version_id,
  automation_set_version_id core.version_id,
  speed_tier enums.speed_tier not null,
  max_decision_latency_ms integer not null check (max_decision_latency_ms >= 0),
  max_candidate_age_ms integer not null check (max_candidate_age_ms >= 0),
  max_quote_age_ms integer not null check (max_quote_age_ms >= 0),
  chase_tolerance_bps core.bps not null,
  allowed_action_types enums.trading_action_type[] not null,
  reassessment_policy jsonb not null default '{}'::jsonb,
  adversary_policy jsonb not null,
  session_rules jsonb not null,
  regime_conditions jsonb not null default '{}'::jsonb,
  outside_window_behavior text not null check (outside_window_behavior in ('WATCH', 'NO_NEW_ENTRIES', 'RESEARCH_PAPER')),
  warmup jsonb not null,
  event_window_policy jsonb not null,
  offline_protection jsonb not null,
  attended_presence_required_profiles enums.deployment_profile[] not null default '{}',
  human_reaction_floor_ms integer not null check (human_reaction_floor_ms >= 0),
  live_intent_expiry_ms integer not null check (live_intent_expiry_ms >= 0),
  eligible_capital_authorities enums.capital_authority[] not null,
  status enums.strategy_status not null default 'EXPERIMENTAL',
  active_from timestamptz not null,
  active_to timestamptz,
  created_at timestamptz not null default now()
);

create or replace function research.versioned_artifact_guard()
returns trigger language plpgsql as $$
declare
  old_j jsonb := to_jsonb(old) - 'status' - 'active_to' - 'promoted_at' - 'retired_at' - 'effective_to' - 'last_fired_at' - 'next_eligible_at';
  new_j jsonb := to_jsonb(new) - 'status' - 'active_to' - 'promoted_at' - 'retired_at' - 'effective_to' - 'last_fired_at' - 'next_eligible_at';
begin
  if old_j <> new_j then
    raise exception '%.%: versioned artifacts are immutable; create a new version (D7, D38)', tg_table_schema, tg_table_name;
  end if;
  return new;
end $$;
create trigger strategy_versions_guard before update on research.strategy_versions for each row execute function research.versioned_artifact_guard();
create trigger strategy_versions_no_delete before delete on research.strategy_versions for each row execute function core.forbid_delete();

-- §6.16A research.releases: immutable binding tuple; digest = canonical hash of binding.
create table research.releases (
  id uuid primary key default gen_random_uuid(),
  digest core.sha256_hex not null unique,
  binding jsonb not null,
  status enums.release_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  retired_at timestamptz
);
create trigger releases_guard before update on research.releases for each row execute function research.versioned_artifact_guard();
create trigger releases_no_delete before delete on research.releases for each row execute function core.forbid_delete();

create table research.release_attestations (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references research.releases (id),
  release_digest core.sha256_hex not null,
  purpose text not null check (purpose in ('PROMOTE', 'ARM', 'RESUME')),
  operator_id uuid not null references auth.users (id),
  operator_role enums.operator_role not null check (operator_role = 'admin'),
  credential_id text not null check (length(credential_id) between 1 and 256),
  credential_fingerprint core.sha256_hex not null,
  challenge text not null check (length(challenge) between 16 and 512),
  verification_result boolean not null,
  attested_at timestamptz not null,
  expires_at timestamptz
);
create index release_attestations_release_idx on research.release_attestations (release_id, attested_at desc);
create trigger release_attestations_immutable before update or delete on research.release_attestations for each row execute function core.forbid_update();

-- §6.10A agents.skill_versions
create table agents.skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id text not null check (length(skill_id) between 1 and 64),
  version_id core.version_id not null unique,
  git_sha text not null check (git_sha ~ '^[0-9a-f]{7,40}$'),
  tool_manifest_version core.version_id not null,
  guideline_version core.version_id not null,
  supported_action_types enums.trading_action_type[] not null,
  workflow_graph_version core.version_id not null,
  context_builder_version core.version_id not null,
  proposer_model_policy_version core.version_id not null,
  adversary_policy_required boolean not null default true check (adversary_policy_required),
  status enums.skill_status not null default 'DRAFT',
  effective_from timestamptz not null,
  effective_to timestamptz
);
create trigger skill_versions_guard before update on agents.skill_versions for each row execute function research.versioned_artifact_guard();
create trigger skill_versions_no_delete before delete on agents.skill_versions for each row execute function core.forbid_delete();

-- §6.10C agents.automation_definitions (agents cannot create or alter live automations)
create table agents.automation_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 64),
  version_id core.version_id not null,
  trigger_family enums.automation_trigger_family not null,
  trigger_type text not null check (length(trigger_type) between 1 and 64),
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  skill_version_id core.version_id not null references agents.skill_versions (version_id),
  filter jsonb not null default '{}'::jsonb,
  min_interval_ms integer not null check (min_interval_ms >= 0),
  cooldown_ms integer not null check (cooldown_ms >= 0),
  priority smallint not null check (priority between 0 and 100),
  scope text not null check (scope in ('CANDIDATE', 'POSITION', 'SYSTEM')),
  enabled_modes enums.capital_authority[] not null,
  context_deadline_ms integer not null check (context_deadline_ms >= 0),
  enabled boolean not null default false,
  last_fired_at timestamptz,
  next_eligible_at timestamptz,
  unique (name, version_id)
);
create trigger automation_definitions_guard before update on agents.automation_definitions for each row execute function research.versioned_artifact_guard();

-- §6.10D agents.action_cycles (ADR-0001: canonical for the final action disposition)
create table agents.action_cycles (
  id uuid primary key default gen_random_uuid(),
  automation_run_id uuid,
  trigger_id uuid not null,
  candidate_id uuid references signals.candidates (id),
  position_id uuid,
  strategy_version_id core.version_id not null references research.strategy_versions (version_id),
  skill_version_id core.version_id references agents.skill_versions (version_id),
  guideline_version_id core.version_id,
  speed_tier enums.speed_tier not null,
  decision_budget_ms integer not null check (decision_budget_ms >= 0),
  proposed_action enums.trading_action_type,
  proposal_id uuid,
  proposer_run_ids uuid[] not null default '{}',
  adversary_run_ids uuid[] not null default '{}',
  verdict enums.adversary_verdict,
  reason_codes core.reason_code[] not null default '{}',
  revision_round smallint not null default 0 check (revision_round between 0 and 1),
  state enums.action_cycle_state not null default 'TRIGGERED',
  unresolved_reason enums.unresolved_reason,
  cutoffs jsonb not null,
  cleared_cutoff_version integer check (cleared_cutoff_version > 0),
  risk_evaluation_id uuid,
  intent_id uuid,
  started_at timestamptz not null,
  terminal_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint one_target check ((candidate_id is not null) <> (position_id is not null)),
  constraint unresolved_has_reason check ((state = 'UNRESOLVED') = (unresolved_reason is not null)),
  constraint cleared_has_cutoff check (state <> 'CLEARED' or cleared_cutoff_version is not null)
);
create trigger action_cycles_touch before update on agents.action_cycles for each row execute function core.touch_updated_at();
create index action_cycles_open_idx on agents.action_cycles (state, started_at) where state not in ('CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED');
create index action_cycles_position_idx on agents.action_cycles (position_id, started_at desc) where position_id is not null;
create index action_cycles_candidate_idx on agents.action_cycles (candidate_id) where candidate_id is not null;

-- §6.10 agents.runs: every model call, append-only
create table agents.runs (
  id uuid primary key default gen_random_uuid(),
  action_cycle_id uuid references agents.action_cycles (id),
  candidate_id uuid references signals.candidates (id),
  position_id uuid,
  role enums.agent_role not null,
  provider text not null,
  model text not null,
  prompt_version core.version_id not null,
  temperature double precision check (temperature between 0 and 2),
  reasoning_config jsonb,
  input_evidence_ids uuid[] not null default '{}',
  cutoff_version integer not null check (cutoff_version > 0),
  cutoff_at timestamptz not null,
  structured_output jsonb,
  tokens jsonb not null,
  cost_usd double precision not null check (cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  success boolean not null,
  schema_validation jsonb not null,
  created_at timestamptz not null default now()
);
create index runs_cycle_idx on agents.runs (action_cycle_id);
create trigger runs_immutable before update or delete on agents.runs for each row execute function core.forbid_update();

-- §6.10B agents.tool_invocations: append-only; the skill has no arbitrary HTTP/SQL/shell/wallet tool.
create table agents.tool_invocations (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agents.runs (id),
  action_cycle_id uuid not null references agents.action_cycles (id),
  tool_name text not null check (length(tool_name) between 1 and 64),
  tool_version core.version_id not null,
  classification enums.tool_classification not null,
  request_hash core.sha256_hex not null,
  response_refs text[] not null default '{}',
  cutoff_version integer not null check (cutoff_version > 0),
  latency_ms integer not null check (latency_ms >= 0),
  error text,
  created_at timestamptz not null default now()
);
create trigger tool_invocations_immutable before update or delete on agents.tool_invocations for each row execute function core.forbid_update();

-- §6.10C agents.automation_runs
create table agents.automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references agents.automation_definitions (id),
  automation_version_id core.version_id not null,
  trigger_event jsonb not null,
  cutoff_version integer check (cutoff_version > 0),
  cutoff_at timestamptz,
  skill_invocation_run_id uuid references agents.runs (id),
  action_cycle_id uuid references agents.action_cycles (id),
  disposition text not null check (disposition in ('INVOKED', 'SKIPPED_COOLDOWN', 'SKIPPED_BUDGET', 'SKIPPED_MODE', 'SKIPPED_ACTIVITY_STATE', 'ERROR')),
  created_at timestamptz not null default now()
);
alter table agents.action_cycles add constraint action_cycles_automation_run_fk foreign key (automation_run_id) references agents.automation_runs (id);

-- §6.10D agents.adversarial_reviews: append-only
create table agents.adversarial_reviews (
  id uuid primary key default gen_random_uuid(),
  action_cycle_id uuid not null references agents.action_cycles (id),
  agent_run_id uuid references agents.runs (id),
  deterministic_gate boolean not null,
  verdict enums.adversary_verdict not null,
  objections jsonb not null default '[]'::jsonb,
  confidence core.fraction,
  cutoff_version integer not null check (cutoff_version > 0),
  latency_ms integer not null check (latency_ms >= 0),
  blocking boolean not null,
  created_at timestamptz not null default now()
);
create index adversarial_reviews_cycle_idx on agents.adversarial_reviews (action_cycle_id);
create trigger adversarial_reviews_immutable before update or delete on agents.adversarial_reviews for each row execute function core.forbid_update();
