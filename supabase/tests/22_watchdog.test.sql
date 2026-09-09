-- pgTAP: the session-resume watchdog raises CRITICAL and persists a sticky entry pause for an overdue resume and a
-- missing runtime heartbeat, idempotently; a quiet database yields a run row and nothing else (§21.2C, D61).
begin;
select plan(8);

-- "Quiet" has to actually be quiet. A local worker run that was killed rather than stopped leaves
-- sessions behind in STARTING/ACTIVE, and the watchdog rightly reads those as missing runtimes: it
-- then persists a second RUNTIME_HEARTBEAT_MISSING pause, and the audit assertion below — which
-- counts every ENTRY_PAUSE_PERSISTED, not only this fixture's — sees 2. That is the watchdog working,
-- not failing, so the test isolates itself instead of loosening the assertion. Rolled back with the rest.
update ops.runtime_sessions set activity_state = 'OFF' where activity_state <> 'OFF';

-- quiet: nothing open, nothing overdue
select is((select (ops.session_resume_watchdog()) ->> 'overdue')::int, 0, 'a quiet database has no overdue resume');
select is((select count(*)::int from ops.watchdog_runs), 1, 'every tick leaves a telemetry row');

-- an OFF session that carried protected lots past its deadline
insert into ops.runtime_sessions (id, profile, activity_state, capital_authority, offline_resume_deadline, exposure_at_last_transition)
values ('99999999-9999-4999-8999-999999999961', 'P2', 'OFF', 'LIVE_APPROVAL', now() - interval '10 minutes',
  '{"managedCount":0,"offlineProtectedCount":1,"unmanagedCount":0,"unmanagedUsd":null}'::jsonb);
select is((select (ops.session_resume_watchdog()) ->> 'overdue')::int, 1, 'the overdue resume is detected');
select is((select count(*)::int from ops.notifications where alert_class = 'OFFLINE_RESUME_OVERDUE' and resolved_at is null), 1, 'one CRITICAL is raised');
select is((select count(*)::int from ops.entry_pauses where cleared_at is null and reason = 'OFFLINE_RESUME_OVERDUE'), 1, 'a sticky entry pause is persisted');
select is((select (ops.session_resume_watchdog()) ->> 'pausesPersisted')::int, 0, 'a second tick adds nothing');
select is((select count(*)::int from audit.events where action_class = 'ENTRY_PAUSE_PERSISTED' and origin = 'WATCHDOG'), 1, 'the pause is audited once');

-- a running session with no worker heartbeat
insert into ops.runtime_sessions (id, profile, activity_state, capital_authority)
values ('99999999-9999-4999-8999-999999999962', 'P1A', 'ACTIVE', 'PAPER');
select is((select (ops.session_resume_watchdog()) ->> 'heartbeatMissing')::int, 1, 'a running session without a session-lease heartbeat is a missing runtime');

select * from finish();
rollback;
