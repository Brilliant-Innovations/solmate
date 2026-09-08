import { bytesToHex, hexToBytes, sha256Hex } from './canonical.js';

/**
 * Service-to-service request authentication with replay protection (blueprint §15.8): the worker
 * signs each request to the executor's internal API with a shared secret; the executor verifies the
 * signature over method, path, timestamp, nonce and body hash, rejects skewed timestamps and any
 * nonce it has already seen inside the window. HMAC-SHA256 over WebCrypto so both sides share one
 * implementation. The secret is never logged; only its key id (a hash prefix) appears in errors.
 */

export const SERVICE_AUTH_SCHEME = 'sat-hmac-v1' as const;
export const SERVICE_AUTH_HEADERS = { timestamp: 'x-sat-timestamp', nonce: 'x-sat-nonce', signature: 'x-sat-signature', keyId: 'x-sat-key-id' } as const;

export interface ServiceRequestFacts {
  method: string;
  path: string;
  body: string;
}

export interface ServiceAuthHeaders {
  [SERVICE_AUTH_HEADERS.timestamp]: string;
  [SERVICE_AUTH_HEADERS.nonce]: string;
  [SERVICE_AUTH_HEADERS.signature]: string;
  [SERVICE_AUTH_HEADERS.keyId]: string;
}

type Subtle = typeof globalThis.crypto.subtle;
type CryptoKey = Parameters<Subtle['sign']>[1];
type BufferSource = Parameters<Subtle['digest']>[1];
const subtle = (): Subtle => globalThis.crypto.subtle;
const asSource = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

async function hmacKey(secretHex: string): Promise<CryptoKey> {
  return subtle().importKey('raw', asSource(hexToBytes(secretHex)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function serviceKeyId(secretHex: string): Promise<string> {
  return `sat:${(await sha256Hex(hexToBytes(secretHex))).slice(0, 16)}`;
}

async function stringToSign(facts: ServiceRequestFacts, timestamp: string, nonce: string): Promise<string> {
  const bodyHash = await sha256Hex(new TextEncoder().encode(facts.body));
  return [SERVICE_AUTH_SCHEME, facts.method.toUpperCase(), facts.path, timestamp, nonce, bodyHash].join('\n');
}

export async function signServiceRequest(secretHex: string, facts: ServiceRequestFacts, opts: { nowMs: number; nonce: string }): Promise<ServiceAuthHeaders> {
  const timestamp = String(Math.floor(opts.nowMs));
  const key = await hmacKey(secretHex);
  const sig = new Uint8Array(await subtle().sign('HMAC', key, asSource(new TextEncoder().encode(await stringToSign(facts, timestamp, opts.nonce)))));
  return {
    [SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [SERVICE_AUTH_HEADERS.nonce]: opts.nonce,
    [SERVICE_AUTH_HEADERS.signature]: bytesToHex(sig),
    [SERVICE_AUTH_HEADERS.keyId]: await serviceKeyId(secretHex),
  };
}

export type ServiceAuthFailure = 'MISSING_HEADERS' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'TIMESTAMP_SKEW' | 'NONCE_REPLAYED' | 'MALFORMED';

/** Nonces seen inside the skew window; anything older than the window can no longer verify, so it can be forgotten. */
export class NonceWindow {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** Returns false when the nonce was already used inside the window. */
  admit(nonce: string, nowMs: number): boolean {
    for (const [n, at] of this.seen) if (nowMs - at > this.windowMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export async function verifyServiceRequest(
  secretsHex: readonly string[],
  headers: Readonly<Record<string, string | string[] | undefined>>,
  facts: ServiceRequestFacts,
  opts: { nowMs: number; maxSkewMs: number; nonces: NonceWindow },
): Promise<{ ok: true; keyId: string } | { ok: false; reason: ServiceAuthFailure }> {
  const h = (name: string): string | null => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const timestamp = h(SERVICE_AUTH_HEADERS.timestamp);
  const nonce = h(SERVICE_AUTH_HEADERS.nonce);
  const signature = h(SERVICE_AUTH_HEADERS.signature);
  const keyId = h(SERVICE_AUTH_HEADERS.keyId);
  if (!timestamp || !nonce || !signature || !keyId) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{1,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'MALFORMED' };
  let secret: string | null = null;
  for (const s of secretsHex) if ((await serviceKeyId(s)) === keyId) secret = s;
  if (secret === null) return { ok: false, reason: 'UNKNOWN_KEY' };
  if (Math.abs(opts.nowMs - Number(timestamp)) > opts.maxSkewMs) return { ok: false, reason: 'TIMESTAMP_SKEW' };
  const key = await hmacKey(secret);
  const valid = await subtle().verify('HMAC', key, asSource(hexToBytes(signature)), asSource(new TextEncoder().encode(await stringToSign(facts, timestamp, nonce))));
  if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!opts.nonces.admit(nonce, opts.nowMs)) return { ok: false, reason: 'NONCE_REPLAYED' };
  return { ok: true, keyId };
}
