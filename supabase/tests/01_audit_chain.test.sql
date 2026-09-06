-- pgTAP: audit.events is append-only and hash-chained; DB-only rewriting is detectable (§6.22, §20.25).
-- Scoped to the rows this test inserts so it passes on a database that already holds audit rows.
begin;
select plan(9);

create temp table before_test as select count(*) as n, coalesce(max(sequence), 0) as max_seq from audit.events;

insert into audit.events (actor, actor_ref, action_class, entity, live_impacting)
values ('OPERATOR', 'pgtap-operator', 'MODE_CHANGE', '{"type":"runtime_session","id":"s1"}', true);
insert into audit.events (actor, actor_ref, action_class, entity)
values ('WORKER', 'pgtap-worker', 'RECONCILIATION', '{"type":"account","id":"a1"}');

create temp table mine as
  select sequence, hash, previous_hash from audit.events where sequence > (select max_seq from before_test) order by sequence;

select is((select count(*) from mine)::int, 2, 'two audit rows inserted');
select ok(
  case when (select n from before_test) = 0
       then (select previous_hash::text from mine order by sequence limit 1) = repeat('0', 64)
       else (select previous_hash::text from mine order by sequence limit 1) = (select hash::text from audit.events where sequence = (select max_seq from before_test)) end,
  'first inserted row chains from the zero hash on an empty ledger, otherwise from the prior row');
select is(
  (select previous_hash::text from mine order by sequence desc limit 1),
  (select hash::text from mine order by sequence asc limit 1),
  'second row chains from the first row hash');
select ok((select ok from audit.verify_chain()), 'verify_chain passes on an intact chain');
select is((select checked from audit.verify_chain())::bigint, (select n + 2 from before_test), 'verify_chain counted every row including the two new ones');

select throws_ok(
  $$ update audit.events set action_class = 'TAMPERED' where sequence = (select min(sequence) from mine) $$,
  'P0001', 'rows in audit.events are immutable', 'updates are refused by trigger'
);
select throws_ok(
  $$ delete from audit.events where sequence in (select sequence from mine) $$,
  'P0001', 'rows in audit.events are immutable', 'deletes are refused by trigger'
);

-- Simulate a database-only attacker who can disable triggers: the chain must reveal the rewrite.
alter table audit.events disable trigger audit_events_immutable;
update audit.events set action_class = 'TAMPERED' where sequence = (select min(sequence) from mine);
alter table audit.events enable trigger audit_events_immutable;
select ok((select not ok from audit.verify_chain()), 'verify_chain detects a rewritten row');
select is((select first_bad_sequence from audit.verify_chain()), (select min(sequence) from mine), 'and reports the first bad sequence');

select * from finish();
rollback;
