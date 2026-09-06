-- §23.2 / §23.3 row-level security.
--
-- Model:
-- - Backend services connect with the service role, which bypasses RLS; that is the only way rows
--   are written, except the single browser write surface below.
-- - The browser is an authenticated Supabase user whose role comes from ops.operators. It may SELECT
--   what the dashboard needs and INSERT into ops.control_requests only. It can never write ledger,
--   policy, authorization or execution rows, and it never reaches the executor (D21, §20.23).
-- - Non-dashboard schemas are not exposed through PostgREST at all.

-- Expose only what the dashboard reads. Everything else stays internal to backend connections.
grant usage on schema core, market, intelligence, signals, agents, trading, risk, research, ops, audit, enums to authenticated;

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
  loop
    execute format('alter table %I.%I enable row level security', t.schema_name, t.table_name);
    execute format('alter table %I.%I force row level security', t.schema_name, t.table_name);
    execute format('grant select on %I.%I to authenticated', t.schema_name, t.table_name);
    execute format(
      'create policy operators_read on %I.%I for select to authenticated using (ops.has_role(''viewer''))',
      t.schema_name, t.table_name
    );
  end loop;
end $$;

-- The one browser write surface: control requests, by operator or admin, only as themselves.
grant insert on ops.control_requests to authenticated;
create policy operators_request_control on ops.control_requests
  for insert to authenticated
  with check (ops.has_role('operator') and requested_by = auth.uid());

-- Operators may read their own operator row even before role resolution (bootstrap).
create policy self_read on ops.operators for select to authenticated using (user_id = auth.uid());

-- Realtime Broadcast (§5.3, §20.23): operators may receive on private channels; only backend sends.
create policy operators_receive_broadcasts on realtime.messages
  for select to authenticated
  using (ops.has_role('viewer'));

-- anon gets nothing anywhere.
revoke all on all tables in schema core, market, intelligence, signals, agents, trading, risk, research, ops, audit from anon;
revoke usage on schema core, market, intelligence, signals, agents, trading, risk, research, ops, audit, enums from anon;

-- Deployment profile registry seed (ADR-0002; details are configuration, this is the UI projection)
insert into ops.deployment_profiles (profile, description, required_checks, physical_isolation, live_capital_allowed) values
  ('P0', 'Development/replay on a workstation; no live capital', '{contracts_digest,boundary_lint,invariant_map}', false, false),
  ('P1A', 'Attended PAPER, local or Vercel Sandbox', '{contracts_digest,boundary_lint,invariant_map,feeds_fresh,reconciliation_clean}', false, false),
  ('P1B', 'Unattended all-session PAPER on a cheap runtime', '{contracts_digest,boundary_lint,invariant_map,feeds_fresh,reconciliation_clean,restart_recovery}', false, false),
  ('P2', 'Tiny attended live; logical isolation; credentials in an isolated environment', '{ready_for_attended_tiny_live}', false, true),
  ('P3', 'Unattended live pilot on a persistent VM', '{ready_for_unattended_live_pilot}', false, true),
  ('P4', 'Hardened LIVE_AUTO on separate hosts', '{ready_for_hardened_live_auto}', true, true);
