-- pgTAP: a cycle's clearance pointer is a (sequence, hash) pair bound to the audit ledger (ADR-0009 P2).
-- Behaviour (a lone hash cannot be planted, a null sequence cannot detach a clearance) is exercised by
-- libs/db audit-clearance.integration.spec.ts; here the schema itself is asserted.
begin;
select plan(4);

select has_column('agents', 'action_cycles', 'cleared_audit_sequence', 'cycles carry the clearance sequence');
select has_column('agents', 'action_cycles', 'cleared_audit_hash', 'cycles carry the clearance hash');
select col_is_fk('agents', 'action_cycles', 'cleared_audit_sequence', 'the clearance sequence references audit.events');
select has_check('agents', 'action_cycles', 'action_cycles has check constraints (cleared_audit_pair among them)');

select * from finish();
rollback;
