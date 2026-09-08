import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SignedRiskAuthorizedIntent, signServiceRequest, type Clock, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Worker-side client for the risk-authorizer's internal API (blueprint §13.7, §15.5, §15.8). The
 * request names a cycle and an account and nothing else; every bound field comes from immutable
 * rows and chain reads the authorizer loads itself. Responses are validated: an AUTHORIZED reply
 * must carry a well-formed signed envelope, and the worker still treats it as untrusted until the
 * executor verifies the signature against its pinned authorizer keys.
 */

export interface AuthorizerClientOptions {
  baseUrl: string;
  secretHex: string;
  clock: Clock;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AuthorizerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`risk-authorizer responded ${status}`);
    this.name = 'AuthorizerHttpError';
  }
}

const Denial = z.object({ intentId: z.string().nullable(), actionCycleId: z.string(), deniedAt: z.string(), reasonCodes: z.array(z.string()), detail: z.string().nullable() });
const Outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('AUTHORIZED'), envelope: SignedRiskAuthorizedIntent, authorizationHash: z.string().regex(/^[0-9a-f]{64}$/), intentId: z.string(), projectionSequence: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('DENIED'), denial: Denial }),
]);
export type AuthorizeOutcome = z.infer<typeof Outcome>;

export class AuthorizerClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AuthorizerClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = await signServiceRequest(this.opts.secretHex, { method, path, body: text }, { nowMs: Date.parse(this.opts.clock.now()), nonce: randomBytes(16).toString('base64url') });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: method === 'POST' ? text : undefined, signal: controller.signal });
      const json = (await res.json()) as unknown;
      if (!res.ok) throw new AuthorizerHttpError(res.status, json);
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/health', undefined);
  }

  /** AUTHORIZED with a validated envelope, DENIED with the recorded reasons, or a thrown error for transport and shape failures. */
  async authorize(req: { actionCycleId: Uuid; accountId: Uuid }): Promise<AuthorizeOutcome> {
    const raw = await this.call<unknown>('POST', '/v1/authorize', req);
    const parsed = Outcome.safeParse(raw);
    if (!parsed.success) throw new Error(`risk-authorizer reply has an unexpected shape: ${parsed.error.issues[0]?.message ?? 'n/a'}`);
    return parsed.data;
  }
}
