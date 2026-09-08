import { fixtures, type Instant, type OperatorPasskey, type StepUpChallenge, type Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runOperatorSecurityCycle, verifyRequestStepUp, type OperatorSecurityDeps, type OperatorSecurityRepo, type StepUpVerifiers } from './operator-security.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = fixtures.T0 as Instant;
const U1 = '11111111-1111-4111-8111-111111111111' as Uuid;
const U2 = '22222222-2222-4222-8222-222222222222' as Uuid;
const CH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Uuid;
const PK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Uuid;
const REQ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as Uuid;
const CRED = 'AAAAAAAAAAAAAAAAAAAAAA';
const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVlc';

const authResponse = { id: CRED, rawId: CRED, type: 'public-key' as const, response: { clientDataJSON: b64, authenticatorData: b64, signature: b64 }, clientExtensionResults: {} };
const regResponse = { id: 'BBBBBBBBBBBBBBBBBBBBBB', rawId: 'BBBBBBBBBBBBBBBBBBBBBB', type: 'public-key' as const, response: { clientDataJSON: b64, attestationObject: b64 }, clientExtensionResults: {} };

function harness(opts: { passkeys?: OperatorPasskey[]; challenge?: StepUpChallenge | null; role?: 'operator' | 'admin' | 'viewer' | null; verifiers?: Partial<StepUpVerifiers> } = {}) {
  const passkeys = [...(opts.passkeys ?? [])];
  let challenge: StepUpChallenge | null = opts.challenge === undefined ? { id: CH, userId: U1, kind: 'REVOKE_PASSKEY', bindingHash: 'ab'.repeat(32) as never, challenge: 'x'.repeat(43), issuedAt: T0, expiresAt: '2026-09-05T12:05:00.000Z' as Instant, consumedAt: null } : opts.challenge;
  const consumed: unknown[] = [];
  const resolved: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  const inserted: unknown[] = [];
  const raised: string[] = [];
  const uses: unknown[] = [];
  let pending: PendingControlRequest[] = [];
  const repo: OperatorSecurityRepo = {
    async listPending(kinds) { return pending.filter((p) => kinds.includes(p.kind)); },
    async loadPendingRequest(id) { return pending.find((p) => p.id === id) ?? null; },
    async loadChallenge(id) { return challenge && challenge.id === id ? challenge : null; },
    async loadPasskeyByCredentialId(cid) { return passkeys.find((p) => p.credentialId === cid) ?? null; },
    async activePasskeys(userId) { return passkeys.filter((p) => p.userId === userId && p.revokedAt === null).length; },
    async consume(input) {
      if (!challenge || challenge.consumedAt !== null) return { ok: false, reason: 'CHALLENGE_UNAVAILABLE' };
      challenge = { ...challenge, consumedAt: T0 };
      consumed.push(input);
      return { ok: true, assertionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as Uuid, expiresAt: T0 };
    },
    async recordUse(id, count, at) { uses.push({ id, count, at }); },
    async insertPasskey(p) { inserted.push(p); return { ok: true, id: PK }; },
    async revokePasskey(id, userId) { const p = passkeys.find((x) => x.id === id && x.userId === userId && x.revokedAt === null); if (!p) return false; p.revokedAt = T0; return true; },
    async operatorRole() { return opts.role === undefined ? 'operator' : opts.role; },
    async resolve(id, state, resolution) { resolved.push({ id, state, resolution }); return true; },
    async raise(n) { raised.push(n.alertClass); },
  };
  const verifiers: StepUpVerifiers = {
    stepUp: opts.verifiers?.stepUp ?? (async () => ({ verified: true, passkeyId: PK, newSignCount: 7 })),
    registration: opts.verifiers?.registration ?? (async ({ activePasskeys }) => ({ verified: true, credential: { credentialId: 'BBBBBBBBBBBBBBBBBBBBBB', publicKeyCose: b64, signCount: 0, transports: ['internal'], aaguid: null, backedUp: false, usableFrom: activePasskeys === 0 ? ('2026-09-05T13:00:00.000Z' as Instant) : T0 } })),
  };
  const deps: OperatorSecurityDeps = { repo, rp: { rpId: 'localhost', origins: ['http://localhost:3000'] }, clock: { now: () => T0, nowMs: () => Date.parse(T0) }, logger, config: { batchSize: 20 }, verifiers, newId: () => REQ };
  return { deps, consumed, resolved, inserted, raised, uses, setPending: (p: PendingControlRequest[]) => { pending = p; }, passkeys, challengeState: () => challenge };
}

