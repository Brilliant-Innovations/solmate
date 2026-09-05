import { z } from 'zod';
import { Ed25519SignatureHex, Instant, KeyId, Sha256Hex } from '../primitives.js';
import { canonicalHash, canonicalize, utf8 } from './canonical.js';
import { signBytes, verifyBytes, type SigningKeyPair, type VerificationKey } from './ed25519.js';

/**
 * Generic signed envelope (blueprint D21, D52, §6.14, §6.14A, §6.15, §15.3).
 *
 * The signature covers the canonical JSON of `{ algorithm, keyId, payload, signedAt }`, so every
 * field of the payload and the signing metadata is bound. `payloadHash` is carried for indexing
 * and cross-referencing (e.g. an approval binds to an authorization by hash) and is re-derived on
 * verification, never trusted from storage.
 */

export const SIGNED_ENVELOPE_ALGORITHM = 'ed25519-canonical-json-sha256-v1' as const;

export const SignedEnvelopeMeta = z.strictObject({
  algorithm: z.literal(SIGNED_ENVELOPE_ALGORITHM),
  keyId: KeyId,
  signedAt: Instant,
  payloadHash: Sha256Hex,
  signature: Ed25519SignatureHex,
});
export type SignedEnvelopeMeta = z.infer<typeof SignedEnvelopeMeta>;

export function signedEnvelopeOf<T extends z.ZodType>(payload: T) {
  return SignedEnvelopeMeta.extend({ payload });
}

export interface SignedEnvelope<P> extends SignedEnvelopeMeta {
  payload: P;
}

function messageBytes(payload: unknown, keyId: KeyId, signedAt: Instant): Uint8Array {
  return utf8(canonicalize({ algorithm: SIGNED_ENVELOPE_ALGORITHM, keyId, payload, signedAt }));
}

export async function signPayload<P>(payload: P, key: SigningKeyPair, signedAt: Instant): Promise<SignedEnvelope<P>> {
  const payloadHash = await canonicalHash(payload);
  const signature = await signBytes(key.privateKey, messageBytes(payload, key.keyId, signedAt));
  return { algorithm: SIGNED_ENVELOPE_ALGORITHM, keyId: key.keyId, signedAt, payloadHash, signature, payload };
}

export type VerifyFailure =
  | 'UNKNOWN_KEY'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'MALFORMED_ENVELOPE';

export type VerifyResult = { ok: true; keyId: KeyId } | { ok: false; reason: VerifyFailure };

/**
 * Verifies an envelope against a set of accepted verification keys. The caller pins which keys
 * are accepted (e.g. the executor pins the risk-authorizer public key in deployment config,
 * §13.7); a key not in the set fails as UNKNOWN_KEY regardless of signature validity.
 */
export async function verifySignedEnvelope<P>(
  envelope: SignedEnvelope<P>,
  acceptedKeys: ReadonlyMap<KeyId, VerificationKey> | readonly VerificationKey[],
): Promise<VerifyResult> {
  if (envelope === null || typeof envelope !== 'object') return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  const { algorithm, keyId, signedAt, payloadHash, signature } = envelope as SignedEnvelope<unknown>;
  const meta = SignedEnvelopeMeta.safeParse({ algorithm, keyId, signedAt, payloadHash, signature });
  if (!meta.success) return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  const keys = Array.isArray(acceptedKeys) ? new Map(acceptedKeys.map((k) => [k.keyId, k])) : acceptedKeys;
  const key = (keys as ReadonlyMap<KeyId, VerificationKey>).get(meta.data.keyId);
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY' };
  let expectedHash: Sha256Hex;
  try {
    expectedHash = await canonicalHash(envelope.payload);
  } catch {
    return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  }
  if (expectedHash !== meta.data.payloadHash) return { ok: false, reason: 'PAYLOAD_HASH_MISMATCH' };
  const valid = await verifyBytes(
    key.publicKey,
    messageBytes(envelope.payload, meta.data.keyId, meta.data.signedAt),
    meta.data.signature,
  );
  return valid ? { ok: true, keyId: meta.data.keyId } : { ok: false, reason: 'BAD_SIGNATURE' };
}
