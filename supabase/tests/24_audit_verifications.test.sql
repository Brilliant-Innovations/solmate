-- pgTAP: audit verifications are immutable facts; a passing row names its checkpoint, a failing row names its reason (§20.25).
begin;
select plan(4);

select lives_ok(
  $$ insert into audit.verifications (ok, head_sequence, checkpoint_sequence, checkpoint_hash, replica) values (true, 10, 9, repeat('b', 64), 'file:checkpoints.jsonl') $$,
  'a verified checkpoint is recorded');
select throws_ok(
  $$ insert into audit.verifications (ok, head_sequence, replica) values (true, 10, 'file:checkpoints.jsonl') $$,
  '23514', null, 'a passing verification must name the checkpoint it verified against');
select throws_ok(
  $$ insert into audit.verifications (ok, head_sequence, replica) values (false, 10, 'file:checkpoints.jsonl') $$,
  '23514', null, 'a failing verification must carry a reason');
select throws_ok(
  $$ update audit.verifications set ok = false where replica = 'file:checkpoints.jsonl' $$,
  'P0001', null, 'a verification row is immutable');

select * from finish();
rollback;
