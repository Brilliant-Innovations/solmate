import { describe, expect, it, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  addMs,
  FIRST_PASSKEY_COOLING_MS,
  stepUpBindingHash,
  toInstant,
  type ControlRequestKind,
  type Instant,
  type OperatorPasskey,
  type StepUpChallenge,
  type StepUpEvidence,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { verifyPasskeyRegistration, verifyStepUp, type RelyingParty, type StepUpVerdict } from './verify.js';

type CryptoKey = webcrypto.CryptoKey;

/**
 * A software authenticator: an ES256 key whose COSE public key is stored as the passkey, and
 * functions that produce WebAuthn `create` and `get` ceremonies exactly as a real authenticator
 * would (fmt "none" attestation, DER signatures). Every negative case below is a mutation of one
 * field of an otherwise valid ceremony.
 */

const RP: RelyingParty = { rpId: 'localhost', origins: ['http://localhost:3000'] };
const ORIGIN = 'http://localhost:3000';
const OPERATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Uuid;
const PASSKEY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Uuid;
const CHALLENGE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as Uuid;
const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));

const b64u = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');
const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await webcrypto.subtle.digest('SHA-256', b));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

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

/** CBOR text string header for short ASCII keys. */
const cborText = (s: string): number[] => [0x60 + s.length, ...utf8(s)];

interface SignOpts {
  challenge: string;
  signCount: number;
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  key?: CryptoKey;
}

interface Authenticator {
  credentialId: string;
  credentialIdBytes: Uint8Array;
  publicKeyCose: string;
  coseBytes: Uint8Array;
  otherKey: CryptoKey;
  sign(opts: SignOpts): Promise<StepUpEvidence['response']>;
  /** A `webauthn.create` ceremony with fmt "none" attestation. */
  create(opts: { challenge: string; origin?: string; flags?: number }): Promise<Record<string, unknown>>;
}

async function makeAuthenticator(): Promise<Authenticator> {
  const gen = () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = await gen();
  const other = await gen();
  const jwk = await webcrypto.subtle.exportKey('jwk', key.publicKey);
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  // COSE_Key for ES256: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const coseBytes = new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
  const credentialIdBytes = webcrypto.getRandomValues(new Uint8Array(16));
  const credentialId = b64u(credentialIdBytes);

  async function authData(rpId: string, flags: number, signCount: number, attested: boolean): Promise<Uint8Array> {
    const rpIdHash = await sha256(utf8(rpId));
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, signCount, false);
    const base = [...rpIdHash, flags, ...counter];
    if (!attested) return new Uint8Array(base);
    const aaguid = new Uint8Array(16);
    const len = new Uint8Array([0, credentialIdBytes.length]);
    return new Uint8Array([...base, ...aaguid, ...len, ...credentialIdBytes, ...coseBytes]);
  }

  return {
    credentialId,
    credentialIdBytes,
    publicKeyCose: b64u(coseBytes),
    coseBytes,
    otherKey: other.privateKey,
    async sign({ challenge, signCount, origin = ORIGIN, rpId = RP.rpId, type = 'webauthn.get', flags = 0x05, key: signingKey = key.privateKey }) {
      const ad = await authData(rpId, flags, signCount, false);
      const clientDataJSON = utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const toSign = new Uint8Array([...ad, ...(await sha256(clientDataJSON))]);
      const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, toSign));
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key' as const,
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(derSignature(raw)) },
        clientExtensionResults: {},
      };
    },
    async create({ challenge, origin = ORIGIN, flags = 0x45 }) {
      const ad = await authData(RP.rpId, flags, 0, true);
      const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      // CBOR map {"fmt": "none", "attStmt": {}, "authData": <bytes>}
      const lenHeader = ad.length < 256 ? [0x58, ad.length] : [0x59, ad.length >> 8, ad.length & 0xff];
      const attestationObject = new Uint8Array([0xa3, ...cborText('fmt'), ...cborText('none'), ...cborText('attStmt'), 0xa0, ...cborText('authData'), ...lenHeader, ...ad]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
      };
    },
  };
}

const REQUEST = { requestedBy: OPERATOR, kind: 'ARM_RELEASE' as const, payload: { releaseId: '77777777-7777-4777-8777-777777777777', authority: 'LIVE_AUTO' } };

