-- pgTAP: audit.events is append-only and hash-chained; DB-only rewriting is detectable (§6.22, §20.25).
begin;
select plan(9);

insert into audit.events (actor, actor_ref, action_class, entity, live_impacting)
values ('OPERATOR', 'test-operator', 'MODE_CHANGE', '{"type":"runtime_session","id":"s1"}', true);
insert into audit.events (actor, actor_ref, action_class, entity)
values ('WORKER', 'worker-1', 'RECONCILIATION', '{"type":"account","id":"a1"}');

select is((select count(*) from audit.events)::int, 2, 'two audit rows inserted');
select is((select previous_hash::text from audit.events order by sequence limit 1), repeat('0', 64), 'genesis row chains from the zero hash');
select is(
  (select e2.previous_hash::text from audit.events e2 order by e2.sequence desc limit 1),
  (select e1.hash::text from audit.events e1 order by e1.sequence asc limit 1),
  'second row chains from the first row hash'
);
select ok((select ok from audit.verify_chain()), 'verify_chain passes on an intact chain');
select is((select checked from audit.verify_chain())::int, 2, 'verify_chain counted both rows');

select throws_ok(
  $$ update audit.events set action_class = 'TAMPERED' where sequence = (select min(sequence) from audit.events) $$,
  'P0001', 'rows in audit.events are immutable', 'updates are refused by trigger'
);
select throws_ok(
  $$ delete from audit.events $$,
  'P0001', 'rows in audit.events are immutable', 'deletes are refused by trigger'
);

-- Simulate a database-only attacker who can disable triggers: the chain must reveal the rewrite.
alter table audit.events disable trigger audit_events_immutable;
update audit.events set action_class = 'TAMPERED' where sequence = (select min(sequence) from audit.events);
alter table audit.events enable trigger audit_events_immutable;
select ok((select not ok from audit.verify_chain()), 'verify_chain detects a rewritten row');
select is((select first_bad_sequence from audit.verify_chain()), (select min(sequence) from audit.events), 'and reports the first bad sequence');

select * from finish();
rollback;
