import { Sha256Hex } from '../primitives.js';

/**
 * Canonical JSON for hashing and signing (blueprint D21, D52, §6.14, §15.3).
 *
 * - object keys sorted lexicographically at every level;
 * - `undefined` members dropped; `null` kept;
 * - `bigint` rendered as a decimal string;
 * - arrays keep order;
 * - non-finite numbers, functions, symbols, Dates and other non-JSON values are rejected so a
 *   canonical form can never depend on platform-specific serialization.
 *
 * Two semantically equal payloads produce byte-identical output; any change to any field changes
 * the hash. This is what makes database-only tampering detectable.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString(10));
    case 'undefined':
      throw new TypeError(`canonicalize: undefined is not representable at ${path}`);
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalize: ${typeof value} is not representable at ${path}`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => serialize(v === undefined ? null : v, `${path}[${i}]`)).join(',')}]`;
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) {
    throw new TypeError(`canonicalize: ${value.constructor.name} is not representable at ${path}`);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], `${path}.${k}`)}`).join(',')}}`;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new TypeError('hexToBytes: invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<Sha256Hex> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Sha256Hex.parse(bytesToHex(new Uint8Array(digest)));
}

/** SHA-256 of the canonical JSON form of `value`. */
export async function canonicalHash(value: unknown): Promise<Sha256Hex> {
  return sha256Hex(canonicalize(value));
}
