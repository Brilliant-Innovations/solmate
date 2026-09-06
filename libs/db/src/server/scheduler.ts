import type { QueueName } from '@sol-agent-trader/contracts';
import { QUEUE_DRAIN_ORDER } from '../queues.js';

/**
 * Drain scheduler (blueprint §5.4). Pure and deterministic so the fairness rules are testable.
 *
 * Each cycle polls queues in fixed risk-first order. When the top queue still had a backlog after
 * its burst, lower queues are normally skipped so research can never delay risk reduction. The
 * starvation bound guarantees every queue is still polled at least once every `starvationBound`
 * cycles, so a permanently busy critical queue cannot silently freeze reconciliation forever.
 */

export interface DrainConfig {
  /** Max messages read per queue per cycle. */
  burst: Readonly<Record<QueueName, number>>;
  /** A queue is polled regardless of higher backlog once it has waited this many cycles. */
  starvationBound: number;
}

export interface DrainState {
  cycle: number;
  lastPolled: Readonly<Record<QueueName, number>>;
}

export interface DrainPlan {
  queues: readonly { queue: QueueName; burst: number }[];
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
  burst: { 'trade-critical': 10, reconciliation: 5, 'trading-actions': 5, research: 2 },
  starvationBound: 8,
};

export function initialDrainState(): DrainState {
  return { cycle: 0, lastPolled: { 'trade-critical': 0, reconciliation: 0, 'trading-actions': 0, research: 0 } };
}

/**
 * @param backlog which queues still had messages after their burst in the previous cycle
 */
export function planDrainCycle(state: DrainState, backlog: ReadonlySet<QueueName>, config: DrainConfig = DEFAULT_DRAIN_CONFIG): { plan: DrainPlan; state: DrainState } {
  const cycle = state.cycle + 1;
  const queues: { queue: QueueName; burst: number }[] = [];
  let higherBacklog = false;
  const lastPolled = { ...state.lastPolled };
  for (const queue of QUEUE_DRAIN_ORDER) {
    const starved = cycle - state.lastPolled[queue] >= config.starvationBound;
    if (!higherBacklog || starved) {
      queues.push({ queue, burst: config.burst[queue] });
      lastPolled[queue] = cycle;
    }
    if (backlog.has(queue)) higherBacklog = true;
  }
  return { plan: { queues }, state: { cycle, lastPolled } };
}