async function challengeFor(kind: ControlRequestKind, payload: Record<string, unknown>, overrides: Partial<StepUpChallenge> = {}): Promise<StepUpChallenge> {
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
    usableFrom: NOW,
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
    sign?: Partial<SignOpts>;
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
    expect(await run()).toEqual({ verified: true, passkeyId: PASSKEY_ID, newSignCount: 5 });
  });

  it('accepts the evidence even when the payload also carries the evidence keys (bound payload, R2-09)', async () => {
    const challenge = await challengeFor(REQUEST.kind, REQUEST.payload);
    const response = await auth.sign({ challenge: challenge.challenge, signCount: 5 });
    const evidence: StepUpEvidence = { challengeId: challenge.id, credentialId: auth.credentialId, response };
    const request = { ...REQUEST, payload: { ...REQUEST.payload, stepUp: evidence } };
    expect((await verifyStepUp({ request, evidence, challenge, passkey: passkeyFor(auth), now: NOW, rp: RP })).verified).toBe(true);
  });

  it('rejects a signature from a different key', async () => {
    const verdict = await run({ sign: { key: auth.otherKey } });
    expect(verdict.verified).toBe(false);
    if (!verdict.verified) expect(verdict.reason).toBe('ASSERTION_INVALID');
  });

  it('rejects an assertion over a different challenge than the one the database issued', async () => {
    expect((await run({ sign: { challenge: b64u(webcrypto.getRandomValues(new Uint8Array(32))) } })).verified).toBe(false);
  });

  it('rejects a foreign origin, a foreign RP ID and a non-get ceremony type', async () => {
    for (const sign of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { type: 'webauthn.create' }]) {
      expect((await run({ sign })).verified).toBe(false);
    }
  });

  it('requires user verification (UV flag), not just presence', async () => {
    expect((await run({ sign: { flags: 0x01 } })).verified).toBe(false);
  });

  it('rejects a cloned authenticator: sign count that does not advance; documents the 0/0 platform-passkey case', async () => {
    expect((await run({ sign: { signCount: 4 } })).verified).toBe(false);
    // Platform passkeys that never count: SimpleWebAuthn skips the counter check only when both are 0.
    expect((await run({ passkey: { signCount: 0 }, sign: { signCount: 0 } })).verified).toBe(true);
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

  it('refuses unknown, revoked, cooling and other-operator passkeys and credential id substitution', async () => {
    expect(await run({ passkey: null })).toEqual({ verified: false, reason: 'UNKNOWN_PASSKEY' });
    expect(await run({ passkey: { revokedAt: NOW } })).toEqual({ verified: false, reason: 'PASSKEY_REVOKED' });
    expect(await run({ passkey: { usableFrom: addMs(NOW, 1) } })).toEqual({ verified: false, reason: 'PASSKEY_COOLING' });
    expect((await run({ passkey: { usableFrom: NOW } })).verified).toBe(true);
    expect(await run({ passkey: { userId: OTHER } })).toEqual({ verified: false, reason: 'PASSKEY_USER_MISMATCH' });
    expect(await run({ evidence: (e) => ({ ...e, credentialId: 'c29tZW90aGVyY3JlZGVudGlhbA' }) })).toEqual({ verified: false, reason: 'CREDENTIAL_ID_MISMATCH' });
    expect(await run({ evidence: (e) => ({ ...e, response: { ...e.response, rawId: 'c29tZW90aGVyY3JlZGVudGlhbA' } }) })).toEqual({ verified: false, reason: 'CREDENTIAL_ID_MISMATCH' });
  });
});

