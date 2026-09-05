import fc from 'fast-check';
import { Instant, KeyId } from '../primitives.js';
import { canonicalHash, canonicalize } from './canonical.js';
import {
  exportPrivateKeyPkcs8Hex,
  generateSigningKeyPair,
  importSigningKeyPair,
  importVerificationKey,
  keyIdFromPublicKeyHex,
  signBytes,
  verifyBytes,
} from './ed25519.js';
import { signPayload, verifySignedEnvelope } from './signed-envelope.js';

const T0 = Instant.parse('2026-09-05T12:00:00.000Z');
const T1 = Instant.parse('2026-09-05T12:00:01.000Z');

/** JSON-representable object payloads: string keys, JSON leaf values, nested. */
const safeKey = fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== '__proto__');
const jsonObject = fc.dictionary(safeKey, fc.jsonValue({ maxDepth: 3 }), { minKeys: 1, maxKeys: 8 });

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    fc.assert(
      fc.property(jsonObject, (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalize(reversed)).toBe(canonicalize(obj));
      }),
    );
  });

  it('drops undefined members and renders bigint as a decimal string', () => {
    expect(canonicalize({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalize({ q: 12345678901234567890n })).toBe('{"q":"12345678901234567890"}');
  });

  it('rejects values whose serialization would be platform dependent', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ d: new Date() })).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
  });

  it('hashes equal canonical forms equally and different forms differently', async () => {
    await fc.assert(
      fc.asyncProperty(jsonObject, jsonObject, async (a, b) => {
        const [ha, hb] = await Promise.all([canonicalHash(a), canonicalHash(b)]);
        expect(ha === hb).toBe(canonicalize(a) === canonicalize(b));
      }),
      { numRuns: 60 },
    );
  });
});

describe('ed25519', () => {
  it('derives a stable key id from the public key and round-trips PKCS#8', async () => {
    const key = await generateSigningKeyPair(true);
    expect(key.keyId).toMatch(/^ed25519:[0-9a-f]{32}$/);
    expect(await keyIdFromPublicKeyHex(key.publicKeyHex)).toBe(key.keyId);
    const restored = await importSigningKeyPair(await exportPrivateKeyPkcs8Hex(key.privateKey), key.publicKeyHex);
    expect(restored.keyId).toBe(key.keyId);
    const msg = new TextEncoder().encode('hello');
    expect(await verifyBytes(key.publicKey, msg, await signBytes(restored.privateKey, msg))).toBe(true);
  });

  it('rejects a signature from a different key or over different bytes', async () => {
    const [a, b] = await Promise.all([generateSigningKeyPair(), generateSigningKeyPair()]);
    const msg = new TextEncoder().encode('payload');
    const sig = await signBytes(a.privateKey, msg);
    expect(await verifyBytes(b.publicKey, msg, sig)).toBe(false);
    expect(await verifyBytes(a.publicKey, new TextEncoder().encode('payload!'), sig)).toBe(false);
    expect(await verifyBytes(a.publicKey, msg, 'not-hex')).toBe(false);
  });
});

describe('signed envelope (INV-06 / INV-10 binding mechanism)', () => {
  it('verifies an untampered envelope against an accepted key', async () => {
    const key = await generateSigningKeyPair();
    const env = await signPayload({ amount: '1000', mint: 'So11111111111111111111111111111111111111112' }, key, T0);
    const verifier = await importVerificationKey(key.publicKeyHex);
    expect(await verifySignedEnvelope(env, [verifier])).toEqual({ ok: true, keyId: key.keyId });
  });

  it('any change to any payload field after signing is detected', async () => {
    const key = await generateSigningKeyPair();
    const verifier = await importVerificationKey(key.publicKeyHex);
    await fc.assert(
      fc.asyncProperty(jsonObject, safeKey, fc.jsonValue(), async (payload, k, v) => {
        const tampered = { ...payload, [k]: v };
        fc.pre(canonicalize(tampered) !== canonicalize(payload));
        const env = await signPayload(payload, key, T0);
        const res = await verifySignedEnvelope({ ...env, payload: tampered }, [verifier]);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(['PAYLOAD_HASH_MISMATCH', 'BAD_SIGNATURE']).toContain(res.reason);
      }),
      { numRuns: 60 },
    );
  });

  it('a forged payloadHash cannot rescue a tampered payload (signature covers the payload itself)', async () => {
    const key = await generateSigningKeyPair();
    const verifier = await importVerificationKey(key.publicKeyHex);
    const env = await signPayload({ maxInput: '100' }, key, T0);
    const tampered = { maxInput: '100000' };
    const res = await verifySignedEnvelope(
      { ...env, payload: tampered, payloadHash: await canonicalHash(tampered) },
      [verifier],
    );
    expect(res).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('changing signedAt, keyId or signature fails; an unknown key is rejected before signature checks', async () => {
    const [key, other] = await Promise.all([generateSigningKeyPair(), generateSigningKeyPair()]);
    const verifier = await importVerificationKey(key.publicKeyHex);
    const env = await signPayload({ x: 1 }, key, T0);
    expect(await verifySignedEnvelope({ ...env, signedAt: T1 }, [verifier])).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const flipped = env.signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) as typeof env.signature;
    expect(await verifySignedEnvelope({ ...env, signature: flipped }, [verifier])).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    expect(await verifySignedEnvelope({ ...env, keyId: other.keyId }, [verifier])).toEqual({ ok: false, reason: 'UNKNOWN_KEY' });
    expect(await verifySignedEnvelope(env, [await importVerificationKey(other.publicKeyHex)])).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
    expect(await verifySignedEnvelope({ ...env, keyId: 'bogus' as KeyId }, [verifier])).toEqual({
      ok: false,
      reason: 'MALFORMED_ENVELOPE',
    });
  });
});
