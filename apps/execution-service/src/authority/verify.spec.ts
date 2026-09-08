import { addMs, canonicalHash, deriveAuthorizationHash, fixtures, generateSigningKeyPair, signPayload, toInstant, type Amount, type ApprovalGrant, type Instant, type Nonce, type RiskAuthorizedIntent, type SigningKeyPair, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import { verifyAuthority, type AuthorityInput } from './verify.js';
import type { ModeFacts } from './mode-gate.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const ACTIVE: ModeFacts = { activity: 'ACTIVE', authority: 'LIVE_APPROVAL', paused: false, localPause: false, liveCapabilityEnabled: true };

async function signedIntent(key: SigningKeyPair, over: Partial<RiskAuthorizedIntent> = {}) {
  const base = { ...fixtures.riskAuthorizedIntent(), issuedAt: addMs(NOW, -5_000), expiresAt: addMs(NOW, 55_000), ...over };
  const { intentHash: _ignored, ...unsigned } = base;
  void _ignored;
  const payload: RiskAuthorizedIntent = { ...unsigned, intentHash: await canonicalHash(unsigned) } as RiskAuthorizedIntent;
  return signPayload(payload, key, NOW);
}
function storedFor(p: RiskAuthorizedIntent): TradeIntent {
  return {
    id: p.intentId, idempotencyKey: 'entry:cycle' as never, accountId: p.accountId, strategyVersionId: p.strategyVersionId, sleeveId: p.sleeveId, assetId: p.assetId, action: p.action, side: p.side, exposureEffect: p.exposureEffect,
    inputMint: p.inputMint, outputMint: p.outputMint, maxInputAmount: p.maxInputAmount, riskEvaluationId: fixtures.IDS.evaluation as Uuid, actionCycleId: p.actionCycleId, clearedCutoffVersion: p.clearedCutoffVersion,
    constraints: { maxSlippageBps: p.maxSlippageBps, maxPriceImpactBps: p.maxPriceImpactBps, chaseToleranceBps: p.chaseToleranceBps, maxQuoteAgeMs: p.maxQuoteAgeMs }, protectionPolicyRef: null, targetLotIds: p.targetLotIds, approvalRequired: p.approvalRequired, createdAt: p.issuedAt, expiresAt: p.expiresAt,
  };
}
async function grantFor(envelope: Awaited<ReturnType<typeof signedIntent>>, key: SigningKeyPair, over: Partial<ApprovalGrant> = {}) {
  const grant: ApprovalGrant = { authorizationHash: await deriveAuthorizationHash(envelope), intentId: envelope.payload.intentId, approverId: fixtures.IDS.operator as Uuid, role: 'operator', stepUpAssertionRef: 'assertion-1', grantedAt: addMs(NOW, -1_000), expiresAt: addMs(NOW, 60_000), nonce: 'ab'.repeat(16) as Nonce, ...over };
  return signPayload(grant, key, NOW);
}

describe('executor authority verification (D21, §15.3, P3; INV-01, INV-06, INV-10, INV-05)', () => {
  it('a pinned-key envelope with a matching stored row and a bound approval verifies; the executor then holds the recomputed authorization hash', async () => {
    const authorizer = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const envelope = await signedIntent(authorizer);
    const grant = await grantFor(envelope, approver);
    const input: AuthorityInput = { envelope, keys: [authorizer], acceptedKeyIds: [authorizer.keyId], storedIntent: storedFor(envelope.payload), approval: { grant, keys: [approver] }, usedNonces: new Set(), mode: ACTIVE, now: NOW, maxSkewMs: 5_000 };
    const v = await verifyAuthority(input);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.authorizationHash).toBe(await deriveAuthorizationHash(envelope));
  });

  it('INV-01/INV-06: an unpinned key, a tampered payload, an edited stored row, an expired or replayed envelope, or a missing row each refuse', async () => {
    const authorizer = await generateSigningKeyPair();
    const rogue = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const envelope = await signedIntent(authorizer);
    const grant = await grantFor(envelope, approver);
    const base: AuthorityInput = { envelope, keys: [authorizer, rogue], acceptedKeyIds: [authorizer.keyId], storedIntent: storedFor(envelope.payload), approval: { grant, keys: [approver] }, usedNonces: new Set(), mode: ACTIVE, now: NOW, maxSkewMs: 5_000 };
    const rogueEnvelope = await signedIntent(rogue);
    const cases: [Partial<AuthorityInput>, string][] = [
      [{ envelope: rogueEnvelope }, 'AUTHORIZER_KEY_NOT_ACCEPTED'],
      [{ envelope: { ...envelope, payload: { ...envelope.payload, maxInputAmount: '999999999' as Amount } } }, 'AUTHORIZATION_SIGNATURE_INVALID'],
      [{ storedIntent: { ...storedFor(envelope.payload), maxInputAmount: '999999999' as Amount } }, 'DB_TAMPER_DETECTED'],
      [{ storedIntent: { ...storedFor(envelope.payload), outputMint: fixtures.MINTS.USDC as never } }, 'DB_TAMPER_DETECTED'],
      [{ storedIntent: { ...storedFor(envelope.payload), constraints: { ...storedFor(envelope.payload).constraints, maxSlippageBps: 500 as never } } }, 'DB_TAMPER_DETECTED'],
      [{ storedIntent: { ...storedFor(envelope.payload), expiresAt: addMs(NOW, 3_600_000) as Instant } }, 'DB_TAMPER_DETECTED'],
      [{ storedIntent: null }, 'INTENT_RECORD_MISSING'],
      [{ now: addMs(NOW, 60_000) }, 'AUTHORIZATION_EXPIRED'],
      [{ usedNonces: new Set([envelope.payload.nonce]) }, 'NONCE_REPLAYED'],
    ];
    for (const [over, reason] of cases) {
      const v = await verifyAuthority({ ...base, ...over });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
    // a payload whose intent hash does not cover its fields is caught even with a valid signature
    const forged = { ...envelope.payload, intentHash: 'ee'.repeat(32) as never };
    const resigned = await signPayload(forged, authorizer, NOW);
    const h = await verifyAuthority({ ...base, envelope: resigned, storedIntent: storedFor(forged) });
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.reasons).toContain('INTENT_HASH_MISMATCH');
  });

  it('INV-10: a LIVE_APPROVAL envelope needs a grant signed by an accepted approver and bound to this exact hash, intent, window and step-up', async () => {
    const authorizer = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const envelope = await signedIntent(authorizer);
    const base: AuthorityInput = { envelope, keys: [authorizer], acceptedKeyIds: [authorizer.keyId], storedIntent: storedFor(envelope.payload), approval: null, usedNonces: new Set(), mode: ACTIVE, now: NOW, maxSkewMs: 5_000 };
    expect((await verifyAuthority(base)) as never).toMatchObject({ ok: false, reasons: ['APPROVAL_REQUIRED'] });
    const good = await grantFor(envelope, approver);
    expect((await verifyAuthority({ ...base, approval: { grant: good, keys: [approver] } })).ok).toBe(true);
    const cases: [Awaited<ReturnType<typeof grantFor>>, readonly SigningKeyPair[], string][] = [
      [await grantFor(envelope, other), [approver], 'APPROVAL_SIGNATURE_INVALID'],
      [await grantFor(envelope, approver, { authorizationHash: 'cd'.repeat(32) as never }), [approver], 'APPROVAL_BINDING_FAILED'],
      [await grantFor(envelope, approver, { intentId: fixtures.IDS.position as Uuid }), [approver], 'APPROVAL_BINDING_FAILED'],
      [await grantFor(envelope, approver, { expiresAt: NOW }), [approver], 'APPROVAL_BINDING_FAILED'],
      [await grantFor(envelope, approver, { stepUpAssertionRef: null }), [approver], 'APPROVAL_BINDING_FAILED'],
      [await grantFor(envelope, approver, { nonce: envelope.payload.nonce }), [approver], 'APPROVAL_BINDING_FAILED'],
    ];
    for (const [grant, keys, reason] of cases) {
      const v = await verifyAuthority({ ...base, approval: { grant, keys }, usedNonces: reason === 'APPROVAL_BINDING_FAILED' && grant.payload.nonce === envelope.payload.nonce ? new Set([envelope.payload.nonce]) : new Set() });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason === 'APPROVAL_BINDING_FAILED' && grant.payload.nonce === envelope.payload.nonce ? 'NONCE_REPLAYED' : reason);
    }
  });

  it('INV-05 / P3: the mode gate is read last, immediately before submit, so an authorization issued before a pause cannot submit after it', async () => {
    const authorizer = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const envelope = await signedIntent(authorizer);
    const grant = await grantFor(envelope, approver);
    const base: AuthorityInput = { envelope, keys: [authorizer], acceptedKeyIds: [authorizer.keyId], storedIntent: storedFor(envelope.payload), approval: { grant, keys: [approver] }, usedNonces: new Set(), mode: ACTIVE, now: NOW, maxSkewMs: 5_000 };
    for (const [mode, reason] of [
      [{ ...ACTIVE, paused: true }, 'PAUSED'],
      [{ ...ACTIVE, localPause: true }, 'LOCAL_PAUSE'],
      [{ ...ACTIVE, activity: 'WATCH' }, 'ACTIVITY_FORBIDS_ENTRIES'],
      [{ ...ACTIVE, authority: 'PAPER' }, 'AUTHORITY_FORBIDS_LIVE'],
      [{ ...ACTIVE, liveCapabilityEnabled: false }, 'LIVE_CAPABILITY_DISABLED'],
    ] as [ModeFacts, string][]) {
      const v = await verifyAuthority({ ...base, mode });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.detail, reason).toContain(reason);
    }
  });
});
