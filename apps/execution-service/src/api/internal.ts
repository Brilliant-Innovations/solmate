import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { Amount, EmergencyCommandType, ExecutionRequest, MintAddress, NonceWindow, PositionRiskShadow, ProtectionMode, Uuid, verifyServiceRequest, type Clock, type SignedApprovalGrant, type SignerHealth, type TradeIntent } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { BodyTooLarge, json, readBody, serve, type Handler } from './http.js';
import type { ExecutorPipeline } from '../pipeline/pipeline.js';
import type { DetailedExecution } from '@sol-agent-trader/execution';

/**
 * The executor's internal API (blueprint §15.2, §15.8): the narrow verbs the worker may call over
 * the private network, each request HMAC-authenticated with timestamp and nonce replay
 * protection. There is no route that signs arbitrary bytes, transfers SOL or calls a program;
 * the only way to a signature is an authorized intent through the pipeline.
 */

export interface InternalApiDeps {
  pipeline: ExecutorPipeline;
  secretsHex: readonly string[];
  clock: Clock;
  logger: Logger;
  contractSetDigest: string;
  /** Immutable trading.intents row; throws when the database is unavailable (entries stop, D22). */
  loadIntent: (intentId: Uuid) => Promise<TradeIntent | null>;
  loadApproval: (intentId: Uuid) => Promise<SignedApprovalGrant | null>;
  signerHealth: () => Promise<SignerHealth>;
  /** Best-effort reconciliation of an executed attempt into Postgres; the journal already holds the truth. */
  persist?: (execution: DetailedExecution, lifecycle: 'COMPLETED' | 'FAILED' | 'EXECUTING') => Promise<void>;
  maxSkewMs?: number;
  maxBodyBytes?: number;
}

const ExecuteBody = z.object({ request: ExecutionRequest, protectionMode: ProtectionMode });
const ClearPauseBody = z.object({ reviewedBy: z.string().min(1).max(200) });
/** The position monitor's authenticated emergency path (§15.10A): risk reduction only, bound to the shadow sequence it acted on. */
const MonitorBody = z.object({ commandId: Uuid, type: EmergencyCommandType, mint: MintAddress.nullable(), maxAmount: Amount.nullable(), reason: z.string().min(1).max(1024), shadowSequence: z.number().int().nonnegative().nullable() });

export const INTERNAL_ROUTES = ['GET /v1/health', 'POST /v1/execute', 'POST /v1/recover', 'POST /v1/pause/clear', 'POST /v1/shadow', 'POST /v1/emergency/monitor'] as const;

