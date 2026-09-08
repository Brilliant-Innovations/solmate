import { createHash } from 'node:crypto';
import { base58Decode, base58Encode } from '@sol-agent-trader/solana-hard-state';

/**
 * Byte-level helpers for the direct-pool adapters (§14.6): little-endian readers over raw account
 * data, Anchor discriminators, and program-derived addresses. PDA derivation needs the ed25519
 * "is this point on the curve" test, implemented here over bigints so the execution library keeps
 * no wallet or signing dependency (GUARDRAILS Part 4).
 */

export class ByteReader {
  constructor(private readonly buf: Uint8Array, private pos = 0) {}
  get offset(): number {
    return this.pos;
  }
  seek(offset: number): this {
    if (offset < 0 || offset > this.buf.length) throw new RangeError(`seek ${offset} outside ${this.buf.length} bytes`);
    this.pos = offset;
    return this;
  }
  skip(n: number): this {
    return this.seek(this.pos + n);
  }
  private need(n: number): DataView {
    if (this.pos + n > this.buf.length) throw new RangeError(`read of ${n} bytes at ${this.pos} exceeds ${this.buf.length}`);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, n);
    this.pos += n;
    return v;
  }
  u8(): number {
    return this.need(1).getUint8(0);
  }
  u16(): number {
    return this.need(2).getUint16(0, true);
  }
  u32(): number {
    return this.need(4).getUint32(0, true);
  }
  i32(): number {
    return this.need(4).getInt32(0, true);
  }
  u64(): bigint {
    return this.need(8).getBigUint64(0, true);
  }
  i64(): bigint {
    return this.need(8).getBigInt64(0, true);
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  pubkey(): string {
    const start = this.pos;
    this.need(32);
    return base58Encode(this.buf.slice(start, start + 32));
  }
  bytes(n: number): Uint8Array {
    const start = this.pos;
    this.need(n);
    return this.buf.slice(start, start + n);
  }
}

export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function i32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

export function i32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

export function u128le(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 128n) throw new RangeError(`u128 out of range: ${value}`);
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(0, value & ((1n << 64n) - 1n), true);
  new DataView(out.buffer).setBigUint64(8, value >> 64n, true);
  return out;
}

export function i64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Anchor instruction discriminator: the first eight bytes of sha256("global:<name>"). */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

/** Anchor account discriminator: the first eight bytes of sha256("account:<Name>"). */
export function anchorAccountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8);
}

// --- ed25519 point decompression, only to reject PDAs that land on the curve ------------------------
const P = (1n << 255n) - 19n;
const D = mod(-121665n * modInverse(121666n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function modInverse(a: bigint): bigint {
  return modPow(a, P - 2n);
}

/** True when the 32 bytes decode to a valid ed25519 point (RFC 8032 §5.1.3). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = (u/v)^((p+3)/8) candidate
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * modPow(mod(u * v7), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return false;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

export function createProgramAddress(seeds: readonly Uint8Array[], programId: string): string | null {
  for (const s of seeds) if (s.length > 32) throw new RangeError('seed longer than 32 bytes');
  const hash = sha256(...seeds, base58Decode(programId), PDA_MARKER);
  return isOnCurve(hash) ? null : base58Encode(hash);
}

/** Canonical bump search, 255 downwards, exactly as the runtime does. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const address = createProgramAddress([...seeds, new Uint8Array([bump])], programId);
    if (address) return { address, bump };
  }
  throw new Error('no viable program address');
}

export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const pk = (address: string): Uint8Array => base58Decode(address);
