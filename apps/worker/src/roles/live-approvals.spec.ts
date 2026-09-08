import { addMs, deriveAuthorizationHash, fixedClock, fixtures, generateSigningKeyPair, signPayload, verifySignedEnvelope, type ActivityState, type CapitalAuthority, type Instant, type RiskAuthorizedIntent, type SignedApprovalGrant, type SignedRiskAuthorizedIntent, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { AuthorizedIntentRow, EntryCandidateRow, PendingControlRequest, TradeIntentState } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runApprovalsCycle, type ApprovalsDeps, type ApprovalsRepo } from './approvals.js';
import { runLiveEntryCycle, type LiveEntryDeps, type LiveEntryRepo } from './live-entry.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const S0 = 'S0_SAFE@1.2.0' as VersionId;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const intent = (patch: Partial<TradeIntent> = {}): TradeIntent => ({ ...fixtures.riskAuthorizedIntent(), ...intentFields(), ...patch });
function intentFields(): TradeIntent {
  const p = fixtures.riskAuthorizedIntent() as RiskAuthorizedIntent;
  return { id: p.intentId, idempotencyKey: `entry:${p.actionCycleId}` as TradeIntent['idempotencyKey'], accountId: p.accountId, strategyVersionId: p.strategyVersionId, sleeveId: p.sleeveId, assetId: p.assetId, action: p.action, side: p.side, exposureEffect: p.exposureEffect, inputMint: p.inputMint, outputMint: p.outputMint, maxInputAmount: p.maxInputAmount, riskEvaluationId: IDS.evaluation as Uuid, actionCycleId: p.actionCycleId, clearedCutoffVersion: p.clearedCutoffVersion, constraints: { maxSlippageBps: p.maxSlippageBps, maxPriceImpactBps: p.maxPriceImpactBps, chaseToleranceBps: p.chaseToleranceBps, maxQuoteAgeMs: p.maxQuoteAgeMs }, protectionPolicyRef: null, targetLotIds: p.targetLotIds, approvalRequired: p.capitalAuthority === 'LIVE_APPROVAL', createdAt: p.issuedAt, expiresAt: p.expiresAt };
}

async function signedAuthorization(key: Awaited<ReturnType<typeof generateSigningKeyPair>>, patch: Partial<RiskAuthorizedIntent> = {}): Promise<SignedRiskAuthorizedIntent> {
  const payload = { ...fixtures.riskAuthorizedIntent(), ...patch } as RiskAuthorizedIntent;
  return signPayload(payload, key, T0) as Promise<SignedRiskAuthorizedIntent>;
}

