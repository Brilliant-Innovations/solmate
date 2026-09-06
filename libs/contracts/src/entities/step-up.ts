import { z } from 'zod';
import { ControlRequestKind } from '../enums.js';
import { Instant, Sha256Hex, Uuid } from '../primitives.js';
import { JsonRecord } from './common.js';

/**
 * Operator step-up (blueprint §5.7, §15.6, §20.26, D41; ADR-0006).
 *
 * Supabase Auth owns identity and TOTP (AAL2). Passkeys/WebAuthn are the primary step-up for
 * risk-increasing controls and are verified by the worker with SimpleWebAuthn against a challenge
 * the database issued for one exact control request (kind + canonical bound payload hash). The
 * browser never writes a passkey or an assertion row; it only submits evidence inside a control
 * request. Every browser-supplied field is length-bounded (§23.2; review R2-11).
 */

export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** WebAuthn credential id (base64url); the DB enforces the same 16..1024 bound. */
export const CredentialId = Base64Url.min(16).max(1024);

export const WebAuthnTransport = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
export type WebAuthnTransport = z.infer<typeof WebAuthnTransport>;

// ops.operator_passkeys ------------------------------------------------------------------------

export const OperatorPasskey = z.object({
  id: Uuid,
  userId: Uuid,
  credentialId: CredentialId,
  /** COSE-encoded public key, base64url. Public material; never a secret. */
  publicKeyCose: Base64Url.min(16).max(2048),
  signCount: z.number().int().nonnegative(),
  transports: z.array(WebAuthnTransport).max(8),
  aaguid: z.uuid().nullable(),
  backedUp: z.boolean(),
  label: z.string().min(1).max(64),
  createdAt: Instant,
  /** A first passkey registered with TOTP alone cannot authorise REQUIRED kinds before this instant. */
  usableFrom: Instant,
  lastUsedAt: Instant.nullable(),
  revokedAt: Instant.nullable(),
});
export type OperatorPasskey = z.infer<typeof OperatorPasskey>;

// ops.step_up_challenges -----------------------------------------------------------------------

/** Issued by ops.begin_step_up() (server-side randomness) for one exact request; 5-minute life. */
export const StepUpChallenge = z.object({
  id: Uuid,
  userId: Uuid,
  kind: ControlRequestKind,
  /** stepUpBindingHash(kind, payload) of the control request this challenge may authorise. */
  bindingHash: Sha256Hex,
  /** 32 random bytes, base64url without padding (43 chars). */
  challenge: Base64Url.length(43),
  issuedAt: Instant,
  expiresAt: Instant,
  consumedAt: Instant.nullable(),
});
export type StepUpChallenge = z.infer<typeof StepUpChallenge>;

// Browser evidence carried inside control_requests.payload -------------------------------------

/** W3C `AuthenticationResponseJSON` as produced by @simplewebauthn/browser. */
export const WebAuthnAuthenticationResponse = z.strictObject({
  id: CredentialId,
  rawId: CredentialId,
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: Base64Url.max(4096),
    authenticatorData: Base64Url.max(4096),
    signature: Base64Url.max(1024),
    userHandle: Base64Url.max(256).optional(),
  }),
  clientExtensionResults: JsonRecord,
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export type WebAuthnAuthenticationResponse = z.infer<typeof WebAuthnAuthenticationResponse>;

/** W3C `RegistrationResponseJSON` as produced by @simplewebauthn/browser (payload.registration). */
export const WebAuthnRegistrationResponse = z.strictObject({
  id: CredentialId,
  rawId: CredentialId,
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: Base64Url.max(4096),
    attestationObject: Base64Url.max(8192),
    authenticatorData: Base64Url.max(4096).optional(),
    transports: z.array(WebAuthnTransport).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: Base64Url.max(2048).optional(),
  }),
  clientExtensionResults: JsonRecord,
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export type WebAuthnRegistrationResponse = z.infer<typeof WebAuthnRegistrationResponse>;

/** payload.stepUp: an assertion from an existing passkey over the challenge bound to this request. */
export const StepUpEvidence = z.strictObject({
  challengeId: Uuid,
  credentialId: CredentialId,
  response: WebAuthnAuthenticationResponse,
});
export type StepUpEvidence = z.infer<typeof StepUpEvidence>;

// ops.step_up_assertions -----------------------------------------------------------------------

/**
 * Immutable verification record written only by the worker through
 * ops.consume_step_up_challenge(), which consumes the challenge and inserts this row atomically.
 */
export const StepUpAssertion = z.object({
  id: Uuid,
  challengeId: Uuid,
  userId: Uuid,
  passkeyId: Uuid.nullable(),
  kind: ControlRequestKind,
  bindingHash: Sha256Hex,
  verified: z.boolean(),
  failureReason: z.string().min(1).max(256).nullable(),
  verifiedAt: Instant,
  expiresAt: Instant,
  controlRequestId: Uuid.nullable(),
});
export type StepUpAssertion = z.infer<typeof StepUpAssertion>;