export function internalApiHandler(deps: InternalApiDeps): Handler {
  const nonces = new NonceWindow(2 * (deps.maxSkewMs ?? 60_000));
  const limit = deps.maxBodyBytes ?? 1_048_576;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    let body: string;
    try {
      body = await readBody(req, limit);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'BODY_TOO_LARGE' });
      throw err;
    }
    const nowMs = Date.parse(deps.clock.now());
    const auth = await verifyServiceRequest(deps.secretsHex, req.headers, { method, path, body }, { nowMs, maxSkewMs: deps.maxSkewMs ?? 60_000, nonces });
    if (!auth.ok) {
      deps.logger.warn('internal_api_unauthenticated', { method, path, reason: auth.reason });
      return json(res, 401, { error: auth.reason });
    }
    const route = `${method} ${path}`;
    switch (route) {
      case 'GET /v1/health': {
        const p = deps.pipeline;
        return json(res, 200, {
          service: 'execution-service',
          contractSetDigest: deps.contractSetDigest,
          localPause: p.localPause,
          unresolvedAttempts: p.journal.unresolvedAttempts().length,
          openExposureBaseUnits: p.ledger.aggregateNonSettlementExposure(),
          signer: await deps.signerHealth(),
          at: deps.clock.now(),
        });
      }
      case 'POST /v1/execute': {
        let parsed: z.infer<typeof ExecuteBody>;
        try {
          parsed = ExecuteBody.parse(JSON.parse(body));
        } catch (err) {
          return json(res, 400, { error: 'MALFORMED_REQUEST', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        }
        let stored: TradeIntent | null;
        let approval: SignedApprovalGrant | null;
        try {
          stored = await deps.loadIntent(parsed.request.intent.id);
          approval = stored ? await deps.loadApproval(parsed.request.intent.id) : null;
        } catch (err) {
          // Postgres unavailable: new entries stop (D22). Nothing is claimed or journaled.
          deps.logger.error('internal_api_db_unavailable', { intentId: parsed.request.intent.id, error: err instanceof Error ? err.message : String(err) });
          return json(res, 503, { outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['DB_UNAVAILABLE'], detail: [] });
        }
        const outcome = await deps.pipeline.submit({ request: parsed.request, storedIntent: stored, approval, protectionMode: parsed.protectionMode });
        if (outcome.outcome === 'EXECUTED' && deps.persist) {
          const s = outcome.execution.attempt.state;
          await deps.persist(outcome.execution, s === 'FINALIZED' ? 'COMPLETED' : s === 'PREPARED' || s === 'NOT_LANDED' || s === 'SIGNED_NOT_SUBMITTED' ? 'FAILED' : 'EXECUTING');
        }
        deps.logger.info('internal_api_execute', { intentId: parsed.request.intent.id, outcome: outcome.outcome, state: outcome.outcome === 'EXECUTED' ? outcome.execution.attempt.state : null, reasons: outcome.outcome === 'DENIED' ? outcome.reasons : outcome.outcome === 'EXECUTED' ? outcome.execution.result.rejectionReasons : [] });
        return json(res, 200, outcome);
      }
      case 'POST /v1/recover': {
        const recovered = await deps.pipeline.recover();
        deps.logger.info('internal_api_recover', { resolved: recovered.length });
        return json(res, 200, { recovered });
      }
      case 'POST /v1/pause/clear': {
        let parsed: z.infer<typeof ClearPauseBody>;
        try {
          parsed = ClearPauseBody.parse(JSON.parse(body));
        } catch {
          return json(res, 400, { error: 'MALFORMED_REQUEST' });
        }
        await deps.pipeline.clearLocalPause(parsed.reviewedBy);
        deps.logger.warn('internal_api_local_pause_cleared', { reviewedBy: parsed.reviewedBy });
        return json(res, 200, { localPause: deps.pipeline.localPause });
      }
      case 'POST /v1/shadow': {
        let shadow: z.infer<typeof PositionRiskShadow>;
        try {
          shadow = PositionRiskShadow.parse(JSON.parse(body));
        } catch (err) {
          return json(res, 400, { error: 'MALFORMED_REQUEST', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        }
        const synced = await deps.pipeline.syncShadow(shadow);
        deps.logger.info('internal_api_shadow', { sequence: shadow.sequence, positions: shadow.positions.length, ok: synced.ok });
        return json(res, synced.ok ? 200 : 409, synced);
      }
      case 'POST /v1/emergency/monitor': {
        let monitor: z.infer<typeof MonitorBody>;
        try {
          monitor = MonitorBody.parse(JSON.parse(body));
        } catch (err) {
          return json(res, 400, { error: 'MALFORMED_REQUEST', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        }
        const outcome = await deps.pipeline.emergency({ monitor });
        deps.logger.warn('internal_api_monitor_emergency', { commandId: monitor.commandId, type: monitor.type, mint: monitor.mint, shadowSequence: monitor.shadowSequence, outcome: outcome.outcome, reasons: outcome.outcome === 'REJECTED' ? outcome.reasons : [] });
        return json(res, outcome.outcome === 'REJECTED' ? 403 : 200, outcome);
      }
      default:
        return json(res, 404, { error: 'NO_SUCH_ROUTE', routes: INTERNAL_ROUTES });
    }
  };
}

export function createInternalApi(deps: InternalApiDeps) {
  return serve(internalApiHandler(deps), (err) => deps.logger.error('internal_api_error', { error: err instanceof Error ? err.message : String(err) }));
}
