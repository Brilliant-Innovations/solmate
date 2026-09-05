import { z } from 'zod';
import { Instant, Nonce, Sha256Hex, Uuid } from '../primitives.js';
import { signedEnvelopeOf } from '../signing/signed-envelope.js';

// §6.15 / §15.6 LIVE_APPROVAL grant -------------------------------------------------------------

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
