import { base58Decode, base58Encode } from '@sol-agent-trader/solana-hard-state';

/**
 * Minimal Solana transaction codec (legacy and v0 messages) for the executor's own structural
 * checks (blueprint §15.4 step 4, §15.7A). No SDK: the executor must not depend on a router or
 * wallet package to decide what it signs. Round-trip exact so a decoded transaction re-encodes to
 * the same bytes, which is what the signed-transaction hash is taken over.
 */

export interface CompiledInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface AddressTableLookup {
  accountKey: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface DecodedMessage {
  version: 'legacy' | 0;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  staticAccountKeys: string[];
  recentBlockhash: string;
  instructions: CompiledInstruction[];
  addressTableLookups: AddressTableLookup[];
}

export interface DecodedTransaction {
  signatures: (string | null)[];
  message: DecodedMessage;
  messageBytes: Uint8Array;
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('transaction truncated');
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new RangeError('transaction truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  compactU16(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
    throw new RangeError('compact-u16 too long');
  }
  offset(): number {
    return this.pos;
  }
  done(): boolean {
    return this.pos === this.buf.length;
  }
}

function writeCompactU16(out: number[], value: number): void {
  if (value < 0 || value > 0xffff) throw new RangeError('compact-u16 out of range');
  let v = value;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return;
    }
    out.push(b | 0x80);
  }
}

const ZERO_SIG = new Uint8Array(64);

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  const r = new Reader(bytes);
  const sigCount = r.compactU16();
  const signatures: (string | null)[] = [];
  for (let i = 0; i < sigCount; i++) {
    const s = r.bytes(64);
    signatures.push(s.every((b) => b === 0) ? null : base58Encode(s));
  }
  const messageStart = r.offset();
  const first = r.u8();
  let version: DecodedMessage['version'];
  let numRequiredSignatures: number;
  if ((first & 0x80) !== 0) {
    version = (first & 0x7f) as 0;
    if (version !== 0) throw new RangeError(`unsupported message version ${version}`);
    numRequiredSignatures = r.u8();
  } else {
    version = 'legacy';
    numRequiredSignatures = first;
  }
  const header = { numRequiredSignatures, numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  const keyCount = r.compactU16();
  const staticAccountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) staticAccountKeys.push(base58Encode(r.bytes(32)));
  const recentBlockhash = base58Encode(r.bytes(32));
  const ixCount = r.compactU16();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = r.u8();
    const n = r.compactU16();
    const accountIndexes: number[] = [];
    for (let k = 0; k < n; k++) accountIndexes.push(r.u8());
    const dataLen = r.compactU16();
    instructions.push({ programIdIndex, accountIndexes, data: new Uint8Array(r.bytes(dataLen)) });
  }
  const addressTableLookups: AddressTableLookup[] = [];
  if (version === 0) {
    const n = r.compactU16();
    for (let i = 0; i < n; i++) {
      const accountKey = base58Encode(r.bytes(32));
      const w = r.compactU16();
      const writableIndexes: number[] = [];
      for (let k = 0; k < w; k++) writableIndexes.push(r.u8());
      const ro = r.compactU16();
      const readonlyIndexes: number[] = [];
      for (let k = 0; k < ro; k++) readonlyIndexes.push(r.u8());
      addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
    }
  }
  if (!r.done()) throw new RangeError('trailing bytes after transaction');
  return { signatures, message: { version, header, staticAccountKeys, recentBlockhash, instructions, addressTableLookups }, messageBytes: bytes.subarray(messageStart) };
}

export function encodeMessage(m: DecodedMessage): Uint8Array {
  const out: number[] = [];
  if (m.version === 0) out.push(0x80);
  out.push(m.header.numRequiredSignatures, m.header.numReadonlySigned, m.header.numReadonlyUnsigned);
  writeCompactU16(out, m.staticAccountKeys.length);
  for (const k of m.staticAccountKeys) out.push(...base58Decode(k));
  out.push(...base58Decode(m.recentBlockhash));
  writeCompactU16(out, m.instructions.length);
  for (const ix of m.instructions) {
    out.push(ix.programIdIndex);
    writeCompactU16(out, ix.accountIndexes.length);
    out.push(...ix.accountIndexes);
    writeCompactU16(out, ix.data.length);
    out.push(...ix.data);
  }
  if (m.version === 0) {
    writeCompactU16(out, m.addressTableLookups.length);
    for (const l of m.addressTableLookups) {
      out.push(...base58Decode(l.accountKey));
      writeCompactU16(out, l.writableIndexes.length);
      out.push(...l.writableIndexes);
      writeCompactU16(out, l.readonlyIndexes.length);
      out.push(...l.readonlyIndexes);
    }
  }
  return new Uint8Array(out);
}

export function encodeTransaction(signatures: (string | null)[], message: DecodedMessage): Uint8Array {
  const out: number[] = [];
  writeCompactU16(out, signatures.length);
  for (const s of signatures) out.push(...(s === null ? ZERO_SIG : base58Decode(s)));
  out.push(...encodeMessage(message));
  return new Uint8Array(out);
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
