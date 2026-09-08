-- ADR-0009 P2: a CLEARED action cycle points at the hash-chained audit event that recorded its clearance
-- (proposal hash, cutoff, verdict, Release digest, lot). The state projector carries the ledger head and the
-- risk-authorizer verifies the event and the chain against the external checkpoint before it signs, so a
-- database-only attacker cannot fabricate proposer/adversary clearance.
alter table agents.action_cycles
  add column cleared_audit_sequence bigint references audit.events (sequence),
  add column cleared_audit_hash core.sha256_hex,
  add constraint cleared_audit_pair check ((cleared_audit_sequence is null) = (cleared_audit_hash is null));
create index action_cycles_cleared_audit_idx on agents.action_cycles (cleared_audit_sequence) where cleared_audit_sequence is not null;