describe('passkey registration (R2-01, R2-08)', () => {
  const REG = { requestedBy: OPERATOR, kind: 'REGISTER_PASSKEY' as const, payload: { label: 'laptop' } };
  let auth: Authenticator;
  beforeAll(async () => {
    auth = await makeAuthenticator();
  });

  it('a genuine first registration yields a stored credential that verifies later assertions, with a cooling period', async () => {
    const challenge = await challengeFor(REG.kind, REG.payload);
    const response = (await auth.create({ challenge: challenge.challenge })) as never;
    const verdict = await verifyPasskeyRegistration({ request: REG, response, challenge, activePasskeys: 0, existingPasskeyVerdict: null, now: NOW, rp: RP });
    expect(verdict.verified).toBe(true);
    if (!verdict.verified) return;
    expect(verdict.credential.credentialId).toBe(auth.credentialId);
    expect(verdict.credential.publicKeyCose).toBe(auth.publicKeyCose);
    expect(verdict.credential.signCount).toBe(0);
    expect(verdict.credential.transports).toEqual(['internal']);
    expect(verdict.credential.aaguid).toBeNull();
    expect(verdict.credential.backedUp).toBe(false);
    expect(verdict.credential.usableFrom).toBe(addMs(NOW, FIRST_PASSKEY_COOLING_MS));

    // Round trip: the stored credential accepts a genuine assertion once the cooling period is over.
    const stored = passkeyFor(auth, { credentialId: verdict.credential.credentialId, publicKeyCose: verdict.credential.publicKeyCose, signCount: 0, usableFrom: verdict.credential.usableFrom });
    const later = addMs(NOW, FIRST_PASSKEY_COOLING_MS);
    const armChallenge = await challengeFor(REQUEST.kind, REQUEST.payload, { issuedAt: later, expiresAt: addMs(later, 60_000) });
    const evidence: StepUpEvidence = { challengeId: armChallenge.id, credentialId: auth.credentialId, response: await auth.sign({ challenge: armChallenge.challenge, signCount: 1 }) };
    expect(await verifyStepUp({ request: REQUEST, evidence, challenge: armChallenge, passkey: stored, now: later, rp: RP })).toEqual({ verified: true, passkeyId: PASSKEY_ID, newSignCount: 1 });
    expect(await verifyStepUp({ request: REQUEST, evidence, challenge: armChallenge, passkey: stored, now: addMs(later, -1), rp: RP })).toEqual({ verified: false, reason: 'PASSKEY_COOLING' });
  });

  it('a further passkey needs a verified assertion from an existing one and gets no cooling period', async () => {
    const challenge = await challengeFor(REG.kind, REG.payload);
    const response = (await auth.create({ challenge: challenge.challenge })) as never;
    const base = { request: REG, response, challenge, now: NOW, rp: RP };
    expect(await verifyPasskeyRegistration({ ...base, activePasskeys: 1, existingPasskeyVerdict: null })).toEqual({ verified: false, reason: 'STEP_UP_REQUIRED' });
    const failed: StepUpVerdict = { verified: false, reason: 'ASSERTION_INVALID' };
    expect(await verifyPasskeyRegistration({ ...base, activePasskeys: 1, existingPasskeyVerdict: failed })).toEqual({ verified: false, reason: 'STEP_UP_REQUIRED' });
    const ok: StepUpVerdict = { verified: true, passkeyId: PASSKEY_ID, newSignCount: 9 };
    const verdict = await verifyPasskeyRegistration({ ...base, activePasskeys: 1, existingPasskeyVerdict: ok });
    expect(verdict.verified).toBe(true);
    if (verdict.verified) expect(verdict.credential.usableFrom).toBe(NOW);
  });

  it('rejects a registration without user verification, from a foreign origin, or with a foreign challenge', async () => {
    const challenge = await challengeFor(REG.kind, REG.payload);
    const base = { request: REG, challenge, activePasskeys: 0, existingPasskeyVerdict: null, now: NOW, rp: RP };
    expect((await verifyPasskeyRegistration({ ...base, response: (await auth.create({ challenge: challenge.challenge, flags: 0x41 })) as never })).verified).toBe(false);
    expect((await verifyPasskeyRegistration({ ...base, response: (await auth.create({ challenge: challenge.challenge, origin: 'https://evil.example' })) as never })).verified).toBe(false);
    expect((await verifyPasskeyRegistration({ ...base, response: (await auth.create({ challenge: b64u(webcrypto.getRandomValues(new Uint8Array(32))) })) as never })).verified).toBe(false);
  });

  it('rejects garbage and enforces kind/challenge checks first', async () => {
    const garbage = { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'AA', attestationObject: 'AA' }, clientExtensionResults: {} } as never;
    const armChallenge = await challengeFor('ARM_RELEASE', REQUEST.payload);
    expect(await verifyPasskeyRegistration({ request: REQUEST, response: garbage, challenge: armChallenge, activePasskeys: 0, existingPasskeyVerdict: null, now: NOW, rp: RP })).toEqual({ verified: false, reason: 'KIND_MISMATCH' });
    const regChallenge = await challengeFor(REG.kind, REG.payload);
    const verdict = await verifyPasskeyRegistration({ request: REG, response: garbage, challenge: regChallenge, activePasskeys: 0, existingPasskeyVerdict: null, now: NOW, rp: RP });
    expect(verdict.verified).toBe(false);
    if (!verdict.verified) expect(verdict.reason).toBe('ASSERTION_INVALID');
  });
});
