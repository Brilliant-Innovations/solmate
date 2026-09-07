-- pgTAP: a custody mismatch pauses running sessions atomically with the report (D9, §13.6); history is append-only.
begin;
select plan(11);

insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'paper-recon', 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
insert into ops.runtime_sessions (id, account_id, profile, activity_state, capital_authority, exposure_at_last_transition)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'P1A', 'ACTIVE', 'PAPER', '{"managedCount":0,"offlineProtectedCount":0,"unmanagedCount":0,"unmanagedUsd":null}'),
       ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4', null, 'P0', 'OFF', 'OBSERVE', '{"managedCount":0,"offlineProtectedCount":0,"unmanagedCount":0,"unmanagedUsd":null}');

create temp table rep as select $${
  "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd3", "accountId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "evaluatedAt": "2026-09-07T18:00:00.000Z",
  "policyVersion": "reconciliation-v1", "chainSlot": 500, "status": "CLEAN", "reasons": [], "balances": [], "unexpectedTokenAccounts": [],
  "unparsedSignatures": [], "movementSource": "HELIUS",
  "cursor": {"lastSignature": "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW", "lastSlot": 500, "solLamports": "1000000000"},
  "pauseTriggered": false, "movements": []
}$$::jsonb as j;

-- 1-3: a clean report lands, advances the cursor and raises nothing
select is(trading.record_reconciliation((select j from rep)), 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3'::uuid, 'clean report recorded');
select is((select sol_lamports::text from trading.reconciliation_cursors where account_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'), '1000000000', 'cursor advanced');
select is((select count(*)::int from ops.notifications where alert_class = 'CUSTODY_RECONCILIATION_MISMATCH'), 0, 'no notification for a clean report');

-- 4-8: a mismatch with an unknown movement pauses the running session, notifies CRITICAL, audits, stores the movement
select lives_ok($$select trading.record_reconciliation((select j || $j${"id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd4", "status": "MISMATCH", "pauseTriggered": true,
  "reasons": ["UNKNOWN_MOVEMENT"], "evaluatedAt": "2026-09-07T18:01:00.000Z",
  "movements": [{"signature": "4EWYrAvnHDA4ZgNGUgqdGsJ5DNKk4bT5hyGTLnRGT3GStpDDNXEWNq9vEaSZmiqPHJ5j6zDAZ3G1XFRa7wDbBqyz", "index": 0, "slot": 501, "blockTime": "2026-09-07T18:00:30.000Z",
    "kind": "TOKEN", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "fromOwner": "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS", "toOwner": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "fromTokenAccount": null, "toTokenAccount": "DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ", "amount": "1", "decimals": 6, "summaryType": "transfer", "failed": false,
    "classification": "UNKNOWN", "reason": "NO_LIFECYCLE", "lifecycleId": null}]}$j$::jsonb from rep))$$, 'mismatch report recorded');
select is((select (paused ->> 'active')::boolean from ops.runtime_sessions where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'), true, 'running session paused');
select is((select paused ->> 'by' from ops.runtime_sessions where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'), 'WORKER', 'paused by the worker');
select is((select count(*)::int from ops.notifications where alert_class = 'CUSTODY_RECONCILIATION_MISMATCH' and severity = 'CRITICAL'), 1, 'CRITICAL notification raised');
select is((select count(*)::int from audit.events where action_class = 'RUNTIME_PAUSE' and entity ->> 'id' = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'), 1, 'pause audited');

-- 9: a second mismatch does not re-pause an already paused session (no duplicate audit row)
select trading.record_reconciliation((select j || '{"id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd5", "status": "MISMATCH", "pauseTriggered": true, "reasons": ["BALANCE_MISMATCH"], "evaluatedAt": "2026-09-07T18:02:00.000Z"}'::jsonb from rep));
select is((select count(*)::int from audit.events where action_class = 'RUNTIME_PAUSE' and entity ->> 'id' = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'), 1, 'already-paused session is not re-paused');

-- 10: history is immutable
select throws_ok($$update trading.custody_movements set classification = 'EXPECTED'$$, 'P0001', null, 'movements are immutable');

-- 11: the browser role cannot call the recorder
set local role authenticated;
select throws_ok($$select trading.record_reconciliation('{}'::jsonb)$$, '42501', null, 'authenticated cannot record reconciliations');
reset role;

select * from finish();
rollback;
