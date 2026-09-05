import { Ed25519PublicKeyHex, Ed25519SignatureHex, KeyId } from '../primitives.js';
import { bytesToHex, hexToBytes, sha256Hex } from './canonical.js';

/**
 * Ed25519 signing over WebCrypto. Isomorphic (Node 24 and browsers) with no native dependency.
 * Key types are derived from `globalThis.crypto.subtle` so the module type-checks identically
 * under Node's and the DOM's WebCrypto declarations.
 *
 * These keys sign application envelopes only: risk authorizations, risk-state projections,
 * approvals, emergency commands and journal entries. They are never Solana wallet keys; the
 * trading wallet key lives inside the non-exportable signer backend (D47) and is never handled
 * by this module.
 */

type Subtle = typeof globalThis.crypto.subtle;
export type CryptoKey = Parameters<Subtle['sign']>[1];
type GenerateKeyResult = Awaited<ReturnType<Subtle['generateKey']>>;
type CryptoKeyPair = Extract<GenerateKeyResult, { publicKey: unknown; privateKey: unknown }>;
type BufferSource = Parameters<Subtle['digest']>[1];

const ALG = { name: 'Ed25519' } as const;

export interface VerificationKey {
  readonly keyId: KeyId;
  readonly publicKey: CryptoKey;
  readonly publicKeyHex: Ed25519PublicKeyHex;
}

export interface SigningKeyPair extends VerificationKey {
  readonly privateKey: CryptoKey;
}

const subtle = (): Subtle => globalThis.crypto.subtle;
const asSource = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource;

export async function keyIdFromPublicKeyHex(publicKeyHex: string): Promise<KeyId> {
  const h = await sha256Hex(hexToBytes(publicKeyHex));
  return KeyId.parse(`ed25519:${h.slice(0, 32)}`);
}

export async function exportPublicKeyHex(publicKey: CryptoKey): Promise<Ed25519PublicKeyHex> {
  const raw = new Uint8Array(await subtle().exportKey('raw', publicKey));
  return Ed25519PublicKeyHex.parse(bytesToHex(raw));
}

export async function importVerificationKey(publicKeyHex: string): Promise<VerificationKey> {
  const hex = Ed25519PublicKeyHex.parse(publicKeyHex);
  const publicKey = await subtle().importKey('raw', asSource(hexToBytes(hex)), ALG, true, ['verify']);
  return { keyId: await keyIdFromPublicKeyHex(hex), publicKey, publicKeyHex: hex };
}

export async function generateSigningKeyPair(extractable = false): Promise<SigningKeyPair> {
  const pair = (await subtle().generateKey(ALG, extractable, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKeyHex = await exportPublicKeyHex(pair.publicKey);
  return {
    keyId: await keyIdFromPublicKeyHex(publicKeyHex),
    publicKey: pair.publicKey,
    publicKeyHex,
    privateKey: pair.privateKey,
  };
}

/** PKCS#8 export for persisting a signing key in a role-scoped secret store. Requires an extractable key. */
export async function exportPrivateKeyPkcs8Hex(privateKey: CryptoKey): Promise<string> {
  return bytesToHex(new Uint8Array(await subtle().exportKey('pkcs8', privateKey)));
}

export async function importSigningKeyPair(pkcs8Hex: string, publicKeyHex: string): Promise<SigningKeyPair> {
  const privateKey = await subtle().importKey('pkcs8', asSource(hexToBytes(pkcs8Hex)), ALG, false, ['sign']);
  const verification = await importVerificationKey(publicKeyHex);
  return { ...verification, privateKey };
}

export async function signBytes(privateKey: CryptoKey, message: Uint8Array): Promise<Ed25519SignatureHex> {
  const sig = new Uint8Array(await subtle().sign(ALG, privateKey, asSource(message)));
  return Ed25519SignatureHex.parse(bytesToHex(sig));
}

export async function verifyBytes(publicKey: CryptoKey, message: Uint8Array, signatureHex: string): Promise<boolean> {
  const parsed = Ed25519SignatureHex.safeParse(signatureHex);
  if (!parsed.success) return false;
  try {
    return await subtle().verify(ALG, publicKey, asSource(hexToBytes(parsed.data)), asSource(message));
  } catch {
    return false;
  }
}
