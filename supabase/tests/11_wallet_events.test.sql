-- pgTAP: tracked-wallet events are idempotent, append-only and never come from owned wallets (§6.7, D8, D26).
begin;
select plan(9);

insert into intelligence.wallets (address, discovery_source, labels, is_owned, first_seen_at)
values ('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', 'MANUAL', '[]', false, now()),
       ('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'CUSTODY', '[]', true, now());

create temp table ev as select $$[{
  "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd7", "signature": "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
  "movementIndex": 1, "slot": 501, "blockTime": "2026-09-07T17:00:00.000Z", "kind": "BUY", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "amount": "5000000", "decimals": 6, "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "quoteAmount": "250000000",
  "counterparty": "DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ", "source": "HELIUS_POLL", "firstSeenAt": "2026-09-07T18:00:00.000Z",
  "payloadHash": "0000000000000000000000000000000000000000000000000000000000000001"
}]$$::jsonb as j;
create temp table cur as select '{"lastSignature": "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW", "lastSlot": 501}'::jsonb as j;

select is(intelligence.ingest_wallet_events('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', (select j from ev), (select j from cur)), 1, 'first ingest inserts');
select is(intelligence.ingest_wallet_events('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', (select j from ev), (select j from cur)), 0, 'a retry inserts nothing');
select is((select count(*)::int from intelligence.wallet_events where wallet = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'), 1, 'one event stored');
select is((select last_slot from intelligence.wallet_cursors where wallet = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'), 501::bigint, 'cursor advanced');
select throws_ok($$select intelligence.ingest_wallet_events('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '[]'::jsonb, null)$$, 'P0001', null, 'owned wallet refused (D26)');
select throws_ok($$select intelligence.ingest_wallet_events('DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ', '[]'::jsonb, null)$$, 'P0001', null, 'untracked wallet refused');
-- INV-11 in the database: a trading wallet registered as tracked with is_owned=false is still owned.
insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'paper-owned', 'mainnet-beta', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
insert into intelligence.wallets (address, discovery_source, labels, is_owned, first_seen_at) values ('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'SCORER', '[]', false, now());
select throws_ok($$select intelligence.ingest_wallet_events('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', '[]'::jsonb, null)$$, 'P0001', null, 'a trading wallet is owned whatever the row says (D26)');
select throws_ok($$update intelligence.wallet_events set kind = 'SELL'$$, 'P0001', null, 'events are immutable');

set local role authenticated;
select throws_ok($$select intelligence.ingest_wallet_events('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', '[]'::jsonb, null)$$, '42501', null, 'authenticated cannot ingest');
reset role;

select * from finish();
rollback;
