import { QueueName } from '@sol-agent-trader/contracts';
import { PGMQ_QUEUE_NAMES, QUEUE_DRAIN_ORDER, pgmqQueueName } from './queues.js';

describe('pgmq queue mapping (§5.4)', () => {
  it('maps every contract queue to a valid pgmq identifier', () => {
    for (const q of QueueName.options) {
      expect(pgmqQueueName(q)).toMatch(/^[a-z][a-z0-9_]{0,46}$/);
    }
    expect(new Set(Object.values(PGMQ_QUEUE_NAMES)).size).toBe(QueueName.options.length);
  });

  it('drains risk-first and covers every queue exactly once', () => {
    expect(QUEUE_DRAIN_ORDER[0]).toBe('trade-critical');
    expect(QUEUE_DRAIN_ORDER[QUEUE_DRAIN_ORDER.length - 1]).toBe('research');
    expect([...QUEUE_DRAIN_ORDER].sort()).toEqual([...QueueName.options].sort());
  });
});
