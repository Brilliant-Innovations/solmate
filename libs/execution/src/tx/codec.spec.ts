import fc from 'fast-check';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { decodeTransaction, encodeMessage, encodeTransaction, fromBase64, toBase64, type DecodedMessage } from './codec.js';

const key = (seed: number) => base58Encode(new Uint8Array(32).fill(seed));

describe('transaction codec (§15.4 structural checks need exact bytes)', () => {
  it('decodes a v0 transaction with lookup tables and re-encodes it to the same bytes; the message bytes are what gets signed', () => {
    const message: DecodedMessage = {
      version: 0,
      header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 2 },
      staticAccountKeys: [key(1), key(2), key(3), key(4)],
      recentBlockhash: key(9),
      instructions: [
        { programIdIndex: 3, accountIndexes: [0, 1], data: new Uint8Array([2, 0, 0, 0, 1, 2, 3]) },
        { programIdIndex: 2, accountIndexes: [0, 1, 4, 5], data: new Uint8Array(300).fill(7) },
      ],
      addressTableLookups: [{ accountKey: key(8), writableIndexes: [1, 2], readonlyIndexes: [3] }],
    };
    const bytes = encodeTransaction([null], message);
    const decoded = decodeTransaction(bytes);
    expect(decoded.signatures).toEqual([null]);
    expect(decoded.message).toEqual(message);
    expect(encodeTransaction(decoded.signatures, decoded.message)).toEqual(bytes);
    expect(decoded.messageBytes).toEqual(encodeMessage(message));
    expect(decodeTransaction(fromBase64(toBase64(bytes))).message.version).toBe(0);
    const legacy = decodeTransaction(encodeTransaction([null], { ...message, version: 'legacy', addressTableLookups: [] }));
    expect(legacy.message.version).toBe('legacy');
    expect(() => decodeTransaction(bytes.subarray(0, bytes.length - 3))).toThrow(/truncated/);
    expect(() => decodeTransaction(new Uint8Array([...bytes, 0]))).toThrow(/trailing/);
  });

  it('property: every well-formed message round-trips exactly', () => {
    const idx = fc.integer({ min: 0, max: 255 });
    const ix = fc.record({ programIdIndex: idx, accountIndexes: fc.array(idx, { maxLength: 12 }), data: fc.uint8Array({ maxLength: 400 }) });
    const lookup = fc.record({ accountKey: fc.integer({ min: 1, max: 255 }).map(key), writableIndexes: fc.array(idx, { maxLength: 8 }), readonlyIndexes: fc.array(idx, { maxLength: 8 }) });
    fc.assert(
      fc.property(fc.constantFrom<'legacy' | 0>('legacy', 0), fc.integer({ min: 1, max: 4 }), fc.array(fc.integer({ min: 1, max: 255 }), { minLength: 1, maxLength: 20 }), fc.array(ix, { maxLength: 6 }), fc.array(lookup, { maxLength: 3 }), fc.integer({ min: 0, max: 2 }), (version, sigs, keys, instructions, lookups, extraSigs) => {
        const message: DecodedMessage = { version, header: { numRequiredSignatures: sigs, numReadonlySigned: 0, numReadonlyUnsigned: 1 }, staticAccountKeys: keys.map(key), recentBlockhash: key(5), instructions, addressTableLookups: version === 0 ? lookups : [] };
        const signatures = Array.from({ length: sigs + extraSigs }, (_, i) => (i === 0 ? base58Encode(new Uint8Array(64).fill(1)) : null));
        const bytes = encodeTransaction(signatures, message);
        const decoded = decodeTransaction(bytes);
        expect(decoded.message).toEqual(message);
        expect(decoded.signatures).toEqual(signatures);
        expect(encodeTransaction(decoded.signatures, decoded.message)).toEqual(bytes);
      }),
    );
  });
});