describe('worker role approvals (§15.6, D41; INV-10)', () => {
  function repo(over: Partial<ApprovalsRepo> & { authorization?: SignedRiskAuthorizedIntent | null; stepUp?: boolean }) {
    const inserted: SignedApprovalGrant[] = [];
    const resolutions: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
    const states: { intentId: Uuid; state: TradeIntentState }[] = [];
    const r: ApprovalsRepo = {
      async listPending() { return [{ id: IDS.message as Uuid, requestedBy: IDS.operator as Uuid, kind: 'APPROVE_AUTHORIZATION', payload: { intentId: IDS.intent }, createdAt: T0 } satisfies PendingControlRequest]; },
      async stepUpVerified() { return over.stepUp ?? true; },
      async loadAuthorization() { return over.authorization === undefined ? null : over.authorization ? { envelope: over.authorization } : null; },
      async insertApproval(e) { inserted.push(e); },
      async setIntentState(intentId, state) { states.push({ intentId, state }); },
      async resolve(id, state, resolution) { resolutions.push({ id, state, resolution }); return true; },
      async approverRole() { return 'operator'; },
      async stepUpEvidence() { return null; },
      async loadRelease() { return null; },
      async applyReleaseStatus() { return false; },
      async insertAttestation() { throw new Error('not used'); },
      async insertCapitalAttestation() { throw new Error('not used'); },
      async paperEvidence() { return { paperCycles: 0, reconciliationClean: true }; },
      async recognizedUsd() { return null; },
      async sleeveConflicts() { return []; },
      ...over,
    };
    return { r, inserted, resolutions, states };
  }
  async function deps(r: ApprovalsRepo, authorizerKeys: Awaited<ReturnType<typeof generateSigningKeyPair>>[]): Promise<ApprovalsDeps> {
    return { repo: r, authorizerKeys, signing: await generateSigningKeyPair(), clock: fixedClock(addMs(T0, 1_000)), logger, readinessPermits: async () => false, liveCapabilityEnabled: false, config: { batchSize: 10, maxValidityMs: 120_000, attestationValidityMs: 600_000, minPaperCycles: 20 } };
  }

  it('grants a bound, signed approval for a verified unexpired authorization with step-up; the grant expires no later than the intent', async () => {
    const authorizerKey = await generateSigningKeyPair();
    const authorization = await signedAuthorization(authorizerKey);
    const f = repo({ authorization });
    const d = await deps(f.r, [authorizerKey]);
    const report = await runApprovalsCycle(d);
    expect(report).toMatchObject({ requests: 1, granted: 1, rejected: 0, cancelled: 0, refused: {}, errors: [] });
    const grant = f.inserted[0]!;
    expect((await verifySignedEnvelope(grant, [d.signing])).ok).toBe(true);
    expect(grant.payload).toMatchObject({ authorizationHash: await deriveAuthorizationHash(authorization), intentId: IDS.intent, approverId: IDS.operator, role: 'operator', stepUpAssertionRef: `step-up:${IDS.message}`, grantedAt: addMs(T0, 1_000) });
    expect(grant.payload.expiresAt <= authorization.payload.expiresAt).toBe(true);
    expect(f.resolutions[0]).toMatchObject({ id: IDS.message, state: 'ACCEPTED', resolution: { intentId: IDS.intent, authorizationHash: grant.payload.authorizationHash, stepUp: true } });
  });

  it('refuses without step-up, on a tampered or foreign-key authorization, when nothing is stored, or for a non-approver; a rejection cancels the intent', async () => {
    const authorizerKey = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const good = await signedAuthorization(authorizerKey);
    const cases: Array<[string, Parameters<typeof repo>[0], Awaited<ReturnType<typeof generateSigningKeyPair>>[], string]> = [
      ['no step-up on an INCREASE', { authorization: good, stepUp: false }, [authorizerKey], 'STEP_UP_REQUIRED'],
      ['tampered amount', { authorization: { ...good, payload: { ...good.payload, maxInputAmount: '999999999999' as never } } }, [authorizerKey], 'AUTHORIZATION_SIGNATURE_INVALID'],
      ['signed by another key', { authorization: await signedAuthorization(other) }, [authorizerKey], 'AUTHORIZATION_SIGNATURE_INVALID'],
      ['nothing stored', { authorization: null }, [authorizerKey], 'NOTHING_TO_APPROVE'],
      ['not an approver', { authorization: good, async approverRole() { return null; } }, [authorizerKey], 'NOT_AN_APPROVER'],
      ['expired authorization', { authorization: await signedAuthorization(authorizerKey, { expiresAt: addMs(T0, 500) as never }) }, [authorizerKey], 'AUTHORIZATION_EXPIRED'],
    ];
    for (const [label, over, keys, reason] of cases) {
      const f = repo(over);
      const report = await runApprovalsCycle(await deps(f.r, keys));
      expect(report.refused, label).toEqual({ [reason]: 1 });
      expect(f.inserted, label).toEqual([]);
      expect(f.resolutions[0], label).toMatchObject({ state: 'REJECTED', resolution: { reason } });
    }
    const rejecting = repo({ authorization: good, async listPending() { return [{ id: IDS.message as Uuid, requestedBy: IDS.operator as Uuid, kind: 'REJECT_AUTHORIZATION', payload: { intentId: IDS.intent }, createdAt: T0 }]; } });
    const report = await runApprovalsCycle(await deps(rejecting.r, [authorizerKey]));
    expect(report).toMatchObject({ cancelled: 1, granted: 0 });
    expect(rejecting.states).toEqual([{ intentId: IDS.intent, state: 'CANCELLED' }]);
    expect(rejecting.inserted).toEqual([]);
  });
});

