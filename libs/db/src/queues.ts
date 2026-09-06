import type { QueueName } from '@sol-agent-trader/contracts';

/**
 * pgmq queue naming (blueprint §5.4). pgmq identifiers cannot contain hyphens, so the contract
 * queue names map to underscore names. Drain order is fixed and risk-first: a permanently busy
 * critical queue starves research, never the other way round.
 */
export const PGMQ_QUEUE_NAMES: Readonly<Record<QueueName, string>> = {
  'trade-critical': 'trade_critical',
  reconciliation: 'reconciliation',
  'trading-actions': 'trading_actions',
  research: 'research',
};

export const QUEUE_DRAIN_ORDER: readonly QueueName[] = ['trade-critical', 'reconciliation', 'trading-actions', 'research'];

export function pgmqQueueName(queue: QueueName): string {
  return PGMQ_QUEUE_NAMES[queue];
}
