import { describe, expect, it, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;
import { addMs, stepUpBindingHash, toInstant, type Instant, type OperatorPasskey, type StepUpChallenge, type StepUpEvidence, type Uuid } from '@sol-agent-trader/contracts';
import { verifyPasskeyRegistration, verifyStepUp, type RelyingParty } from './verify.js';

/**
 * A software authenticator: an ES256 key whose COSE public key is stored as the passkey, and a
 * function that signs a WebAuthn `get` assertion exactly as a real authenticator would. Every
 * negative case below is a mutation of one field of an otherwise valid ceremony.
 */

const RP: RelyingParty = { rpId: 'localhost', origins: ['http://localhost:3000'] };
const OPERATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Uuid;
const PASSKEY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Uuid;
const CHALLENGE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as Uuid;
const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));

const b64u = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');
const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await webcrypto.subtle.digest('SHA-256', b));

/** DER-encode a raw r||s ECDSA signature (WebAuthn carries DER; WebCrypto produces raw). */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if (((v[0] ?? 0) & 0x80) !== 0) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

interface Authenticator {
  credentialId: string;
  publicKeyCose: string;
  sign(opts: { challenge: string; signCount: number; origin?: string; rpId?: string; type?: string; flags?: number; key?: CryptoKey }): Promise<StepUpEvidence['response']>;
  otherKey: CryptoKey;
}

async function makeAuthenticator(): Promise<Authenticator> {
  const gen = () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = await gen();
  const other = await gen();
  const jwk = await webcrypto.subtle.exportKey('jwk', key.publicKey);
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  // COSE_Key for ES256: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
  const credentialId = b64u(webcrypto.getRandomValues(new Uint8Array(16)));

  return {
    credentialId,
    publicKeyCose: b64u(cose),
    otherKey: other.privateKey,
    async sign({ challenge, signCount, origin = 'http://localhost:3000', rpId = RP.rpId, type = 'webauthn.get', flags = 0x05, key: signingKey = key.privateKey }) {
      const rpIdHash = await sha256(new TextEncoder().encode(rpId));
      const counter = new Uint8Array(4);
      new DataView(counter.buffer).setUint32(0, signCount, false);
      const authData = new Uint8Array([...rpIdHash, flags, ...counter]);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const toSign = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
      const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, toSign));
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key' as const,
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(derSignature(raw)) },
        clientExtensionResults: {},
      };
    },
  };
}

const REQUEST = { requestedBy: OPERATOR, kind: 'ARM_RELEASE' as const, payload: { releaseId: '77777777-7777-4777-8777-777777777777', authority: 'LIVE_AUTO' } };

async function challengeFor(kind: typeof REQUEST.kind, payload: Record<string, unknown>, overrides: Partial<StepUpChallenge> = {}): Promise<StepUpChallenge> {
  return {
    id: CHALLENGE_ID,
    userId: OPERATOR,
    kind,
    bindingHash: await stepUpBindingHash(kind, payload),
    challenge: b64u(webcrypto.getRandomValues(new Uint8Array(32))),
    issuedAt: NOW,
    expiresAt: addMs(NOW, 5 * 60_000),
    consumedAt: null,
    ...overrides,
  };
}

