-- §20.25 / ADR-0009 P2: every verification of the audit ledger against its external checkpoint is
-- recorded, so the Audit Log screen shows the last verified checkpoint from a persisted fact rather
-- than a log line, and a failed verification stays visible until the next cycle verifies again.
create table audit.verifications (
  id uuid primary key default gen_random_uuid(),
  verified_at timestamptz not null default now(),
  ok boolean not null,
  head_sequence bigint check (head_sequence >= 0),
  checkpoint_sequence bigint check (checkpoint_sequence >= 0),
  checkpoint_hash core.sha256_hex,
  replica text not null check (length(replica) between 1 and 128),
  reason text check (reason is null or length(reason) <= 64),
  detail text check (detail is null or length(detail) <= 1024),
  constraint ok_has_checkpoint check (not ok or (checkpoint_sequence is not null and checkpoint_hash is not null)),
  constraint failed_has_reason check (ok or reason is not null)
);
create index audit_verifications_latest_idx on audit.verifications (verified_at desc);
alter table audit.verifications enable row level security;
alter table audit.verifications force row level security;
grant select on audit.verifications to authenticated;
create policy operators_read on audit.verifications for select to authenticated using (ops.has_role('viewer'));
create trigger audit_verifications_immutable before update or delete on audit.verifications for each row execute function core.forbid_update();

-- The chain check is a read the operator surface may run itself.
grant execute on function audit.verify_chain() to authenticated;
