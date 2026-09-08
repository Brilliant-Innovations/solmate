-- pgTAP: a capital attestation is append-only and needs a positive ceiling (D56).
begin;
select plan(3);

insert into auth.users (id, email) values ('99999999-9999-4999-8999-999999999931', 'cap-test@example.com') on conflict do nothing;
insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint, mode)
values ('99999999-9999-4999-8999-999999999932', 'cap-test', 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'PAPER');
insert into research.releases (id, digest, binding, status) values ('99999999-9999-4999-8999-999999999933', repeat('b', 64), '{}'::jsonb, 'DRAFT');
insert into research.release_attestations (id, release_id, release_digest, purpose, operator_id, operator_role, credential_id, credential_fingerprint, challenge, verification_result, attested_at)
values ('99999999-9999-4999-8999-999999999934', '99999999-9999-4999-8999-999999999933', repeat('b', 64), 'ARM', '99999999-9999-4999-8999-999999999931', 'admin', 'cred', repeat('c', 64), repeat('d', 43), true, now());

select lives_ok(
  $$ insert into ops.capital_attestations (account_id, release_id, attestation_id, ceiling_usd, attested_by, attested_at)
     values ('99999999-9999-4999-8999-999999999932', '99999999-9999-4999-8999-999999999933', '99999999-9999-4999-8999-999999999934', 250, '99999999-9999-4999-8999-999999999931', now()) $$,
  'a positive ceiling is recorded');
select throws_ok(
  $$ insert into ops.capital_attestations (account_id, release_id, attestation_id, ceiling_usd, attested_by, attested_at)
     values ('99999999-9999-4999-8999-999999999932', '99999999-9999-4999-8999-999999999933', '99999999-9999-4999-8999-999999999934', 0, '99999999-9999-4999-8999-999999999931', now()) $$,
  '23514', null, 'a zero ceiling is refused');
select throws_ok(
  $$ update ops.capital_attestations set ceiling_usd = 999999 where account_id = '99999999-9999-4999-8999-999999999932' $$,
  'P0001', null, 'a ceiling cannot be raised in place');

select * from finish();
rollback;