function passkeyFor(auth: Authenticator, overrides: Partial<OperatorPasskey> = {}): OperatorPasskey {
  return {
    id: PASSKEY_ID,
    userId: OPERATOR,
    credentialId: auth.credentialId,
    publicKeyCose: auth.publicKeyCose,
    signCount: 4,
    transports: ['internal'],
    aaguid: null,
    backedUp: false,
    label: 'test key',
    createdAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('passkey step-up verification (D41, ADR-0006)', () => {
  let auth: Authenticator;
  beforeAll(async () => {
    auth = await makeAuthenticator();
  });

  async function run(mutate: {
    challenge?: Partial<StepUpChallenge>;
    passkey?: Partial<OperatorPasskey> | null;
    sign?: Partial<Parameters<Authenticator['sign']>[0]>;
    evidence?: (e: StepUpEvidence) => StepUpEvidence;
    request?: Partial<typeof REQUEST> & { payload?: Record<string, unknown> };
    now?: Instant;
  } = {}) {
    const challenge = await challengeFor(REQUEST.kind, REQUEST.payload, mutate.challenge);
    const response = await auth.sign({ challenge: challenge.challenge, signCount: 5, ...mutate.sign });
    let evidence: StepUpEvidence = { challengeId: challenge.id, credentialId: auth.credentialId, response };
    if (mutate.evidence) evidence = mutate.evidence(evidence);
    const passkey = mutate.passkey === null ? null : passkeyFor(auth, mutate.passkey);
    return verifyStepUp({ request: { ...REQUEST, ...mutate.request }, evidence, challenge, passkey, now: mutate.now ?? NOW, rp: RP });
  }

  it('accepts a genuine assertion for the exact request and reports the new sign count', async () => {
    const verdict = await run();
    expect(verdict).toEqual({ verified: true, passkeyId: PASSKEY_ID, newSignCount: 5 });
  });

  it('rejects a signature from a different key', async () => {
    const verdict = await run({ sign: { key: auth.otherKey } });
    expect(verdict.verified).toBe(false);
    if (!verdict.verified) expect(verdict.reason).toBe('ASSERTION_INVALID');
  });

  it('rejects an assertion over a different challenge than the one the database issued', async () => {
    const verdict = await run({ sign: { challenge: b64u(webcrypto.getRandomValues(new Uint8Array(32))) } });
    expect(verdict.verified).toBe(false);
  });

  it('rejects a foreign origin, a foreign RP ID and a non-get ceremony type', async () => {
    for (const sign of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { type: 'webauthn.create' }]) {
      const verdict = await run({ sign });
      expect(verdict.verified).toBe(false);
    }
  });

  it('requires user verification (UV flag), not just presence', async () => {
    const verdict = await run({ sign: { flags: 0x01 } });
    expect(verdict.verified).toBe(false);
  });

  it('rejects a cloned authenticator: sign count that does not advance', async () => {
    const verdict = await run({ sign: { signCount: 4 } });
    expect(verdict.verified).toBe(false);
  });

  it('binds to the exact request: a changed payload or kind fails before any crypto', async () => {
    expect(await run({ request: { payload: { ...REQUEST.payload, releaseId: '88888888-8888-4888-8888-888888888888' } } })).toEqual({ verified: false, reason: 'BINDING_MISMATCH' });
    expect(await run({ request: { kind: 'RESUME_NEW_ENTRIES' } as never })).toEqual({ verified: false, reason: 'KIND_MISMATCH' });
  });

  it('refuses consumed, expired and foreign challenges', async () => {
    expect(await run({ challenge: { consumedAt: NOW } })).toEqual({ verified: false, reason: 'CHALLENGE_CONSUMED' });
    expect(await run({ now: addMs(NOW, 5 * 60_000) })).toEqual({ verified: false, reason: 'CHALLENGE_EXPIRED' });
    expect(await run({ challenge: { userId: OTHER } })).toEqual({ verified: false, reason: 'CHALLENGE_USER_MISMATCH' });
  });

  it('refuses unknown, revoked and other-operator passkeys and credential id substitution', async () => {
    expect(await run({ passkey: null })).toEqual({ verified: false, reason: 'UNKNOWN_PASSKEY' });
    expect(await run({ passkey: { revokedAt: NOW } })).toEqual({ verified: false, reason: 'PASSKEY_REVOKED' });
    expect(await run({ passkey: { userId: OTHER } })).toEqual({ verified: false, reason: 'PASSKEY_USER_MISMATCH' });
    expect(await run({ evidence: (e) => ({ ...e, credentialId: 'c29tZW90aGVyY3JlZGVudGlhbA' }) })).toEqual({ verified: false, reason: 'CREDENTIAL_ID_MISMATCH' });
  });

  it('rejects garbage as a registration and enforces kind/challenge checks first', async () => {
    const challenge = await challengeFor('ARM_RELEASE', REQUEST.payload);
    const garbage = { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'AA', attestationObject: 'AA' }, clientExtensionResults: {} } as never;
    expect(await verifyPasskeyRegistration({ request: REQUEST, response: garbage, challenge, now: NOW, rp: RP })).toEqual({ verified: false, reason: 'KIND_MISMATCH' });
    const reg = { requestedBy: OPERATOR, kind: 'REGISTER_PASSKEY' as const, payload: {} };
    const regChallenge = await challengeFor('REGISTER_PASSKEY' as never, {}, { kind: 'REGISTER_PASSKEY' });
    const verdict = await verifyPasskeyRegistration({ request: reg, response: garbage, challenge: regChallenge, now: NOW, rp: RP });
    expect(verdict.verified).toBe(false);
    if (!verdict.verified) expect(verdict.reason).toBe('ASSERTION_INVALID');
  });
});
