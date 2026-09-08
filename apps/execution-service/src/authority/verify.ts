import { canonicalHash, checkApprovalBinding, deriveAuthorizationHash, instantToMs, RiskAuthorizedIntent, verifySignedEnvelope, type Instant, type KeyId, type Nonce, type Sha256Hex, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type TradeIntent, type VerificationKey } from '@sol-agent-trader/contracts';
import { modeGate, type ModeFacts } from './mode-gate.js';

/**
 * Authority reconstruction and verification (blueprint D21, §15.3 steps 1–5, ADR-0009 P3;
 * INV-01, INV-05, INV-06, INV-10). The executor never acts on a database row: it verifies the
 * risk-authorizer's signature against the key ids pinned in its deployment guardrails, recomputes
 * the intent hash, checks expiry and nonce against its durable ledger, proves the stored intent
 * row still says exactly what was signed, binds any LIVE_APPROVAL grant to the exact
 * authorization hash, and reads the mode gate last, immediately before submit.
 */

export interface AuthorityInput {
  envelope: SignedRiskAuthorizedIntent;
  /** Verification keys available to this process; only those whose ids the guardrails accept count. */
  keys: readonly VerificationKey[];
  acceptedKeyIds: readonly KeyId[];
  /** The immutable trading.intents row loaded from Postgres, or null when it is missing. */
  storedIntent: TradeIntent | null;
  approval: { grant: SignedApprovalGrant; keys: readonly VerificationKey[] } | null;
  usedNonces: ReadonlySet<Nonce>;
  mode: ModeFacts;
  now: Instant;
  /** Tolerated forward clock skew for `issuedAt`. */
  maxSkewMs: number;
}

export type AuthorityRejection =
  | 'AUTHORIZER_KEY_NOT_ACCEPTED'
  | 'AUTHORIZATION_SIGNATURE_INVALID'
  | 'AUTHORIZATION_MALFORMED'
  | 'INTENT_HASH_MISMATCH'
  | 'AUTHORIZATION_EXPIRED'
  | 'AUTHORIZATION_NOT_YET_VALID'
  | 'NONCE_REPLAYED'
  | 'INTENT_RECORD_MISSING'
  | 'DB_TAMPER_DETECTED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_SIGNATURE_INVALID'
  | 'APPROVAL_BINDING_FAILED'
  | 'MODE_GATE';

export type AuthorityVerdict = { ok: true; authorizationHash: Sha256Hex; payload: RiskAuthorizedIntent } | { ok: false; reasons: AuthorityRejection[]; detail: string[] };

/** Fields the envelope binds that the stored row must still carry verbatim (INV-06). */
function tamperedFields(stored: TradeIntent, p: RiskAuthorizedIntent): string[] {
  const pairs: [string, unknown, unknown][] = [
    ['id', stored.id, p.intentId],
    ['accountId', stored.accountId, p.accountId],
    ['assetId', stored.assetId, p.assetId],
    ['strategyVersionId', stored.strategyVersionId, p.strategyVersionId],
    ['sleeveId', stored.sleeveId, p.sleeveId],
    ['action', stored.action, p.action],
    ['side', stored.side, p.side],
    ['exposureEffect', stored.exposureEffect, p.exposureEffect],
    ['inputMint', stored.inputMint, p.inputMint],
    ['outputMint', stored.outputMint, p.outputMint],
    ['maxInputAmount', stored.maxInputAmount, p.maxInputAmount],
    ['actionCycleId', stored.actionCycleId, p.actionCycleId],
    ['clearedCutoffVersion', stored.clearedCutoffVersion, p.clearedCutoffVersion],
    ['maxSlippageBps', stored.constraints.maxSlippageBps, p.maxSlippageBps],
    ['maxPriceImpactBps', stored.constraints.maxPriceImpactBps, p.maxPriceImpactBps],
    ['chaseToleranceBps', stored.constraints.chaseToleranceBps, p.chaseToleranceBps],
    ['maxQuoteAgeMs', stored.constraints.maxQuoteAgeMs, p.maxQuoteAgeMs],
    ['targetLotIds', stored.targetLotIds.join(','), p.targetLotIds.join(',')],
    ['approvalRequired', stored.approvalRequired, p.approvalRequired],
    ['expiresAt', instantToMs(stored.expiresAt), instantToMs(p.expiresAt)],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([name]) => name);
}

export async function verifyAuthority(input: AuthorityInput): Promise<AuthorityVerdict> {
  const reasons: AuthorityRejection[] = [];
  const detail: string[] = [];
  const accepted = input.keys.filter((k) => input.acceptedKeyIds.includes(k.keyId));
  if (!accepted.some((k) => k.keyId === input.envelope.keyId)) return { ok: false, reasons: ['AUTHORIZER_KEY_NOT_ACCEPTED'], detail: [`key ${input.envelope.keyId} is not in the deployment guardrails`] };
  const sig = await verifySignedEnvelope(input.envelope, accepted);
  if (!sig.ok) return { ok: false, reasons: ['AUTHORIZATION_SIGNATURE_INVALID'], detail: [sig.reason] };
  const parsed = RiskAuthorizedIntent.safeParse(input.envelope.payload);
  if (!parsed.success) return { ok: false, reasons: ['AUTHORIZATION_MALFORMED'], detail: [parsed.error.message.slice(0, 200)] };
  const p = parsed.data;
  const { intentHash, ...unsigned } = p;
  if (intentHash !== (await canonicalHash(unsigned))) {
    reasons.push('INTENT_HASH_MISMATCH');
  }
  const nowMs = instantToMs(input.now);
  if (nowMs >= instantToMs(p.expiresAt)) reasons.push('AUTHORIZATION_EXPIRED');
  if (instantToMs(p.issuedAt) > nowMs + input.maxSkewMs) reasons.push('AUTHORIZATION_NOT_YET_VALID');
  if (input.usedNonces.has(p.nonce)) reasons.push('NONCE_REPLAYED');
  if (!input.storedIntent) reasons.push('INTENT_RECORD_MISSING');
  else {
    const tampered = tamperedFields(input.storedIntent, p);
    if (tampered.length) {
      reasons.push('DB_TAMPER_DETECTED');
      detail.push(`stored intent differs in ${tampered.join(', ')}`);
    }
  }
  const authorizationHash = await deriveAuthorizationHash(input.envelope);
  if (p.approvalRequired || p.capitalAuthority === 'LIVE_APPROVAL') {
    if (!input.approval) reasons.push('APPROVAL_REQUIRED');
    else {
      const grantSig = await verifySignedEnvelope(input.approval.grant, input.approval.keys);
      if (!grantSig.ok) {
        reasons.push('APPROVAL_SIGNATURE_INVALID');
        detail.push(grantSig.reason);
      } else {
        const binding = checkApprovalBinding({ grant: input.approval.grant.payload, authorizationHash, intentId: p.intentId, now: input.now, usedNonces: input.usedNonces, requireStepUp: p.exposureEffect === 'INCREASE' });
        if (!binding.ok) {
          reasons.push('APPROVAL_BINDING_FAILED');
          detail.push(binding.reason);
        }
      }
    }
  }
  const gate = modeGate(input.mode, p.exposureEffect);
  if (!gate.allowed) {
    reasons.push('MODE_GATE');
    detail.push(gate.reason);
  }
  return reasons.length ? { ok: false, reasons, detail } : { ok: true, authorizationHash, payload: p };
}
