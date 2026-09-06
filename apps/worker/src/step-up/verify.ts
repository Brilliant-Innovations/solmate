import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  addMs,
  compareInstants,
  FIRST_PASSKEY_COOLING_MS,
  stepUpBindingHash,
  WebAuthnTransport,
  type ControlRequestKind,
  type Instant,
  type OperatorPasskey,
  type StepUpChallenge,
  type StepUpEvidence,
  type Uuid,
} from '@sol-agent-trader/contracts';

/**
 * Passkey step-up verification (blueprint D41, §15.6; ADR-0006 and its review amendment).
 *
 * Runs in the worker only. Every check here is deterministic and fails closed: the browser's
 * evidence is trusted for nothing until the stored challenge, the stored passkey and the exact
 * control request agree with it and SimpleWebAuthn accepts the signature. Time comes in as an
 * Instant from the caller's Clock (§18.2).
 *
 * Caller contract (R2-04): after a verdict, the caller MUST call
 * `ops.consume_step_up_challenge(challengeId, passkeyId, verified, failureReason, controlRequestId)`
 * and act on the control request only if that call returns a row. The function consumes the
 * challenge and records the assertion atomically; a concurrent worker gets `CHALLENGE_UNAVAILABLE`
 * and must treat the request as not authorised. A verified verdict alone authorises nothing.
 */

export interface RelyingParty {
  /** WebAuthn RP ID, e.g. `solmate-zeta.vercel.app` or `localhost`. */
  rpId: string;
  /** Exact origins allowed to run the ceremony, e.g. `https://solmate-zeta.vercel.app`. */
  origins: readonly string[];
}

export type StepUpFailure =
  | 'CHALLENGE_USER_MISMATCH'
  | 'CHALLENGE_CONSUMED'
  | 'CHALLENGE_EXPIRED'
  | 'KIND_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'UNKNOWN_PASSKEY'
  | 'PASSKEY_USER_MISMATCH'
  | 'PASSKEY_REVOKED'
  /** first passkey still inside FIRST_PASSKEY_COOLING_MS (R2-01) */
  | 'PASSKEY_COOLING'
  | 'CREDENTIAL_ID_MISMATCH'
  /** registration of a further passkey without an assertion from an existing one (R2-01) */
  | 'STEP_UP_REQUIRED'
  | 'ASSERTION_INVALID';

export type StepUpVerdict =
  | { verified: true; passkeyId: Uuid; newSignCount: number }
  | { verified: false; reason: StepUpFailure; detail?: string };

export interface ControlRequestUnderReview {
  requestedBy: Uuid;
  kind: ControlRequestKind;
  payload: Record<string, unknown>;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, 'base64url');
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

/** Checks shared by assertion and registration: the challenge must be this user's, live, and for this exact request. */
async function checkChallenge(challenge: StepUpChallenge, request: ControlRequestUnderReview, now: Instant): Promise<StepUpFailure | null> {
  if (challenge.userId !== request.requestedBy) return 'CHALLENGE_USER_MISMATCH';
  if (challenge.consumedAt !== null) return 'CHALLENGE_CONSUMED';
  if (compareInstants(now, challenge.expiresAt) >= 0) return 'CHALLENGE_EXPIRED';
  if (challenge.kind !== request.kind) return 'KIND_MISMATCH';
  const expected = await stepUpBindingHash(request.kind, request.payload);
  if (expected !== challenge.bindingHash) return 'BINDING_MISMATCH';
  return null;
}

