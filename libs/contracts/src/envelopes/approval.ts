import { z } from 'zod';
import { compareInstants } from '../clock.js';
import { Instant, Nonce, Sha256Hex, Uuid } from '../primitives.js';
import { canonicalHash } from '../signing/canonical.js';
import { signedEnvelopeOf, type SignedEnvelope } from '../signing/signed-envelope.js';

// §6.15 / §15.6 LIVE_APPROVAL grant -------------------------------------------------------------

/**
 * Definition: the **authorization hash** of a risk authorization is the SHA-256 of the canonical
 * JSON of its `RiskAuthorizedIntent` payload, i.e. the `payloadHash` of a *verified*
 * `SignedRiskAuthorizedIntent`. It is always recomputed from the payload after signature
 * verification (`deriveAuthorizationHash`) and never read from storage or from the grant.
 */
export async function deriveAuthorizationHash(verifiedAuthorization: SignedEnvelope<unknown>): Promise<Sha256Hex> {
  return canonicalHash(verifiedAuthorization.payload);
}

/**
 * Binds a human approval to the exact authorization envelope hash, nonce and expiry. Changing
 * any authorized field yields a new authorization hash and therefore needs a new approval.
 */
export const ApprovalGrant = z.strictObject({
  authorizationHash: Sha256Hex,
  intentId: Uuid,
  approverId: Uuid,
  role: z.enum(['operator', 'admin']),
  /** Required for exposure-increasing approvals (D41). */
  stepUpAssertionRef: z.string().min(1).max(512).nullable(),
  grantedAt: Instant,
  expiresAt: Instant,
  nonce: Nonce,
});
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;

export const SignedApprovalGrant = signedEnvelopeOf(ApprovalGrant);
export type SignedApprovalGrant = z.infer<typeof SignedApprovalGrant>;

export type ApprovalBindingFailure =
  | 'AUTHORIZATION_HASH_MISMATCH'
  | 'INTENT_MISMATCH'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'NONCE_REPLAYED'
  | 'STEP_UP_REQUIRED';

export type ApprovalBindingResult = { ok: true } | { ok: false; reason: ApprovalBindingFailure };

/**
 * Deterministic binding check the executor performs after verifying both envelope signatures
 * (INV-10). `authorizationHash` must come from `deriveAuthorizationHash`, `usedNonces` from the
 * executor's durable nonce ledger, and `requireStepUp` is true for exposure-increasing intents.
 */
export function checkApprovalBinding(input: {
  grant: ApprovalGrant;
  authorizationHash: Sha256Hex;
  intentId: Uuid;
  now: Instant;
  usedNonces: ReadonlySet<Nonce>;
  requireStepUp: boolean;
}): ApprovalBindingResult {
  const { grant } = input;
  if (grant.authorizationHash !== input.authorizationHash) return { ok: false, reason: 'AUTHORIZATION_HASH_MISMATCH' };
  if (grant.intentId !== input.intentId) return { ok: false, reason: 'INTENT_MISMATCH' };
  if (compareInstants(input.now, grant.grantedAt) < 0) return { ok: false, reason: 'NOT_YET_VALID' };
  if (compareInstants(input.now, grant.expiresAt) >= 0) return { ok: false, reason: 'EXPIRED' };
  if (input.usedNonces.has(grant.nonce)) return { ok: false, reason: 'NONCE_REPLAYED' };
  if (input.requireStepUp && grant.stepUpAssertionRef === null) return { ok: false, reason: 'STEP_UP_REQUIRED' };
  return { ok: true };
}
