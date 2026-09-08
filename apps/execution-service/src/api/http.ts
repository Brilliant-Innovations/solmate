import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal HTTP plumbing for the two executor listeners. No framework: fewer packages inside a financial deployable (GUARDRAILS Part 4). */

export class BodyTooLarge extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLarge';
  }
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > limitBytes) throw new BodyTooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function serve(handler: Handler, onError: (err: unknown) => void): Server {
  return createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      onError(err);
      if (!res.headersSent) json(res, 500, { error: 'INTERNAL_ERROR' });
      else res.end();
    });
  });
}

export function parseListen(listen: string): { host: string; port: number } {
  const m = /^(.*):(\d{1,5})$/.exec(listen);
  if (!m) throw new Error(`listen address must be host:port, got ${listen}`);
  return { host: m[1] === '' ? '127.0.0.1' : m[1]!, port: Number(m[2]) };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export async function listen(server: Server, spec: { host: string; port: number }): Promise<{ host: string; port: number; url: string }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.port, spec.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const a = server.address() as AddressInfo;
  const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
  return { host: a.address, port: a.port, url: `http://${host}:${a.port}` };
}

export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
