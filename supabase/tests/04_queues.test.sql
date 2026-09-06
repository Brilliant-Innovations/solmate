-- pgTAP: the four durable pgmq queues exist, are logged, and support send/read/archive (§5.4).
begin;
select plan(8);

select ok((select count(*) from pgmq.list_queues() where queue_name in ('trade_critical', 'reconciliation', 'trading_actions', 'research')) = 4, 'all four queues exist');
select ok((select bool_and(not is_unlogged) from pgmq.list_queues() where queue_name in ('trade_critical', 'reconciliation', 'trading_actions', 'research')), 'no trading queue is unlogged');

select ok((select pgmq.send('trade_critical', '{"kind":"test","idempotencyKey":"k1"}'::jsonb)) > 0, 'send returns a message id');
select is((select count(*) from pgmq.read('trade_critical', 30, 10))::int, 1, 'read returns the message with a visibility timeout');
select is((select count(*) from pgmq.read('trade_critical', 30, 10))::int, 0, 'the message is invisible while leased');

select ok((select pgmq.archive('trade_critical', (select msg_id from pgmq.q_trade_critical limit 1))), 'archive moves the message to the archive table');
select is((select count(*) from pgmq.q_trade_critical)::int, 0, 'queue is empty after archive');
select is((select count(*) from pgmq.a_trade_critical)::int, 1, 'archive holds the message (durable record)');

select * from finish();
rollback;
