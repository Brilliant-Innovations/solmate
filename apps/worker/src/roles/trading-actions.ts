import { canAuthorize } from '@sol-agent-trader/agents';
import { compareInstants, type ActionCycle, type Clock, type Instant, type Proposal, type QueueMessageEnvelope, type Sha256Hex, type Uuid } from '@sol-agent-trader/contracts';
import { processMessage, type LeasedMessage, type OpenPositionRow, type PgmqClient, type ProcessingOutcome, type Sql } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `trading-actions` (blueprint §11.8–11.9, §6.10D, ADR-0001 handoff durability;
 * INV-14). Consumes `action_cycle.cleared` messages the agents role enqueued in the same transaction
 * as the cycle, idempotently through `ops.processed_messages`. Every message is re-checked against
 * the database before anything moves: the cycle must still be authorizable (CLEARED + CONFIRM at
 * its latest cutoff), never evaluated or executed before, its proposal unexpired, the position open
 * and REVIEWED. REDUCE/EXIT go through the same intent path as a mandatory exit; ADJUST_PROTECTION
 * can only tighten a stop. Nothing here increases exposure.
 */

export interface ClearedActionPayload {
  actionCycleId: Uuid;
  positionId: Uuid;
  action: string;
  proposalId: Uuid | null;
  expiresAt: Instant;
  strategyVersionId: string;
}

export interface TradingActionsDeps {
  loadCycle(id: Uuid): Promise<ActionCycle | null>;
  loadProposal(id: Uuid): Promise<Proposal | null>;
  /** The open position with its current review state; null when closed or missing. */
  loadPosition(id: Uuid): Promise<(OpenPositionRow & { reviewState: string }) | null>;
  tightenStop(positionId: Uuid, level: number): Promise<boolean>;
  execute(position: OpenPositionRow, cycle: ActionCycle, proposal: Proposal, now: Instant): Promise<'FILLED' | 'NOT_FILLED'>;
  clock: Clock;
  logger: Logger;
}

export type ClearedActionResult =
  | { outcome: 'EXECUTED'; fill: 'FILLED' | 'NOT_FILLED'; action: string }
  | { outcome: 'PROTECTION_TIGHTENED'; level: number; applied: boolean }
  | { outcome: 'SKIPPED'; reason: 'MALFORMED_PAYLOAD' | 'CYCLE_NOT_FOUND' | 'NOT_AUTHORIZABLE' | 'ALREADY_EXECUTED' | 'PROPOSAL_MISSING' | 'PROPOSAL_EXPIRED' | 'POSITION_GONE' | 'POSITION_NOT_REVIEWED' | 'NO_TIGHTER_STOP' | 'UNSUPPORTED_ACTION' };

function parsePayload(raw: Record<string, unknown>): ClearedActionPayload | null {
  const id = (v: unknown): v is Uuid => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
  if (!id(raw['actionCycleId']) || !id(raw['positionId']) || typeof raw['action'] !== 'string' || typeof raw['expiresAt'] !== 'string' || typeof raw['strategyVersionId'] !== 'string') return null;
  return { actionCycleId: raw['actionCycleId'], positionId: raw['positionId'], action: raw['action'], proposalId: id(raw['proposalId']) ? raw['proposalId'] : null, expiresAt: raw['expiresAt'] as Instant, strategyVersionId: raw['strategyVersionId'] };
}