describe('worker role live-entry (§15.3–15.6, D38; ADR-0009 P3)', () => {
  function repo(over: Partial<LiveEntryRepo> & { gate?: { activity: ActivityState; paused: boolean; authority: CapitalAuthority } | null; pending?: AuthorizedIntentRow[]; approval?: SignedApprovalGrant | null }) {
    const states: { intentId: Uuid; state: TradeIntentState }[] = [];
    const r: LiveEntryRepo = {
      async listAwaitingAuthorization() { return [{ cycle: { id: IDS.cycle as Uuid, strategyVersionId: S0, candidateId: IDS.candidate as Uuid, clearedCutoffVersion: 1, startedAt: T0 }, proposal: fixtures.tradingActionProposal() as never, asset: { id: IDS.asset as Uuid, mint: fixtures.MINTS.RISK as never, decimals: 9, symbol: 'RISK', tokenProgram: 'TOKEN' }, eligibility: null, snapshot: { id: IDS.trigger as Uuid, asOf: T0, features: {} } } satisfies EntryCandidateRow]; },
      async listAuthorizedAwaitingExecution() { return over.pending ?? []; },
      async approvalFor() { return over.approval ?? null; },
      async setIntentState(intentId, state) { states.push({ intentId, state }); },
      async sessionGate() { return over.gate === undefined ? { activity: 'ACTIVE', paused: false, authority: 'LIVE_APPROVAL' } : over.gate; },
      ...over,
    };
    return { r, states };
  }
  const deps = (r: LiveEntryRepo, authorizeOutcome: 'AUTHORIZED' | 'DENIED', envelope: SignedRiskAuthorizedIntent, executed: Record<string, unknown>[] = []): LiveEntryDeps => ({
    repo: r,
    authorizer: { async authorize() { return authorizeOutcome === 'AUTHORIZED' ? { kind: 'AUTHORIZED', envelope, authorizationHash: envelope.payloadHash, intentId: envelope.payload.intentId, projectionSequence: 3 } : { kind: 'DENIED', denial: { intentId: null, actionCycleId: IDS.cycle, deniedAt: T0, reasonCodes: ['CAP_EXCEEDED'], detail: null } }; } },
    executor: { async execute(request) { executed.push(request as unknown as Record<string, unknown>); return { outcome: 'EXECUTED', execution: { attempt: { state: 'FINALIZED' } } }; } },
    clock: fixedClock(addMs(T0, 1_000)),
    logger,
    account: { id: IDS.account as Uuid },
    strategyVersionIds: [S0],
    config: { batchSize: 10, protectionMode: 'MONITORED_EXIT' },
  });

  it('hands cleared cycles to the authorizer only while the live gate is open, and reports denials by code', async () => {
    const key = await generateSigningKeyPair();
    const env = await signedAuthorization(key);
    const open = repo({});
    expect(await runLiveEntryCycle(deps(open.r, 'AUTHORIZED', env))).toMatchObject({ gate: 'LIVE_APPROVAL', awaitingAuthorization: 1, authorized: 1, denied: {} });
    expect(await runLiveEntryCycle(deps(open.r, 'DENIED', env))).toMatchObject({ authorized: 0, denied: { CAP_EXCEEDED: 1 } });
    const paper = repo({ gate: { activity: 'ACTIVE', paused: false, authority: 'PAPER' } });
    expect(await runLiveEntryCycle(deps(paper.r, 'AUTHORIZED', env))).toMatchObject({ gate: 'CLOSED', awaitingAuthorization: 0, authorized: 0 });
    const paused = repo({ gate: { activity: 'ACTIVE', paused: true, authority: 'LIVE_AUTO' } });
    expect(await runLiveEntryCycle(deps(paused.r, 'AUTHORIZED', env))).toMatchObject({ gate: 'CLOSED' });
  });

  it('executes an authorized intent under LIVE_AUTO, waits for a bound grant under LIVE_APPROVAL, and expires by latency instead of executing late', async () => {
    const key = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const env = await signedAuthorization(key, { capitalAuthority: 'LIVE_AUTO' });
    const row: AuthorizedIntentRow = { intent: intent(), envelope: env, authorizationHash: await deriveAuthorizationHash(env), authorizationExpiresAt: env.payload.expiresAt };
    const executed: Record<string, unknown>[] = [];
    const auto = repo({ gate: { activity: 'ACTIVE', paused: false, authority: 'LIVE_AUTO' }, pending: [row] });
    expect(await runLiveEntryCycle(deps(auto.r, 'AUTHORIZED', env, executed))).toMatchObject({ executed: { EXECUTED: 1 }, awaitingApproval: 0 });
    expect(executed[0]).toMatchObject({ capitalAuthority: 'LIVE_AUTO', approvalHash: null, executionPath: 'JUPITER_ORDER' });
    // LIVE_APPROVAL: no grant → waits; a grant bound to another hash → waits; a bound grant → executes with its hash
    const envApproval = await signedAuthorization(key, { capitalAuthority: 'LIVE_APPROVAL' });
    const rowApproval: AuthorizedIntentRow = { ...row, envelope: envApproval, authorizationHash: await deriveAuthorizationHash(envApproval) };
    const waiting = repo({ pending: [rowApproval] });
    expect(await runLiveEntryCycle(deps(waiting.r, 'AUTHORIZED', envApproval))).toMatchObject({ awaitingApproval: 1, executed: {} });
    const badGrant = await signPayload({ authorizationHash: 'ab'.repeat(32), intentId: IDS.intent, approverId: IDS.operator, role: 'operator', stepUpAssertionRef: 'x', grantedAt: T0, expiresAt: addMs(T0, 60_000), nonce: fixtures.NONCE }, approver, T0) as SignedApprovalGrant;
    const unbound = repo({ pending: [rowApproval], approval: badGrant });
    expect(await runLiveEntryCycle(deps(unbound.r, 'AUTHORIZED', envApproval))).toMatchObject({ awaitingApproval: 1, executed: {} });
    const goodGrant = await signPayload({ ...badGrant.payload, authorizationHash: rowApproval.authorizationHash }, approver, T0) as SignedApprovalGrant;
    const executed2: Record<string, unknown>[] = [];
    const bound = repo({ pending: [rowApproval], approval: goodGrant });
    expect(await runLiveEntryCycle(deps(bound.r, 'AUTHORIZED', envApproval, executed2))).toMatchObject({ executed: { EXECUTED: 1 } });
    expect(executed2[0]).toMatchObject({ capitalAuthority: 'LIVE_APPROVAL', approvalHash: goodGrant.payloadHash });
    // expiry: an intent past its expiry is marked EXPIRED and never executed
    const lateRow: AuthorizedIntentRow = { ...row, intent: intent({ expiresAt: T0 }) };
    const late = repo({ gate: { activity: 'ACTIVE', paused: false, authority: 'LIVE_AUTO' }, pending: [lateRow] });
    const executed3: Record<string, unknown>[] = [];
    expect(await runLiveEntryCycle(deps(late.r, 'AUTHORIZED', env, executed3))).toMatchObject({ expiredByLatency: 1, executed: {} });
    expect(late.states).toEqual([{ intentId: lateRow.intent.id, state: 'EXPIRED' }]);
    expect(executed3).toEqual([]);
    // a gate that closed after authorization executes nothing but keeps the authorization for its expiry
    const closed = repo({ gate: { activity: 'ACTIVE', paused: true, authority: 'LIVE_AUTO' }, pending: [row] });
    const executed4: Record<string, unknown>[] = [];
    expect(await runLiveEntryCycle(deps(closed.r, 'AUTHORIZED', env, executed4))).toMatchObject({ gate: 'CLOSED', executed: {} });
    expect(executed4).toEqual([]);
  });
});
