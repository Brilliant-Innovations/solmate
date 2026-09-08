-- §29 / ADR-0004 / ADR-0010 §5: Live Readiness rows and verdicts, each bound to the deployment it was evaluated on.
-- Rows are append-only evidence (computed by the worker, recorded from CI, drills and probes); verdicts are
-- append-only snapshots the arming path consults. Nothing here is a checkbox: a row is only as good as its binding.
create table ops.readiness_rows (
  id uuid primary key default gen_random_uuid(),
  row_id text not null check (length(row_id) between 1 and 64),
  kind text not null check (kind in ('COMPUTED', 'CI_EVIDENCE', 'DRILL', 'PROBE')),
  verdict text not null check (verdict in ('PASS', 'FAIL', 'NOT_APPLICABLE', 'UNKNOWN')),
  strategy_class text not null check (strategy_class in ('DETERMINISTIC', 'LLM')),
  profile enums.deployment_profile not null,
  binding jsonb not null,
  detail jsonb not null default '{}'::jsonb,
  evidence_ref text check (length(evidence_ref) <= 512),
  recorded_by text not null check (length(recorded_by) between 1 and 128),
  evaluated_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index readiness_rows_latest_idx on ops.readiness_rows (profile, strategy_class, row_id, evaluated_at desc);
create trigger readiness_rows_immutable before update or delete on ops.readiness_rows for each row execute function core.forbid_update();
alter table ops.readiness_rows enable row level security;

create table ops.readiness_verdicts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name in ('READY_FOR_ATTENDED_TINY_LIVE', 'READY_FOR_UNATTENDED_LIVE_PILOT', 'READY_FOR_HARDENED_LIVE_AUTO')),
  profile enums.deployment_profile not null,
  strategy_class text not null check (strategy_class in ('DETERMINISTIC', 'LLM')),
  release_id uuid references research.releases (id),
  verdict text not null check (verdict in ('READY', 'NOT_READY')),
  rows jsonb not null,
  missing text[] not null default '{}',
  stale text[] not null default '{}',
  failed text[] not null default '{}',
  not_applicable text[] not null default '{}',
  enabled_capabilities text[] not null default '{}',
  binding jsonb not null,
  policy_version text not null,
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- a READY verdict names nothing missing, stale or failed
  constraint ready_is_clean check (verdict <> 'READY' or (cardinality(missing) = 0 and cardinality(stale) = 0 and cardinality(failed) = 0))
);
create index readiness_verdicts_latest_idx on ops.readiness_verdicts (profile, strategy_class, computed_at desc);
create trigger readiness_verdicts_immutable before update or delete on ops.readiness_verdicts for each row execute function core.forbid_update();
alter table ops.readiness_verdicts enable row level security;
