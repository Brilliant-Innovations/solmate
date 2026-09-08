import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { NonceWindow, Uuid, verifyServiceRequest, type Clock } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { BodyTooLarge, json, readBody, serve, type Handler } from './http.js';
import type { AuthorizerService } from '../service/authorizer.js';

/**
 * The risk-authorizer's internal API (blueprint §13.7, §15.5, §15.8): two verbs behind the shared
 * service secret with replay protection. `authorize` takes a cycle and account id, nothing else:
 * every bound field comes from immutable rows and chain reads the authorizer loads itself, so a
 * caller cannot widen an authorization by what it sends.
 */

export interface AuthorizerApiDeps {
  service: AuthorizerService;
  secretsHex: readonly string[];
  clock: Clock;
  logger: Logger;
  contractSetDigest: string;
  signingKeyId: string;
  maxSkewMs?: number;
}

const AuthorizeBody = z.object({ actionCycleId: Uuid, accountId: Uuid });
export const AUTHORIZER_ROUTES = ['GET /v1/health', 'POST /v1/authorize'] as const;

export function authorizerApiHandler(deps: AuthorizerApiDeps): Handler {
  const nonces = new NonceWindow(2 * (deps.maxSkewMs ?? 60_000));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    let body: string;
    try {
      body = await readBody(req, 65_536);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'BODY_TOO_LARGE' });
      throw err;
    }
    const auth = await verifyServiceRequest(deps.secretsHex, req.headers, { method, path, body }, { nowMs: Date.parse(deps.clock.now()), maxSkewMs: deps.maxSkewMs ?? 60_000, nonces });
    if (!auth.ok) {
      deps.logger.warn('authorizer_api_unauthenticated', { method, path, reason: auth.reason });
      return json(res, 401, { error: auth.reason });
    }
    switch (`${method} ${path}`) {
      case 'GET /v1/health':
        return json(res, 200, { service: 'risk-authorizer', contractSetDigest: deps.contractSetDigest, signingKeyId: deps.signingKeyId, openAuthorizations: deps.service.ledger.size(), at: deps.clock.now() });
      case 'POST /v1/authorize': {
        let parsed: z.infer<typeof AuthorizeBody>;
        try {
          parsed = AuthorizeBody.parse(JSON.parse(body));
        } catch (err) {
          return json(res, 400, { error: 'MALFORMED_REQUEST', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        }
        const out = await deps.service.authorize(parsed);
        return json(res, 200, out);
      }
      default:
        return json(res, 404, { error: 'NO_SUCH_ROUTE', routes: AUTHORIZER_ROUTES });
    }
  };
}

export function createAuthorizerApi(deps: AuthorizerApiDeps) {
  return serve(authorizerApiHandler(deps), (err) => deps.logger.error('authorizer_api_error', { error: err instanceof Error ? err.message : String(err) }));
}
