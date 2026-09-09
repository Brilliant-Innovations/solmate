import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';

/**
 * Turnkey API-key request stamping (blueprint §15.7; provider API overview "Stamps").
 *
 * The raw JSON request body is signed with the API key's curve — P-256 for the key class we use —
 * DER-encoded and hex-encoded. The stamp is `{publicKey, scheme, signature}` as JSON, base64url
 * encoded into the `X-Stamp` header.
 *
 * Implemented on `node:crypto` rather than the provider SDK on purpose: this is authentication, not
 * transaction interpretation, and the executor is the one deployable where an added runtime package
 * is a reviewed change (GUARDRAILS Part 4). Nothing here decides *what* is signed — that is the
 * signer policy — so the code that can be wrong is bounded and directly testable, and the
 * constructor proves the configured key pair is internally consistent before the process serves a
 * single request.
 */

export class TurnkeyStampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnkeyStampError';
  }
}

export type TurnkeySignatureScheme = 'SIGNATURE_SCHEME_TK_API_P256';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const hexToBytes = (hex: string): Uint8Array => {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new TurnkeyStampError('expected whole-byte hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const b64url = (bytes: Uint8Array | string): string => Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64url');
const toField = (v: bigint): string => b64url(hexToBytes(v.toString(16).padStart(64, '0')));

/**
 * Recovers (x, y) from a SEC1 compressed point. P-256's prime is 3 mod 4, so the square root is a
 * single exponentiation and the prefix byte picks the parity. An uncompressed point is accepted as
 * given. This is what lets the private scalar become a JWK without an elliptic-curve dependency.
 */
export function decompressP256(publicKeyHex: string): { x: bigint; y: bigint } {
  const bytes = hexToBytes(publicKeyHex);
  if (bytes.length === 65 && bytes[0] === 0x04) {
    return { x: BigInt('0x' + publicKeyHex.slice(2, 66)), y: BigInt('0x' + publicKeyHex.slice(66)) };
  }
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) throw new TurnkeyStampError(`not a P-256 public key: ${bytes.length} byte(s)`);
  const x = BigInt('0x' + publicKeyHex.slice(2));
  const alpha = (powMod(x, 3n, P) - 3n * x + B) % P;
  let y = powMod((alpha + P) % P, (P + 1n) / 4n, P);
  if (powMod(y, 2n, P) !== (alpha + P) % P) throw new TurnkeyStampError('public key is not on the P-256 curve');
  const wantOdd = bytes[0] === 0x03;
  if ((y & 1n) === 1n !== wantOdd) y = P - y;
  return { x, y };
}

export interface TurnkeyStamper {
  readonly publicKeyHex: string;
  readonly scheme: TurnkeySignatureScheme;
  /** The `X-Stamp` header value for this exact body string. */
  stamp(body: string): string;
}

/**
 * `apiPrivateKeyHex` is the 32-byte scalar Turnkey issues; a PKCS#8 DER hex blob is accepted too so
 * an operator who exported the key in that form is not forced to reshape it by hand.
 */
export function createTurnkeyStamper(apiPublicKeyHex: string, apiPrivateKeyHex: string): TurnkeyStamper {
  const pub = apiPublicKeyHex.trim().toLowerCase();
  const priv = apiPrivateKeyHex.trim().toLowerCase();
  const { x, y } = decompressP256(pub);
  let key: KeyObject;
  if (priv.length === 64) {
    key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: toField(x), y: toField(y), d: b64url(hexToBytes(priv)) }, format: 'jwk' });
  } else {
    key = createPrivateKey({ key: Buffer.from(hexToBytes(priv)), format: 'der', type: 'pkcs8' });
  }
  // Refuse a mismatched pair at construction rather than on the first signature the executor needs.
  const probe = Buffer.from('turnkey-stamper-self-check', 'utf8');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toField(x), y: toField(y) }, format: 'jwk' });
  if (!nodeVerify('sha256', probe, publicKey, nodeSign('sha256', probe, key))) {
    throw new TurnkeyStampError('the configured Turnkey API private key does not match the configured public key');
  }
  return {
    publicKeyHex: pub,
    scheme: 'SIGNATURE_SCHEME_TK_API_P256',
    stamp(body: string): string {
      const signature = Buffer.from(nodeSign('sha256', Buffer.from(body, 'utf8'), key)).toString('hex');
      return b64url(JSON.stringify({ publicKey: pub, scheme: 'SIGNATURE_SCHEME_TK_API_P256', signature }));
    },
  };
}

/** Verifies a stamp against the body it claims to cover; the harness and the stamper's own tests use it. */
export function verifyTurnkeyStamp(headerValue: string, body: string): { ok: boolean; publicKeyHex: string | null } {
  try {
    const parsed = JSON.parse(Buffer.from(headerValue, 'base64url').toString('utf8')) as { publicKey?: unknown; scheme?: unknown; signature?: unknown };
    if (typeof parsed.publicKey !== 'string' || typeof parsed.signature !== 'string' || parsed.scheme !== 'SIGNATURE_SCHEME_TK_API_P256') return { ok: false, publicKeyHex: null };
    const { x, y } = decompressP256(parsed.publicKey);
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toField(x), y: toField(y) }, format: 'jwk' });
    return { ok: nodeVerify('sha256', Buffer.from(body, 'utf8'), publicKey, Buffer.from(hexToBytes(parsed.signature))), publicKeyHex: parsed.publicKey };
  } catch {
    return { ok: false, publicKeyHex: null };
  }
}
