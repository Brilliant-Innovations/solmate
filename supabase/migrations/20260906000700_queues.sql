-- §5.4 durable queues on pgmq. Priority is separate FIFO queues drained in this fixed order by the
-- worker: trade_critical, reconciliation, trading_actions, research. All are logged (durable);
-- unlogged queues are forbidden for trading work. pgmq identifiers cannot contain hyphens, so the
-- contract QueueName ('trade-critical', ...) maps to these names by replacing '-' with '_'
-- (libs/db). The pgmq schema is never exposed through the API (§5.3).

select pgmq.create('trade_critical');
select pgmq.create('reconciliation');
select pgmq.create('trading_actions');
select pgmq.create('research');

-- Only backend service roles may touch queues; nothing for anon/authenticated.
revoke all on schema pgmq from anon, authenticated;
revoke all on all tables in schema pgmq from anon, authenticated;
revoke all on all functions in schema pgmq from anon, authenticated;
