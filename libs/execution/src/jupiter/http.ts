/**
 * Minimal HTTP port for the shared Jupiter client (ADR-0003: the only quote path). Injected so
 * tests replay recorded responses; the production transport is fetch with an abort timeout.
 */
export interface JupiterHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}
export interface JupiterHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}
export type JupiterHttpTransport = (req: JupiterHttpRequest) => Promise<JupiterHttpResponse>;

export const fetchJupiterTransport: JupiterHttpTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: controller.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};
