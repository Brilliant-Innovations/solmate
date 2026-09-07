-- pgTAP: provider spend accumulates atomically per provider and month (§21.1, D43).
begin;
select plan(6);

select is(ops.charge_provider_spend('BIRDEYE', '2026-09', '/defi/ohlcv', 45), 45::bigint, 'first charge creates the month row');
select is(ops.charge_provider_spend('BIRDEYE', '2026-09', '/defi/ohlcv', 45), 90::bigint, 'second charge accumulates');
select is(ops.charge_provider_spend('BIRDEYE', '2026-09', '/defi/token_overview', 15), 105::bigint, 'another endpoint adds to the total');
select is((select by_endpoint from ops.provider_spend where provider = 'BIRDEYE' and month = '2026-09'), '{"/defi/ohlcv": 90, "/defi/token_overview": 15}'::jsonb, 'per-endpoint breakdown kept');
select is(ops.charge_provider_spend('BIRDEYE', '2026-10', '/defi/ohlcv', 1), 1::bigint, 'a new month starts from zero');

set local role authenticated;
select throws_ok($$select ops.charge_provider_spend('BIRDEYE', '2026-09', '/x', 1)$$, '42501', null, 'authenticated cannot charge spend');
reset role;

select * from finish();
rollback;
