/**
 * Minimal HTTP transport port. Providers receive a transport so tests can replay recorded
 * responses and no provider client ever touches the network directly (§24.3 fakes).
 */
export interface HttpRequest {
  method: 'GET';
  url: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Production transport over the global fetch with an abort timeout. */
export const fetchTransport: HttpTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: controller.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${bodySnippet.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/** Query strings can carry addresses but never keys; keys travel in headers. Still, keep URLs short in errors. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}
