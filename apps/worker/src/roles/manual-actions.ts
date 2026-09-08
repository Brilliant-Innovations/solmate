import type { Amount, Clock, ControlRequestKind, Instant, Uuid } from '@sol-agent-trader/contracts';
import { amountToBigInt, mulDiv } from '@sol-agent-trader/contracts';
import type { OpenPositionRow, PendingControlRequest } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `manual-actions` (blueprint §14.8, §20.8, §31 "human risk-increasing controls
 * require step-up while pause/close remain fast"; execution plan M7). Resolves the operator's
 * risk-reducing position controls: MANUAL_CLOSE, MANUAL_REDUCE and EMERGENCY_CLOSE_ALL. Each one
 * goes through the same deterministic exit path as a mandatory stop (cycle, proposal, deterministic
 * review, risk evaluation, intent, adapter), so it is audited in the same timeline as autonomous
 * actions and never waits for AI review. Nothing here increases exposure, so no step-up is asked.
 */

export interface ManualActionsRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  listOpenPositions(limit: number): Promise<OpenPositionRow[]>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
}

export interface ManualActionsDeps {
  repo: ManualActionsRepo;
  /** The position monitor's deterministic exit: records the audited cycle and executes through the account's adapter. */
  exit: (position: OpenPositionRow, action: 'EXIT' | 'REDUCE', fraction: number, requested: Amount, reason: string, now: Instant) => Promise<'FILLED' | 'NOT_FILLED'>;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number; maxOpenPositions: number };
}

export interface ManualActionsReport {
  requests: number;
  filled: number;
  notFilled: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

const KINDS: ControlRequestKind[] = ['MANUAL_CLOSE', 'MANUAL_REDUCE', 'EMERGENCY_CLOSE_ALL'];
const MILLION = 1_000_000n;

export function reduceQuantity(quantity: Amount, fraction: number): Amount {
  return mulDiv(quantity, BigInt(Math.round(fraction * Number(MILLION))), MILLION, 'FLOOR');
}

export async function runManualActionsCycle(deps: ManualActionsDeps): Promise<ManualActionsReport> {
  const now = deps.clock.now();
  const report: ManualActionsReport = { requests: 0, filled: 0, notFilled: 0, refused: {}, errors: [] };
  const requests = await deps.repo.listPending(KINDS, deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('manual_action_refused', { requestId: req.id, kind: req.kind, reason, by: req.requestedBy, ...extra });
    };
    try {
      const role = await deps.repo.operatorRole(req.requestedBy);
      if (role !== 'operator' && role !== 'admin') {
        await refuse('NOT_AN_OPERATOR', { role });
        continue;
      }
      const positions = await deps.repo.listOpenPositions(deps.config.maxOpenPositions);
      if (req.kind === 'EMERGENCY_CLOSE_ALL') {
        const results: { positionId: Uuid; result: 'FILLED' | 'NOT_FILLED' | 'ERROR'; error?: string }[] = [];
        for (const p of positions) {
          try {
            const r = await deps.exit(p, 'EXIT', 1, p.quantity, 'MANUAL_EMERGENCY_CLOSE_ALL', now);
            results.push({ positionId: p.id, result: r });
            if (r === 'FILLED') report.filled++;
            else report.notFilled++;
          } catch (err) {
            results.push({ positionId: p.id, result: 'ERROR', error: err instanceof Error ? err.message : String(err) });
          }
        }
        await deps.repo.resolve(req.id, 'ACCEPTED', { positions: results.length, results }, now);
        deps.logger.warn('manual_emergency_close_all', { requestId: req.id, by: req.requestedBy, results });
        continue;
      }
      const positionId = typeof req.payload['positionId'] === 'string' ? (req.payload['positionId'] as Uuid) : null;
      if (!positionId) {
        await refuse('MALFORMED_PAYLOAD', { needs: ['positionId'] });
        continue;
      }
      const p = positions.find((x) => x.id === positionId);
      if (!p) {
        await refuse('POSITION_NOT_OPEN', { positionId });
        continue;
      }
      let action: 'EXIT' | 'REDUCE' = 'EXIT';
      let fraction = 1;
      let requested: Amount = p.quantity;
      if (req.kind === 'MANUAL_REDUCE') {
        const f = req.payload['fraction'];
        if (typeof f !== 'number' || !(f > 0) || !(f < 1)) {
          await refuse('MALFORMED_PAYLOAD', { needs: ['fraction in (0, 1)'] });
          continue;
        }
        action = 'REDUCE';
        fraction = f;
        requested = reduceQuantity(p.quantity, f);
        if (amountToBigInt(requested) === 0n) {
          await refuse('REDUCTION_ROUNDS_TO_ZERO', { positionId, fraction: f });
          continue;
        }
      }
      const reason = req.kind === 'MANUAL_CLOSE' ? 'MANUAL_CLOSE' : 'MANUAL_REDUCE';
      const result = await deps.exit(p, action, fraction, requested, reason, now);
      if (result === 'FILLED') report.filled++;
      else report.notFilled++;
      await deps.repo.resolve(req.id, 'ACCEPTED', { positionId, action, fraction, requested, result }, now);
      deps.logger.info('manual_action_executed', { requestId: req.id, kind: req.kind, positionId, asset: p.symbol, action, fraction, requested, result, by: req.requestedBy });
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (report.requests > 0) deps.logger.info('manual_actions_cycle', { ...report, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('manual_action_failed', e);
  return report;
}
