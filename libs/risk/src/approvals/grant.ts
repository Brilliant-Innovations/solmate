import { addMs, compareInstants, deriveAuthorizationHash, signPayload, verifySignedEnvelope, type ApprovalGrant, type Instant, type Nonce, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type SigningKeyPair, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';

/**
 * LIVE_APPROVAL grant construction (blueprint §15.6, §20.8, D41; INV-10). A grant binds a human
 * decision to one verified risk authorization: the authorization hash is recomputed from the
 * verified envelope, never read from a request; the grant expires with the intent or sooner; an
 * exposure-increasing approval needs a step-up assertion. Without a verified authorization there is
 * nothing to approve, so tampering with the stored envelope yields no grant.
 */

export type GrantRefusal = 'AUTHORIZATION_SIGNATURE_INVALID' | 'AUTHORIZATION_EXPIRED' | 'INTENT_MISMATCH' | 'STEP_UP_REQUIRED' | 'NOTHING_TO_APPROVE';

export interface GrantInput {
  authorization: SignedRiskAuthorizedIntent;
  authorizerKeys: readonly VerificationKey[];
  intentId: Uuid;
  approver: { id: Uuid; role: 'operator' | 'admin' };
  stepUpAssertionRef: string | null;
  now: Instant;
  nonce: Nonce;
  /** Ceiling on how long a grant stays valid (the intent's own expiry always caps it). */
  maxValidityMs: number;
}

export type GrantResult = { ok: true; grant: ApprovalGrant } | { ok: false; reason: GrantRefusal };

export async function buildApprovalGrant(input: GrantInput): Promise<GrantResult> {
  const sig = await verifySignedEnvelope(input.authorization, input.authorizerKeys);
  if (!sig.ok) return { ok: false, reason: 'AUTHORIZATION_SIGNATURE_INVALID' };
  const p = input.authorization.payload;
  if (p.intentId !== input.intentId) return { ok: false, reason: 'INTENT_MISMATCH' };
  if (compareInstants(input.now, p.expiresAt) >= 0) return { ok: false, reason: 'AUTHORIZATION_EXPIRED' };
  if (p.exposureEffect === 'INCREASE' && input.stepUpAssertionRef === null) return { ok: false, reason: 'STEP_UP_REQUIRED' };
  const authorizationHash = await deriveAuthorizationHash(input.authorization);
  const ceiling = addMs(input.now, input.maxValidityMs);
  const expiresAt = compareInstants(p.expiresAt, ceiling) < 0 ? p.expiresAt : ceiling;
  return { ok: true, grant: { authorizationHash, intentId: p.intentId, approverId: input.approver.id, role: input.approver.role, stepUpAssertionRef: input.stepUpAssertionRef, grantedAt: input.now, expiresAt, nonce: input.nonce } };
}

export async function signApprovalGrant(grant: ApprovalGrant, key: SigningKeyPair, signedAt: Instant): Promise<SignedApprovalGrant> {
  return signPayload(grant, key, signedAt);
}
