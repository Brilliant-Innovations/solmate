-- §21.2B / §21.2C / D61: a sticky entry pause that outlives sessions (the next STARTING honours it), watchdog
-- telemetry, and the request-shaped session-resume watchdog the web cron calls. The watchdog never trades or
-- signs: it raises CRITICAL, persists PAUSE_NEW_ENTRIES and audits what it did.

create table ops.entry_pauses (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (length(reason) between 1 and 128),
  set_by enums.actor_kind not null,
  set_by_ref text not null check (length(set_by_ref) between 1 and 256),
  set_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references auth.users (id),
  cleared_by_ref text,
  constraint cleared_pair check ((cleared_at is null) = (cleared_by_ref is null))
);
create index entry_pauses_active_idx on ops.entry_pauses (set_at desc) where cleared_at is null;
alter table ops.entry_pauses enable row level security;
alter table ops.entry_pauses force row level security;
grant select on ops.entry_pauses to authenticated;
create policy operators_read on ops.entry_pauses for select to authenticated using (ops.has_role('viewer'));

create table ops.watchdog_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  source text not null default 'CRON' check (length(source) between 1 and 64),
  findings jsonb not null default '{}'::jsonb
);
create index watchdog_runs_latest_idx on ops.watchdog_runs (ran_at desc);
alter table ops.watchdog_runs enable row level security;
alter table ops.watchdog_runs force row level security;
grant select on ops.watchdog_runs to authenticated;
create policy operators_read on ops.watchdog_runs for select to authenticated using (ops.has_role('viewer'));

-- The watchdog tick. Fact-based and idempotent: calling it any number of times changes nothing unless a resume
-- is overdue or the runtime heartbeat is missing, so exposing it to the anon role behind the cron route is safe.
create or replace function ops.session_resume_watchdog(p_heartbeat_missing_after interval default interval '5 minutes')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_overdue integer := 0;
  v_missing integer := 0;
  v_paused integer := 0;
  v_resolved integer := 0;
  v_id uuid;
  r record;
begin
  -- 1. Overdue resume: an OFF session that carried offline-protected lots past its deadline.
  for r in
    select id, offline_resume_deadline from ops.runtime_sessions
    where activity_state = 'OFF' and offline_resume_deadline is not null and offline_resume_deadline < v_now
      and coalesce((exposure_at_last_transition ->> 'offlineProtectedCount')::integer, 0) > 0
  loop
    v_overdue := v_overdue + 1;
    if not exists (select 1 from ops.notifications where alert_class = 'OFFLINE_RESUME_OVERDUE' and resolved_at is null and affected ->> 'sessionId' = r.id::text) then
      insert into ops.notifications (severity, alert_class, summary, affected, automated_response)
      values ('CRITICAL', 'OFFLINE_RESUME_OVERDUE',
        format('Offline-protected lots required a resume by %s; the runtime is still OFF', to_char(r.offline_resume_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        jsonb_build_object('assetId', null, 'strategyVersionId', null, 'positionId', null, 'system', 'session-resume-watchdog', 'sessionId', r.id), 'PAUSE_NEW_ENTRIES');
    end if;
    if not exists (select 1 from ops.entry_pauses where cleared_at is null and reason = 'OFFLINE_RESUME_OVERDUE') then
      insert into ops.entry_pauses (reason, set_by, set_by_ref) values ('OFFLINE_RESUME_OVERDUE', 'WATCHDOG', 'session-resume-watchdog');
      insert into audit.events (actor, actor_ref, action_class, entity, after_summary, origin, live_impacting)
      values ('WATCHDOG', 'session-resume-watchdog', 'ENTRY_PAUSE_PERSISTED', jsonb_build_object('type', 'runtime_session', 'id', r.id),
        jsonb_build_object('reason', 'OFFLINE_RESUME_OVERDUE', 'deadline', r.offline_resume_deadline), 'WATCHDOG', true);
      v_paused := v_paused + 1;
    end if;
    update ops.runtime_sessions set resume_watchdog = jsonb_build_object('expectedCheckAt', null, 'lastCheckAt', v_now, 'status', 'OVERDUE') where id = r.id;
  end loop;

  -- 2. Missing runtime heartbeat while a session is not OFF.
  if exists (select 1 from ops.runtime_sessions where activity_state <> 'OFF')
     and not exists (select 1 from ops.worker_leases where role = 'session' and heartbeat_at > v_now - p_heartbeat_missing_after) then
    v_missing := 1;
    if not exists (select 1 from ops.notifications where alert_class = 'RUNTIME_HEARTBEAT_MISSING' and resolved_at is null) then
      insert into ops.notifications (severity, alert_class, summary, affected, automated_response)
      values ('CRITICAL', 'RUNTIME_HEARTBEAT_MISSING',
        format('A runtime session is not OFF but the worker session heartbeat is older than %s', p_heartbeat_missing_after::text),
        jsonb_build_object('assetId', null, 'strategyVersionId', null, 'positionId', null, 'system', 'session-resume-watchdog'), 'PAUSE_NEW_ENTRIES');
    end if;
    if not exists (select 1 from ops.entry_pauses where cleared_at is null and reason = 'RUNTIME_HEARTBEAT_MISSING') then
      insert into ops.entry_pauses (reason, set_by, set_by_ref) values ('RUNTIME_HEARTBEAT_MISSING', 'WATCHDOG', 'session-resume-watchdog');
      insert into audit.events (actor, actor_ref, action_class, entity, after_summary, origin, live_impacting)
      values ('WATCHDOG', 'session-resume-watchdog', 'ENTRY_PAUSE_PERSISTED', jsonb_build_object('type', 'worker_lease', 'id', 'session'),
        jsonb_build_object('reason', 'RUNTIME_HEARTBEAT_MISSING', 'missingAfter', p_heartbeat_missing_after::text), 'WATCHDOG', true);
      v_paused := v_paused + 1;
    end if;
  else
    -- heartbeat present again: the alert resolves; the sticky pause stays until an operator clears it with step-up
    update ops.notifications set resolved_at = v_now where alert_class = 'RUNTIME_HEARTBEAT_MISSING' and resolved_at is null;
    get diagnostics v_resolved = row_count;
  end if;

  update ops.runtime_sessions
    set resume_watchdog = jsonb_set(coalesce(resume_watchdog, '{}'::jsonb), '{lastCheckAt}', to_jsonb(v_now))
    where activity_state <> 'OFF' or offline_resume_deadline is not null;

  insert into ops.watchdog_runs (ran_at, findings)
  values (v_now, jsonb_build_object('overdue', v_overdue, 'heartbeatMissing', v_missing, 'pausesPersisted', v_paused, 'resolved', v_resolved))
  returning id into v_id;
  return jsonb_build_object('runId', v_id, 'ranAt', v_now, 'overdue', v_overdue, 'heartbeatMissing', v_missing, 'pausesPersisted', v_paused, 'resolved', v_resolved);
end
$$;
revoke all on function ops.session_resume_watchdog(interval) from public;
grant execute on function ops.session_resume_watchdog(interval) to anon, authenticated;
