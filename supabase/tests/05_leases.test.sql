-- pgTAP: worker leases are exclusive, renewable by the holder, and recoverable after expiry.
begin;
select plan(7);

select ok(ops.acquire_lease('ingest', 'worker-a', 30), 'worker-a acquires a free lease');
select ok(not ops.acquire_lease('ingest', 'worker-b', 30), 'worker-b cannot take a live lease');
select ok(ops.heartbeat_lease('ingest', 'worker-a', 30), 'the holder can heartbeat');
select ok(not ops.heartbeat_lease('ingest', 'worker-b', 30), 'a non-holder cannot heartbeat');

-- simulate worker-a dying: its lease expires
update ops.worker_leases set expires_at = now() - interval '1 second' where role = 'ingest';
select ok(not ops.heartbeat_lease('ingest', 'worker-a', 30), 'an expired lease cannot be heartbeated back to life');
select ok(ops.acquire_lease('ingest', 'worker-b', 30), 'worker-b recovers the expired lease');
select is((select holder from ops.worker_leases where role = 'ingest'), 'worker-b', 'the lease now belongs to worker-b');

select * from finish();
rollback;
