import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignedEmergencyCommand, type Clock } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { BodyTooLarge, json, readBody, serve, type Handler } from './http.js';
import type { ExecutorPipeline } from '../pipeline/pipeline.js';

/**
 * The out-of-band operator endpoint (blueprint D25 plane 1, §15.8, §15.10): a separate listener
 * that accepts only narrowly typed emergency commands signed by a pinned operator key. It needs
 * no database and no shared service secret: the command's own signature is the authentication,
 * and its nonce is consumed in the executor journal. Nothing here can increase exposure.
 */

export interface OutOfBandDeps {
  pipeline: ExecutorPipeline;
  clock: Clock;
  logger: Logger;
  maxBodyBytes?: number;
}

export const OUT_OF_BAND_ROUTES = ['GET /v1/health', 'POST /v1/emergency'] as const;

export function outOfBandHandler(deps: OutOfBandDeps): Handler {
  const limit = deps.maxBodyBytes ?? 65_536;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    const route = `${method} ${path}`;
    if (route === 'GET /v1/health') return json(res, 200, { service: 'execution-service', plane: 'out-of-band', localPause: deps.pipeline.localPause, at: deps.clock.now() });
    if (route !== 'POST /v1/emergency') return json(res, 404, { error: 'NO_SUCH_ROUTE', routes: OUT_OF_BAND_ROUTES });
    let body: string;
    try {
      body = await readBody(req, limit);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'BODY_TOO_LARGE' });
      throw err;
    }
    let signed: SignedEmergencyCommand;
    try {
      signed = SignedEmergencyCommand.parse(JSON.parse(body));
    } catch (err) {
      deps.logger.warn('out_of_band_malformed', { detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return json(res, 400, { error: 'MALFORMED_COMMAND' });
    }
    const outcome = await deps.pipeline.emergency({ signed });
    deps.logger.warn('out_of_band_command', { commandId: signed.payload.commandId, type: signed.payload.type, keyId: signed.keyId, outcome: outcome.outcome, reasons: outcome.outcome === 'REJECTED' ? outcome.reasons : [] });
    return json(res, outcome.outcome === 'REJECTED' ? 403 : 200, outcome);
  };
}

export function createOutOfBandApi(deps: OutOfBandDeps) {
  return serve(outOfBandHandler(deps), (err) => deps.logger.error('out_of_band_error', { error: err instanceof Error ? err.message : String(err) }));
}
