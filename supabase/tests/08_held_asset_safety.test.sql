-- pgTAP: held-asset safety evaluations are append-only and move the position pointer atomically (§7.5, D34).
begin;
select plan(7);

insert into core.assets (id, mint_address, symbol, name, decimals, token_program, first_observed_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP', 'Jupiter', 6, 'TOKEN', now());
insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'paper', 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
insert into trading.positions (id, account_id, asset_id, mint, quantity, review_state_since, opened_at)
values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', '1000000', now(), now());

create temp table ev as select $${
  "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd2", "positionId": "cccccccc-cccc-4ccc-8ccc-ccccccccccc2", "assetId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "evaluatedAt": "2026-09-07T16:00:00.000Z", "policyVersion": "safety-v1", "state": "DEGRADED", "previousState": "NORMAL",
  "reasons": ["EMERGENCY_ROUTE_MISSING"], "triggers": ["PERIODIC"],
  "exitCompatibility": {"primaryRouteAvailable": true, "primaryImpactBps": 40, "emergencyRouteAvailable": false, "emergencySnapshotAgeMs": null, "token2022Compatible": true, "canReduceNow": true},
  "positionQuantity": "1000000", "chainSlot": 445000000, "liquidityUsd": 100000,
  "observed": {"freezeAuthorityPresent": false, "transferHook": false, "permanentDelegate": false, "transferFeeBps": null, "liquidityUsd": 100000, "top10": 0.2, "emergencyPoolAddress": null},
  "baseline": {"source": "ENTRY_ELIGIBILITY", "freezeAuthorityPresent": false, "transferHook": false, "permanentDelegate": false, "transferFeeBps": null, "liquidityUsd": 120000, "top10": 0.18, "emergencyPoolAddress": null}
}$$::jsonb as j;

select is((select safety_state from trading.positions where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'), 'NORMAL', 'a new position starts NORMAL');
select is((select trading.record_position_safety((select j from ev))), 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'the evaluation is recorded and its id returned');
select is((select safety_state from trading.positions where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'), 'DEGRADED', 'the position pointer moved with the evaluation');
select is((select reasons::text[] from trading.position_safety_evaluations where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'), '{EMERGENCY_ROUTE_MISSING}', 'reasons stored as reason codes');
select throws_ok(
  $$ update trading.position_safety_evaluations set state = 'NORMAL' where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2' $$,
  null, null, 'evaluations are immutable');

update trading.positions set status = 'CLOSED', closed_at = now() where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
select throws_ok(
  $$ select trading.record_position_safety((select jsonb_set(j, '{id}', '"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2"') from ev)) $$,
  'P0001', null, 'a closed position cannot receive a safety evaluation');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}', true);
select throws_ok($$ select trading.record_position_safety('{}'::jsonb) $$, '42501', null, 'the browser role cannot record safety evaluations');
reset role;

select * from finish();
rollback;