/** The handler body; pure of the queue so it can be unit-tested. Throws only on infrastructure failure (which the queue retries). */
export async function handleClearedAction(deps: TradingActionsDeps, envelope: QueueMessageEnvelope): Promise<ClearedActionResult> {
  const now = deps.clock.now();
  const payload = parsePayload(envelope.payload);
  const skip = (reason: Extract<ClearedActionResult, { outcome: 'SKIPPED' }>['reason']): ClearedActionResult => {
    deps.logger.warn('trading_action_skipped', { messageId: envelope.messageId, cycleId: payload?.actionCycleId ?? null, reason });
    return { outcome: 'SKIPPED', reason };
  };
  if (!payload) return skip('MALFORMED_PAYLOAD');
  const cycle = await deps.loadCycle(payload.actionCycleId);
  if (!cycle) return skip('CYCLE_NOT_FOUND');
  if (!canAuthorize(cycle) || cycle.positionId !== payload.positionId) return skip('NOT_AUTHORIZABLE');
  if (cycle.riskEvaluationId !== null || cycle.intentId !== null) return skip('ALREADY_EXECUTED');
  if (cycle.proposedAction !== 'REDUCE' && cycle.proposedAction !== 'EXIT' && cycle.proposedAction !== 'ADJUST_PROTECTION') return skip('UNSUPPORTED_ACTION');
  const proposal = cycle.proposalId ? await deps.loadProposal(cycle.proposalId) : null;
  if (!proposal || proposal.proposal.actionType !== cycle.proposedAction) return skip('PROPOSAL_MISSING');
  if (compareInstants(proposal.expiresAt, now) <= 0) return skip('PROPOSAL_EXPIRED');
  const position = await deps.loadPosition(payload.positionId);
  if (!position) return skip('POSITION_GONE');
  if (position.reviewState !== 'REVIEWED') return skip('POSITION_NOT_REVIEWED');
  switch (cycle.proposedAction) {
    case 'REDUCE':
    case 'EXIT': {
      const fill = await deps.execute(position, cycle, proposal, now);
      deps.logger.info('trading_action_executed', { cycleId: cycle.id, positionId: position.id, action: cycle.proposedAction, fill });
      return { outcome: 'EXECUTED', fill, action: cycle.proposedAction };
    }
    case 'ADJUST_PROTECTION': {
      const level = proposal.proposal.protectionIntent?.tightenStopToPrice ?? null;
      if (level === null || !(level > 0)) return skip('NO_TIGHTER_STOP');
      const applied = await deps.tightenStop(position.id, level);
      deps.logger.info('trading_action_protection', { cycleId: cycle.id, positionId: position.id, level, applied });
      return { outcome: 'PROTECTION_TIGHTENED', level, applied };
    }
    default:
      return skip('UNSUPPORTED_ACTION');
  }
}

export interface TradingActionsLoopDeps extends TradingActionsDeps {
  sql: Sql;
  client: PgmqClient;
  holder: string;
  expectedContractSetDigest: Sha256Hex;
  batch: number;
  leaseSeconds: number;
}

export interface TradingActionsReport {
  read: number;
  outcomes: Record<string, number>;
}

/** One drain of the trading-actions queue: each message is processed exactly once per idempotency key. */
export async function runTradingActionsCycle(deps: TradingActionsLoopDeps): Promise<TradingActionsReport> {
  const report: TradingActionsReport = { read: 0, outcomes: {} };
  const messages: LeasedMessage[] = await deps.client.read('trading-actions', deps.leaseSeconds, deps.batch);
  report.read = messages.length;
  for (const message of messages) {
    const outcome: ProcessingOutcome = await processMessage({
      sql: deps.sql,
      client: deps.client,
      queue: 'trading-actions',
      message,
      holder: deps.holder,
      expectedContractSetDigest: deps.expectedContractSetDigest,
      clock: deps.clock,
      handler: async (envelope) => {
        if (envelope.kind !== 'action_cycle.cleared') throw new Error(`unknown trading-actions kind ${envelope.kind}`);
        return handleClearedAction(deps, envelope);
      },
    });
    const key = outcome.outcome === 'PROCESSED' ? 'PROCESSED' : outcome.outcome;
    report.outcomes[key] = (report.outcomes[key] ?? 0) + 1;
    if (outcome.outcome === 'RETRY_SCHEDULED' || outcome.outcome === 'DEAD_LETTER') deps.logger.warn('trading_action_not_processed', { messageId: message.messageId.toString(), ...outcome });
  }
  if (report.read > 0) deps.logger.info('trading_actions_cycle', { read: report.read, outcomes: report.outcomes });
  return report;
}
