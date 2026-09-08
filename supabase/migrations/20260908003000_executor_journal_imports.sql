-- §15.10 / §20.25: executor-journal entries imported into the audit ledger once Postgres is back. Each journal
-- entry is imported at most once (its own hash is the key), keeps its original local time next to the import
-- time, and a DB-outage emergency action leaves a sticky entry pause an operator must clear with step-up.
create table ops.executor_journal_imports (
  id uuid primary key default gen_random_uuid(),
  journal_sequence bigint not null check (journal_sequence >= 0),
  journal_hash core.sha256_hex not null unique,
  kind text not null check (length(kind) between 1 and 64),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  payload jsonb not null,
  original_local_at timestamptz not null,
  imported_at timestamptz not null default now(),
  audit_sequence bigint not null references audit.events (sequence)
);
create index executor_journal_imports_seq_idx on ops.executor_journal_imports (journal_sequence desc);
create index executor_journal_imports_kind_idx on ops.executor_journal_imports (kind, correlation_id);
alter table ops.executor_journal_imports enable row level security;
alter table ops.executor_journal_imports force row level security;
grant select on ops.executor_journal_imports to authenticated;
create policy operators_read on ops.executor_journal_imports for select to authenticated using (ops.has_role('viewer'));
create trigger executor_journal_imports_immutable before update or delete on ops.executor_journal_imports for each row execute function core.forbid_update();
