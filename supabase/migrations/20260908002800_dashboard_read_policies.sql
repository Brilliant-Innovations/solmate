-- §23.2 / §23.3: every dashboard-schema table an operator may read gets the same read policy the first RLS
-- migration applied to the tables that existed then. Tables created since (chain health, capital attestations,
-- readiness rows and verdicts, tool refusals, spend usage, …) carried RLS with no policy, which is safe but
-- invisible to the operator surface. Idempotent: a table that already has a select policy for `authenticated`
-- is left alone; the browser write surface stays ops.control_requests only.
do $$
declare
  t record;
begin
  for t in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('core', 'market', 'intelligence', 'signals', 'agents', 'trading', 'risk', 'research', 'ops', 'audit')
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = n.nspname and p.tablename = c.relname and p.cmd = 'SELECT' and 'authenticated' = any(p.roles)
      )
  loop
    execute format('alter table %I.%I enable row level security', t.schema_name, t.table_name);
    execute format('alter table %I.%I force row level security', t.schema_name, t.table_name);
    execute format('grant select on %I.%I to authenticated', t.schema_name, t.table_name);
    execute format('create policy operators_read on %I.%I for select to authenticated using (ops.has_role(''viewer''))', t.schema_name, t.table_name);
  end loop;
end $$;

revoke all on all tables in schema core, market, intelligence, signals, agents, trading, risk, research, ops, audit from anon;
