import fc from 'fast-check';
import { addMs } from '../clock.js';
import * as fixtures from '../fixtures/index.js';
import type { Instant, Nonce, Sha256Hex, Uuid } from '../primitives.js';
import { generateSigningKeyPair, importVerificationKey, signPayload, verifySignedEnvelope } from '../signing/index.js';
import { checkApprovalBinding, deriveAuthorizationHash, type ApprovalGrant } from './approval.js';

const { riskAuthorizedIntent } = fixtures;

const T0 = fixtures.T0 as Instant;

describe('approval binding (INV-10)', () => {
  it('the authorization hash is derived from the verified envelope payload, and a tampered field changes it', async () => {
    const key = await generateSigningKeyPair();
    const env = await signPayload(riskAuthorizedIntent(), key, T0);
    expect(await verifySignedEnvelope(env, [await importVerificationKey(key.publicKeyHex)])).toEqual({ ok: true, keyId: key.keyId });
    const h = await deriveAuthorizationHash(env);
    expect(h).toBe(env.payloadHash);
    const widened = { ...env, payload: { ...env.payload, maxInputAmount: '999999999999' } };
    expect(await deriveAuthorizationHash(widened)).not.toBe(h);
  });

  const grant = (over: Partial<ApprovalGrant> = {}): ApprovalGrant => ({ ...fixtures.approvalGrant(), ...over });
  const base = {
    authorizationHash: fixtures.HASH_A as Sha256Hex,
    intentId: fixtures.IDS.intent as Uuid,
    now: addMs(T0, 1000),
    usedNonces: new Set<Nonce>(),
    requireStepUp: true,
  };

  it('accepts an exact, unexpired, unused, stepped-up grant', () => {
    expect(checkApprovalBinding({ ...base, grant: grant() })).toEqual({ ok: true });
  });

  it('rejects a grant for a different authorization hash, intent, an expired or future grant, a replayed nonce, or missing step-up', () => {
    expect(checkApprovalBinding({ ...base, grant: grant(), authorizationHash: fixtures.HASH_B as Sha256Hex })).toEqual({ ok: false, reason: 'AUTHORIZATION_HASH_MISMATCH' });
    expect(checkApprovalBinding({ ...base, grant: grant(), intentId: fixtures.IDS.cycle as Uuid })).toEqual({ ok: false, reason: 'INTENT_MISMATCH' });
    expect(checkApprovalBinding({ ...base, grant: grant(), now: fixtures.T1 as Instant })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(checkApprovalBinding({ ...base, grant: grant(), now: addMs(T0, -1) })).toEqual({ ok: false, reason: 'NOT_YET_VALID' });
    expect(checkApprovalBinding({ ...base, grant: grant(), usedNonces: new Set([fixtures.NONCE as Nonce]) })).toEqual({ ok: false, reason: 'NONCE_REPLAYED' });
    expect(checkApprovalBinding({ ...base, grant: grant({ stepUpAssertionRef: null }) })).toEqual({ ok: false, reason: 'STEP_UP_REQUIRED' });
    expect(checkApprovalBinding({ ...base, grant: grant({ stepUpAssertionRef: null }), requireStepUp: false })).toEqual({ ok: true });
  });

  it('a stale or replayed approval never authorizes a changed or expired envelope (property)', () => {
    const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
    fc.assert(
      fc.property(hex64, hex64, fc.integer({ min: -600_000, max: 600_000 }), fc.boolean(), (grantHash, actualHash, offsetMs, replayed) => {
        const g = grant({ authorizationHash: grantHash as Sha256Hex });
        const r = checkApprovalBinding({
          ...base,
          grant: g,
          authorizationHash: actualHash as Sha256Hex,
          now: addMs(T0, offsetMs),
          usedNonces: replayed ? new Set([g.nonce]) : new Set(),
        });
        const withinWindow = offsetMs >= 0 && offsetMs < 300_000; // T0..T1 is five minutes
        expect(r.ok).toBe(grantHash === actualHash && withinWindow && !replayed);
      }),
      { numRuns: 300 },
    );
  });
});