const existingPasskey: OperatorPasskey = { id: PK, userId: U1, credentialId: CRED, publicKeyCose: b64, signCount: 3, transports: ['internal'], aaguid: null, backedUp: false, label: 'laptop', createdAt: T0, usableFrom: T0, lastUsedAt: null, revokedAt: null };

describe('worker operator-security role (§5.7, §20.26, D41; ADR-0006)', () => {
  it('judges a request that carries stepUp evidence exactly once and records the verdict against the request', async () => {
    const h = harness({ passkeys: [existingPasskey] });
    const req: PendingControlRequest = { id: REQ, requestedBy: U1, kind: 'ARM_RELEASE', payload: { releaseId: 'r', stepUp: { challengeId: CH, credentialId: CRED, response: authResponse } }, createdAt: T0 };
    expect(await verifyRequestStepUp(h.deps, req)).toEqual({ status: 'VERIFIED', passkeyId: PK });
    expect(h.consumed).toEqual([{ challengeId: CH, passkeyId: PK, verified: true, failureReason: null, controlRequestId: REQ }]);
    expect(h.uses).toEqual([{ id: PK, count: 7, at: T0 }]);
    // Second look: the challenge is consumed; nothing is re-verified.
    expect(await verifyRequestStepUp(h.deps, req)).toEqual({ status: 'ALREADY_RECORDED' });
    expect(h.consumed).toHaveLength(1);
  });

  it('a failed assertion consumes the challenge with its reason so the request can never be retried against it', async () => {
    const h = harness({ passkeys: [existingPasskey], verifiers: { stepUp: async () => ({ verified: false, reason: 'ASSERTION_INVALID', detail: 'bad signature' }) } });
    const req: PendingControlRequest = { id: REQ, requestedBy: U1, kind: 'ARM_RELEASE', payload: { stepUp: { challengeId: CH, credentialId: CRED, response: authResponse } }, createdAt: T0 };
    expect(await verifyRequestStepUp(h.deps, req)).toEqual({ status: 'FAILED', reason: 'ASSERTION_INVALID', detail: 'bad signature' });
    expect(h.consumed[0]).toMatchObject({ verified: false, failureReason: 'ASSERTION_INVALID: bad signature', controlRequestId: REQ });
    expect(h.uses).toHaveLength(0);
  });

  it('a request without evidence is left to its owning role; malformed evidence counts as none', async () => {
    const h = harness();
    expect(await verifyRequestStepUp(h.deps, { id: REQ, requestedBy: U1, kind: 'ARM_RELEASE', payload: {}, createdAt: T0 })).toEqual({ status: 'NO_EVIDENCE' });
    expect(await verifyRequestStepUp(h.deps, { id: REQ, requestedBy: U1, kind: 'ARM_RELEASE', payload: { stepUp: { challengeId: 'nope' } }, createdAt: T0 })).toEqual({ status: 'NO_EVIDENCE' });
    expect(h.consumed).toHaveLength(0);
  });

  it('registers a first passkey from the fresh-TOTP challenge alone and applies the cooling period', async () => {
    const h = harness({ challenge: { id: CH, userId: U1, kind: 'REGISTER_PASSKEY', bindingHash: 'ab'.repeat(32) as never, challenge: 'x'.repeat(43), issuedAt: T0, expiresAt: '2026-09-05T12:05:00.000Z' as Instant, consumedAt: null } });
    h.setPending([{ id: REQ, requestedBy: U1, kind: 'REGISTER_PASSKEY', payload: { label: 'yubikey', source: 'settings', registration: { challengeId: CH, response: regResponse } }, createdAt: T0 }]);
    const r = await runOperatorSecurityCycle(h.deps);
    expect(r.registered).toBe(1);
    expect(h.inserted[0]).toMatchObject({ userId: U1, credentialId: 'BBBBBBBBBBBBBBBBBBBBBB', label: 'yubikey', usableFrom: '2026-09-05T13:00:00.000Z' });
    expect(h.resolved[0]).toMatchObject({ state: 'ACCEPTED', resolution: { passkeyId: PK, usableFrom: '2026-09-05T13:00:00.000Z' } });
    expect(h.consumed[0]).toMatchObject({ passkeyId: null, verified: true, controlRequestId: REQ });
  });

  it('a further passkey needs an assertion from an existing one over the same challenge (R2-01)', async () => {
    const chal: StepUpChallenge = { id: CH, userId: U1, kind: 'REGISTER_PASSKEY', bindingHash: 'ab'.repeat(32) as never, challenge: 'x'.repeat(43), issuedAt: T0, expiresAt: '2026-09-05T12:05:00.000Z' as Instant, consumedAt: null };
    const without = harness({ passkeys: [existingPasskey], challenge: chal });
    without.setPending([{ id: REQ, requestedBy: U1, kind: 'REGISTER_PASSKEY', payload: { label: 'phone', registration: { challengeId: CH, response: regResponse } }, createdAt: T0 }]);
    const r1 = await runOperatorSecurityCycle(without.deps);
    expect(r1.refused).toEqual({ STEP_UP_REQUIRED: 1 });
    expect(without.consumed[0]).toMatchObject({ verified: false, failureReason: 'STEP_UP_REQUIRED' });
    expect(without.inserted).toHaveLength(0);

    const withIt = harness({ passkeys: [existingPasskey], challenge: { ...chal } });
    withIt.setPending([{ id: REQ, requestedBy: U1, kind: 'REGISTER_PASSKEY', payload: { label: 'phone', registration: { challengeId: CH, response: regResponse }, stepUp: { challengeId: CH, credentialId: CRED, response: authResponse } }, createdAt: T0 }]);
    const r2 = await runOperatorSecurityCycle(withIt.deps);
    expect(r2.registered).toBe(1);
    expect(withIt.inserted[0]).toMatchObject({ usableFrom: T0 });
    expect(withIt.consumed[0]).toMatchObject({ passkeyId: PK, verified: true });
    expect(withIt.uses).toEqual([{ id: PK, count: 7, at: T0 }]);
  });

  it('revocation requires a verified step-up and only touches the operator\'s own passkey', async () => {
    const other: OperatorPasskey = { ...existingPasskey, id: '99999999-9999-4999-8999-999999999999' as Uuid, userId: U2, credentialId: 'ZZZZZZZZZZZZZZZZZZZZZZ' };
    const h = harness({ passkeys: [existingPasskey, other] });
    h.setPending([
      { id: REQ, requestedBy: U1, kind: 'REVOKE_PASSKEY', payload: { passkeyId: other.id }, createdAt: T0 },
    ]);
    const r1 = await runOperatorSecurityCycle(h.deps);
    expect(r1.refused).toEqual({ STEP_UP_REQUIRED: 1 });
    expect(other.revokedAt).toBeNull();

    const h2 = harness({ passkeys: [existingPasskey, { ...other, revokedAt: null }] });
    h2.setPending([{ id: REQ, requestedBy: U1, kind: 'REVOKE_PASSKEY', payload: { passkeyId: other.id, stepUp: { challengeId: CH, credentialId: CRED, response: authResponse } }, createdAt: T0 }]);
    const r2 = await runOperatorSecurityCycle(h2.deps);
    expect(r2.refused).toEqual({ NOT_OWN_PASSKEY: 1 });

    const h3 = harness({ passkeys: [existingPasskey] });
    h3.setPending([{ id: REQ, requestedBy: U1, kind: 'REVOKE_PASSKEY', payload: { passkeyId: PK, stepUp: { challengeId: CH, credentialId: CRED, response: authResponse } }, createdAt: T0 }]);
    const r3 = await runOperatorSecurityCycle(h3.deps);
    expect(r3.revoked).toBe(1);
    expect(h3.passkeys[0]!.revokedAt).toBe(T0);
    expect(h3.raised).toEqual(['OPERATOR_PASSKEY_REVOKED']);
    expect(h3.resolved.at(-1)).toMatchObject({ state: 'ACCEPTED', resolution: { passkeyId: PK } });
  });

  it('viewers cannot register or revoke', async () => {
    const h = harness({ role: 'viewer' });
    h.setPending([{ id: REQ, requestedBy: U1, kind: 'REGISTER_PASSKEY', payload: { label: 'x', registration: { challengeId: CH, response: regResponse } }, createdAt: T0 }]);
    const r = await runOperatorSecurityCycle(h.deps);
    expect(r.refused).toEqual({ NOT_AN_OPERATOR: 1 });
    expect(h.consumed).toHaveLength(0);
  });
});
