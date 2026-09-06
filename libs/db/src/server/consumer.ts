import type { Clock, QueueName, Sha256Hex } from '@sol-agent-trader/contracts';
import type { PgmqClient } from './queue-client.js';
import { processMessage, type MessageHandler, type ProcessingOutcome, type ProcessingPolicy } from './processing.js';
import { planDrainCycle, type DrainConfig, type DrainState } from './scheduler.js';
import type { Sql } from './sql.js';

/**
 * One drain cycle over the four queues in scheduler order (blueprint §5.4). Handlers are keyed by
 * message kind; an unknown kind is dead-lettered by the processor via a throwing handler.
 */
export interface ConsumerOptions {
  sql: Sql;
  client: PgmqClient;
  handlers: Readonly<Record<string, MessageHandler>>;
  holder: string;
  expectedContractSetDigest: Sha256Hex;
  clock: Clock;
  leaseSeconds: number;
  policy?: ProcessingPolicy;
  drain?: DrainConfig;
}

export interface DrainCycleResult {
  state: DrainState;
  backlog: Set<QueueName>;
  outcomes: { queue: QueueName; outcome: ProcessingOutcome }[];
}

export async function drainOnce(opts: ConsumerOptions, state: DrainState, previousBacklog: ReadonlySet<QueueName>, isFenced: () => boolean): Promise<DrainCycleResult> {
  const { plan, state: next } = planDrainCycle(state, previousBacklog, opts.drain);
  const backlog = new Set<QueueName>();
  const outcomes: DrainCycleResult['outcomes'] = [];
  for (const { queue, burst } of plan.queues) {
    if (isFenced()) break;
    const messages = await opts.client.read(queue, opts.leaseSeconds, burst);
    if (messages.length === burst) backlog.add(queue);
    for (const message of messages) {
      if (isFenced()) break;
      const handler = message.malformed ? undefined : opts.handlers[message.envelope.kind];
      const outcome = await processMessage({
        sql: opts.sql,
        client: opts.client,
        queue,
        message,
        holder: opts.holder,
        expectedContractSetDigest: opts.expectedContractSetDigest,
        clock: opts.clock,
        policy: opts.policy,
        handler:
          handler ??
          (async (env) => {
            throw new Error(`no handler registered for message kind ${env.kind}`);
          }),
      });
      outcomes.push({ queue, outcome });
    }
  }
  return { state: next, backlog, outcomes };
}
