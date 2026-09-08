import { randomBytes } from 'node:crypto';
import { signServiceRequest, type Amount, type Clock, type EmergencyCommand, type ExecutionRequest, type MintAddress, type PositionRiskShadow, type ProtectionMode, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Worker-side client for the executor's internal API (blueprint §15.2, §15.8). Every request is
 * signed with the shared service secret, timestamped and nonce'd; the executor rejects replays.
 * The client knows only the executor's verbs; there is nothing here that could ask for a raw
 * signature.
 */

export interface ExecutorClientOptions {
  baseUrl: string;
  secretHex: string;
  clock: Clock;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ExecutorHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`executor responded ${status}`);
    this.name = 'ExecutorHttpError';
  }
}

export class ExecutorClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ExecutorClientOptions) {
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
      if (!res.ok) throw new ExecutorHttpError(res.status, json);
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/health', undefined);
  }

  execute(request: ExecutionRequest, protectionMode: ProtectionMode): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/execute', { request, protectionMode });
  }

  recover(): Promise<{ recovered: { correlationId: string; resolution: string; signature: string | null }[] }> {
    return this.call('POST', '/v1/recover', {});
  }

  clearLocalPause(reviewedBy: string): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/pause/clear', { reviewedBy });
  }

  /** §15.10A: push the sequenced position shadow; a regression comes back as a refusal, not an exception. */
  async syncShadow(shadow: PositionRiskShadow): Promise<{ ok: boolean; sequence?: number; reason?: string; lastSynced?: number }> {
    try {
      return await this.call('POST', '/v1/shadow', shadow);
    } catch (err) {
      if (err instanceof ExecutorHttpError && err.status === 409) return err.body as { ok: boolean; reason?: string; lastSynced?: number };
      throw err;
    }
  }

  /** The position monitor's DB-down risk reduction (§15.10A): a rejection comes back as the outcome, not an exception. */
  async emergencyMonitor(cmd: { commandId: Uuid; type: EmergencyCommand['type']; mint: MintAddress | null; maxAmount: Amount | null; reason: string; shadowSequence: number | null }): Promise<{ outcome: string; reasons?: string[]; detail?: string[] }> {
    try {
      return await this.call('POST', '/v1/emergency/monitor', cmd);
    } catch (err) {
      if (err instanceof ExecutorHttpError && err.status === 403) return err.body as { outcome: string; reasons?: string[]; detail?: string[] };
      throw err;
    }
  }
}
