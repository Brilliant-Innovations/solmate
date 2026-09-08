-- pgTAP: every dashboard-schema table has an operator read policy, and browser writes stay confined to the ops
-- control surface (§23.2, §23.3).
begin;
select plan(4);

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('core', 'market', 'intelligence', 'signals', 'agents', 'trading', 'risk', 'research', 'ops', 'audit')
      and not exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname and p.cmd = 'SELECT' and 'authenticated' = any(p.roles))),
  0, 'no dashboard-schema table is unreadable to operators');
select ok(
  (select count(*) from pg_policies where schemaname = 'ops' and tablename = 'readiness_verdicts' and cmd = 'SELECT') = 1,
  'readiness verdicts are readable');
select is(
  (select count(*)::int from pg_policies where cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any(roles)
    and schemaname in ('core', 'market', 'intelligence', 'signals', 'agents', 'trading', 'risk', 'research', 'audit')),
  0, 'the browser writes nothing outside the ops schema');
select ok(
  exists (select 1 from pg_policies where schemaname = 'ops' and tablename = 'control_requests' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  'control requests remain the browser write surface');

select * from finish();
rollback;
