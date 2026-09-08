/**
 * HTTP port for model providers (blueprint §11.2). Adapters receive a transport so tests replay
 * recorded responses and no adapter touches the network directly. The abort signal comes from the
 * cycle runner's deadline; the transport must honour it.
 */
export interface ModelHttpRequest {
  method: 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelHttpResponse {
  status: number;
  body: string;
}

export type ModelHttpTransport = (req: ModelHttpRequest) => Promise<ModelHttpResponse>;

export const fetchModelTransport: ModelHttpTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs);
  const onAbort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
  }
};