export async function verifyStepUp(input: {
  request: ControlRequestUnderReview;
  evidence: StepUpEvidence;
  challenge: StepUpChallenge;
  /** The passkey row looked up by `evidence.credentialId`, or null when none exists. */
  passkey: OperatorPasskey | null;
  now: Instant;
  rp: RelyingParty;
}): Promise<StepUpVerdict> {
  const { request, evidence, challenge, passkey, now, rp } = input;

  const challengeFailure = await checkChallenge(challenge, request, now);
  if (challengeFailure) return { verified: false, reason: challengeFailure };

  if (!passkey) return { verified: false, reason: 'UNKNOWN_PASSKEY' };
  if (passkey.userId !== request.requestedBy) return { verified: false, reason: 'PASSKEY_USER_MISMATCH' };
  if (passkey.revokedAt !== null) return { verified: false, reason: 'PASSKEY_REVOKED' };
  if (compareInstants(now, passkey.usableFrom) < 0) return { verified: false, reason: 'PASSKEY_COOLING' };
  if (evidence.credentialId !== passkey.credentialId || evidence.response.id !== passkey.credentialId || evidence.response.rawId !== passkey.credentialId) {
    return { verified: false, reason: 'CREDENTIAL_ID_MISMATCH' };
  }

  try {
    const result = await verifyAuthenticationResponse({
      response: evidence.response as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...rp.origins],
      expectedRPID: rp.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: b64urlToBytes(passkey.publicKeyCose),
        counter: passkey.signCount,
        transports: [...passkey.transports],
      },
      requireUserVerification: true,
    });
    if (!result.verified) return { verified: false, reason: 'ASSERTION_INVALID' };
    return { verified: true, passkeyId: passkey.id, newSignCount: result.authenticationInfo.newCounter };
  } catch (err) {
    return { verified: false, reason: 'ASSERTION_INVALID', detail: err instanceof Error ? err.message : String(err) };
  }
}

export type RegistrationVerdict =
  | {
      verified: true;
      credential: {
        credentialId: string;
        publicKeyCose: string;
        signCount: number;
        transports: WebAuthnTransport[];
        aaguid: string | null;
        backedUp: boolean;
        /** now + FIRST_PASSKEY_COOLING_MS for a first passkey; now otherwise. */
        usableFrom: Instant;
      };
    }
  | { verified: false; reason: StepUpFailure; detail?: string };

/**
 * Registration of a new passkey (kind REGISTER_PASSKEY). The RLS layer already required an aal2
 * session and, for a first passkey, a fresh TOTP. Here: a further passkey needs a verified
 * assertion from an existing one (`existingPasskeyVerdict`), and a first passkey gets a cooling
 * period. Duplicate credential ids are rejected by the database unique constraint (23505); the
 * caller surfaces that as a rejection.
 */
export async function verifyPasskeyRegistration(input: {
  request: ControlRequestUnderReview;
  response: RegistrationResponseJSON;
  challenge: StepUpChallenge;
  /** Non-revoked passkeys the operator already has. */
  activePasskeys: number;
  /** Verdict of `verifyStepUp` over `payload.stepUp` with the same challenge, when activePasskeys > 0. */
  existingPasskeyVerdict: StepUpVerdict | null;
  now: Instant;
  rp: RelyingParty;
}): Promise<RegistrationVerdict> {
  const { request, response, challenge, activePasskeys, existingPasskeyVerdict, now, rp } = input;
  if (request.kind !== 'REGISTER_PASSKEY') return { verified: false, reason: 'KIND_MISMATCH' };
  const challengeFailure = await checkChallenge(challenge, request, now);
  if (challengeFailure) return { verified: false, reason: challengeFailure };
  if (activePasskeys > 0 && !(existingPasskeyVerdict && existingPasskeyVerdict.verified)) {
    return { verified: false, reason: 'STEP_UP_REQUIRED' };
  }

  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...rp.origins],
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) return { verified: false, reason: 'ASSERTION_INVALID' };
    const info = result.registrationInfo;
    const transports = (info.credential.transports ?? []).filter((t): t is WebAuthnTransport => WebAuthnTransport.safeParse(t).success);
    const aaguid = /^[0-9a-f-]{36}$/i.test(info.aaguid) && info.aaguid !== '00000000-0000-0000-0000-000000000000' ? info.aaguid : null;
    return {
      verified: true,
      credential: {
        credentialId: info.credential.id,
        publicKeyCose: bytesToB64url(info.credential.publicKey),
        signCount: info.credential.counter,
        transports,
        aaguid,
        backedUp: info.credentialBackedUp,
        usableFrom: activePasskeys === 0 ? addMs(now, FIRST_PASSKEY_COOLING_MS) : now,
      },
    };
  } catch (err) {
    return { verified: false, reason: 'ASSERTION_INVALID', detail: err instanceof Error ? err.message : String(err) };
  }
}
