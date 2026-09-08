-- pgTAP: an intelligence event keeps its two clocks and content (§6.6, §10.3, D64); only last_seen_at advances.
begin;
select plan(6);

insert into intelligence.events (id, kind, source_provider, source_id, source_published_at, source_time_confidence, first_seen_at, last_seen_at, title, source_quality, payload_hash)
values ('99999999-9999-4999-8999-999999999911', 'NEWS', 'TEST', 'story-1', '2026-09-08T10:00:00Z', 'HIGH', '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z', 'Protocol ships upgrade', 'REPUTABLE_PUBLICATION', repeat('a', 64));

select lives_ok(
  $$ update intelligence.events set last_seen_at = '2026-09-08T13:00:00Z' where id = '99999999-9999-4999-8999-999999999911' $$,
  'last_seen_at may advance');
select throws_ok(
  $$ update intelligence.events set last_seen_at = '2026-09-08T11:00:00Z' where id = '99999999-9999-4999-8999-999999999911' $$,
  'P0001', null, 'last_seen_at cannot move backwards');
select throws_ok(
  $$ update intelligence.events set first_seen_at = '2026-09-08T09:00:00Z' where id = '99999999-9999-4999-8999-999999999911' $$,
  'P0001', null, 'first_seen_at never changes (replay truth)');
select throws_ok(
  $$ update intelligence.events set source_published_at = '2026-09-08T12:30:00Z' where id = '99999999-9999-4999-8999-999999999911' $$,
  'P0001', null, 'source time never changes (catalyst age)');
select throws_ok(
  $$ update intelligence.events set title = 'Revised headline' where id = '99999999-9999-4999-8999-999999999911' $$,
  'P0001', null, 'content is what was known at the time');
select throws_ok(
  $$ delete from intelligence.events where id = '99999999-9999-4999-8999-999999999911' $$,
  'P0001', null, 'an event cannot be deleted');

select * from finish();
rollback;
