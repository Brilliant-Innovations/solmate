begin;
select plan(5);

insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint, mode)
values ('a0000000-0000-4000-8000-000000000001', 'paper-test', 'mainnet-beta', '7SwXimKb2KzW6H9nQ1YQm1qzrY2s5jZ7n3Vf8s2xY1aB', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'PAPER');
insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint)
values ('a0000000-0000-4000-8000-000000000002', 'live-test', 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

select is((select mode from trading.accounts where name = 'live-test'), 'LIVE', 'mode defaults to LIVE');
select is((select mode from trading.accounts where name = 'paper-test'), 'PAPER', 'a paper account records its mode');

select throws_ok(
  $$ insert into trading.custody_accounts (account_id, kind, address, owner_provider, active_from, verification_state)
     values ('a0000000-0000-4000-8000-000000000001', 'TRADING_WALLET', '7SwXimKb2KzW6H9nQ1YQm1qzrY2s5jZ7n3Vf8s2xY1aB', 'paper', now(), 'VERIFIED') $$,
  'P0001', null, 'a paper account cannot carry live custody rows');
select lives_ok(
  $$ insert into trading.custody_accounts (account_id, kind, address, owner_provider, active_from, verification_state)
     values ('a0000000-0000-4000-8000-000000000002', 'TRADING_WALLET', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'turnkey', now(), 'VERIFIED') $$,
  'a live account carries custody rows');
select throws_ok(
  $$ update trading.accounts set mode = 'LIVE' where name = 'paper-test' $$,
  'P0001', null, 'account mode is immutable');

select * from finish();
rollback;
