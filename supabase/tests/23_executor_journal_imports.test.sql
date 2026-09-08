-- pgTAP: an executor-journal entry is imported at most once and keeps both its local and import time (§15.10, §20.25).
begin;
select plan(3);

insert into audit.events (actor, actor_ref, action_class, entity, after_summary, origin, live_impacting, original_local_at, imported_at)
values ('EXECUTOR', 'journal-import', 'EMERGENCY_COMMAND_RECEIVED', '{"type":"executor_journal","id":"7"}'::jsonb, '{"type":"EMERGENCY_CLOSE_ALL"}'::jsonb, 'EMERGENCY_JOURNAL_IMPORT', true, now() - interval '1 hour', now());

select lives_ok(
  $$ insert into ops.executor_journal_imports (journal_sequence, journal_hash, kind, correlation_id, payload, original_local_at, audit_sequence)
     values (7, repeat('a', 64), 'EMERGENCY_COMMAND_RECEIVED', 'cmd-1', '{"type":"EMERGENCY_CLOSE_ALL"}'::jsonb, now() - interval '1 hour', (select max(sequence) from audit.events)) $$,
  'an entry is imported with its audit row');
select throws_ok(
  $$ insert into ops.executor_journal_imports (journal_sequence, journal_hash, kind, correlation_id, payload, original_local_at, audit_sequence)
     values (7, repeat('a', 64), 'EMERGENCY_COMMAND_RECEIVED', 'cmd-1', '{}'::jsonb, now(), (select max(sequence) from audit.events)) $$,
  '23505', null, 'the same journal hash cannot be imported twice');
select throws_ok(
  $$ update ops.executor_journal_imports set kind = 'PAUSE_CLEARED' where journal_hash = repeat('a', 64) $$,
  'P0001', null, 'an import row is immutable');

select * from finish();
rollback;
