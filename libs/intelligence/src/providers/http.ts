/**
 * HTTP port for intelligence providers (blueprint §3.4–3.5, §24.3 fakes). Structurally identical to
 * the market lib's transport so the worker passes the same fetch transport; the lib itself never
 * touches the network. Keys travel in headers or the query and are redacted from every log line.
 */
export interface IntelHttpRequest {
  method: 'GET';
  url: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface IntelHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type IntelHttpTransport = (req: IntelHttpRequest) => Promise<IntelHttpResponse>;

export class IntelProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly endpoint: string,
    detail: string,
  ) {
    super(`${provider} ${endpoint} ${status}: ${detail.slice(0, 200)}`);
    this.name = 'IntelProviderError';
  }
}

/** Removes anything that looks like a key from a URL before it reaches a log. */
export function redactIntelUrl(url: string): string {
  return url.replace(/(auth_token|key|apikey|token)=[^&]+/gi, '$1=REDACTED');
}

/** A minimal minute window limiter: `take()` waits (via the injected sleep) until a slot is free. */
export class MinuteLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly perMinute: number,
    private readonly nowMs: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async take(): Promise<void> {
    for (;;) {
      const now = this.nowMs();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      await this.sleep(Math.max(1, 60_000 - (now - oldest)));
    }
  }
}
