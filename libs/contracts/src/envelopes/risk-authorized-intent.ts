import { z } from 'zod';
import { CapitalAuthority, ExposureEffect, IntentAction, ProtectionMode, TradeSide } from '../enums.js';
import {
  Amount,
  Bps,
  Instant,
  Milliseconds,
  MintAddress,
  Nonce,
  Sequence,
  Sha256Hex,
  SolanaCluster,
  Uuid,
  VersionId,
} from '../primitives.js';
import { signedEnvelopeOf } from '../signing/signed-envelope.js';

// §6.14 RiskAuthorizedIntentEnvelope (D21) ------------------------------------------------------

/**
 * Every field the executor is allowed to act on. Bound by the risk-authorizer's signature so a
 * database mutation after authorization cannot widen or substitute the action. The executor
 * reconstructs this from the immutable records, verifies the signature against its pinned key,
 * then checks expiry, nonce and idempotency (§15.3).
 */
export const RiskAuthorizedIntent = z.strictObject({
  intentId: Uuid,
  intentHash: Sha256Hex,
  actionCycleId: Uuid,
  clearedCutoffVersion: z.number().int().positive(),
  releaseId: Uuid,
  releaseDigest: Sha256Hex,
  attestationId: Uuid,
  policyVersion: VersionId,
  policyHash: Sha256Hex,
  strategyVersionId: VersionId,
  sleeveId: Uuid.nullable(),
  accountId: Uuid,
  assetId: Uuid,
  cluster: SolanaCluster,
  capitalAuthority: CapitalAuthority,
  action: IntentAction,
  side: TradeSide,
  exposureEffect: ExposureEffect,
  inputMint: MintAddress,
  outputMint: MintAddress,
  maxInputAmount: Amount,
  maxSlippageBps: Bps,
  maxPriceImpactBps: Bps,
  chaseToleranceBps: Bps,
  maxQuoteAgeMs: Milliseconds,
  allowedProtectionMode: ProtectionMode.nullable(),
  targetLotIds: z.array(Uuid),
  approvalRequired: z.boolean(),
  projectionSequence: Sequence,
  projectionHash: Sha256Hex,
  issuedAt: Instant,
  expiresAt: Instant,
  nonce: Nonce,
});
export type RiskAuthorizedIntent = z.infer<typeof RiskAuthorizedIntent>;

export const SignedRiskAuthorizedIntent = signedEnvelopeOf(RiskAuthorizedIntent);
export type SignedRiskAuthorizedIntent = z.infer<typeof SignedRiskAuthorizedIntent>;

export const AuthorizationDenial = z.strictObject({
  intentId: Uuid.nullable(),
  actionCycleId: Uuid,
  deniedAt: Instant,
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).min(1),
  detail: z.string().max(2048).nullable(),
});
export type AuthorizationDenial = z.infer<typeof AuthorizationDenial>;
