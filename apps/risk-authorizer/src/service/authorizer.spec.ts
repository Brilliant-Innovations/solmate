import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addMs, canonicalHash, DEFAULT_RISK_POLICY, fixtures, generateSigningKeyPair, signPayload, signServiceRequest, toInstant, verifySignedEnvelope, type ActionCycle, type Amount, type Bps, type MintAddress, type Proposal, type Release, type ReleaseAttestation, type RiskStateProjection, type Sequence, type Sha256Hex, type SigningKeyPair, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { close, listen } from '../api/http.js';
import { createAuthorizerApi } from '../api/internal.js';
import { AuthorizerService, type AuthorizerSources } from './authorizer.js';

/**
 * The authorizer service over stubbed sources and its API over loopback (§13.7, §15.5, §15.8):
 * a cleared cycle for a LIVE account with fresh projection and agreeing chain reads yields a
 * persisted, verifiable envelope exactly once; paper accounts, missing rows, a failed chain read
 * and an unauthenticated caller are refused.
 */

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const FP = 'ab'.repeat(32) as Sha256Hex;
const USDC = fixtures.MINTS.USDC as MintAddress;
const TOKEN = fixtures.MINTS.RISK as MintAddress;
const WALLET = fixtures.WALLET as never;
const SECRET = randomBytes(32).toString('hex');
let idSeq = 500;
const newId = () => `${String(++idSeq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const logger = createLogger({ service: 'risk-authorizer', sink: () => undefined });

interface Stub {
  sources: AuthorizerSources;
  signing: SigningKeyPair;
  projector: SigningKeyPair;
  persisted: Parameters<AuthorizerSources['persistAuthorization']>[0][];
  denials: Parameters<AuthorizerSources['persistDenial']>[0][];
  cycle: ActionCycle;
}

async function stub(over: { mode?: 'LIVE' | 'PAPER'; chainFails?: boolean; open?: Awaited<ReturnType<AuthorizerSources['openAuthorizations']>> } = {}): Promise<Stub> {
  const signing = await generateSigningKeyPair();
  const projector = await generateSigningKeyPair();
  const binding: Release['binding'] = { strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: 'skill@1' as VersionId, guidelineVersionId: 'guide@1' as VersionId, automationSetVersionId: 'auto@1' as VersionId, proposerModelPolicyVersion: null, adversaryModelPolicyVersion: 'adv@1' as VersionId, riskPolicyVersion: DEFAULT_RISK_POLICY.version, cohortPolicyVersion: 'cohorts@1' as VersionId, freshnessPolicyVersion: 'fresh@1' as VersionId, executorPolicyRef: 'exec@1' as VersionId, contractSetDigest: 'cd'.repeat(32) as Sha256Hex };
  const release: Release = { id: fixtures.IDS.release as Uuid, digest: await canonicalHash(binding), binding, status: 'ARMED', createdAt: NOW, promotedAt: NOW, retiredAt: null };
  const attestation: ReleaseAttestation = { id: fixtures.IDS.attestation as Uuid, releaseId: release.id, releaseDigest: release.digest, purpose: 'ARM', operatorId: fixtures.IDS.operator as Uuid, operatorRole: 'admin', credentialId: 'cred', credentialFingerprint: FP, challenge: 'c'.repeat(32), verificationResult: true, attestedAt: NOW, expiresAt: addMs(NOW, 3_600_000) };
  const projection: RiskStateProjection = { ...fixtures.riskStateProjection(), asOf: addMs(NOW, -3_000), releaseDigest: release.digest, policyVersion: DEFAULT_RISK_POLICY.version, sleeves: [{ sleeveId: fixtures.IDS.sleeve as Uuid, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, committedBaseUnits: '0' as Amount, capBaseUnits: '2000000000' as Amount, riskRemainingBaseUnits: '100000000' as Amount }] };
  const cycle: ActionCycle = {
    id: fixtures.IDS.cycle as Uuid, automationRunId: null, triggerId: fixtures.IDS.trigger as Uuid, candidateId: fixtures.IDS.candidate as Uuid, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: null, guidelineVersionId: null,
    speedTier: 'T0_FAST', decisionBudgetMs: 30_000, proposedAction: 'ENTER', proposalId: fixtures.IDS.intent as Uuid, proposerRunIds: [], adversaryRunIds: [], verdict: 'CONFIRM', reasonCodes: [], revisionRound: 0, state: 'CLEARED', unresolvedReason: null,
    cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: addMs(NOW, -10_000), terminalAt: addMs(NOW, -9_000),
  };
  const proposal: Proposal = {
    id: fixtures.IDS.intent as Uuid, actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, source: 'DETERMINISTIC', createdAt: cycle.startedAt, expiresAt: addMs(NOW, 300_000),
    proposal: { actionType: 'ENTER', direction: 'LONG', candidateId: cycle.candidateId, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: null, triggerId: cycle.triggerId, thesis: 't', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 240, confidence: 0.7, invalidation: 'i', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 300_000), reasoningSummary: 'r', evidenceCutoffVersion: 1 },
  };
  const persisted: Stub['persisted'] = [];
  const denials: Stub['denials'] = [];
  const signedProjection = await signPayload(projection, projector, NOW);
  const sources: AuthorizerSources = {
    cycle: async (id) => (id === cycle.id ? cycle : null),
    proposal: async (id) => (id === proposal.id ? proposal : null),
    candidateAsset: async () => ({ asset: { id: fixtures.IDS.asset as Uuid, mint: TOKEN, decimals: 9, tokenProgram: 'TOKEN', settlementRouteConfirmed: true }, eligibility: { id: fixtures.IDS.evaluation as Uuid, liquidityUsd: 800_000 }, features: { atr_14_pct: 0.02, price_usd: 1, liquidity_usd: 800_000 }, featuresAsOf: addMs(NOW, -60_000) }),
    account: async (id) => ({ id, cluster: 'mainnet-beta', tradingWallet: WALLET, settlementMint: USDC, settlementDecimals: 6, mode: over.mode ?? 'LIVE' }),
    sessionGate: async () => ({ activity: 'ACTIVE', paused: false, authority: 'LIVE_APPROVAL' }),
    custodyAccounts: async () => [{ id: fixtures.IDS.custody as Uuid, address: WALLET, mint: USDC }],
    release: async () => release,
    attestation: async () => attestation,
    projection: async () => ({ envelope: signedProjection, sequence: projection.sequence }),
    chain: async () => {
      if (over.chainFails) throw new Error('rpc unreachable');
      return { slot: (projection.chainSlot + 2) as never, settlementBaseUnits: projection.settlementAvailableBaseUnits, gasLamports: projection.gasReserveLamports, custody: projection.custody };
    },
    mint: async () => ({ isInitialized: true, mintAuthority: 'NONE', freezeAuthority: 'NONE', readSlot: projection.chainSlot + 2 }),
    referenceQuote: async () => ({ impactBps: 20 as Bps, slippageBps: 100 as Bps, priceUsd: 1, quotedAtMs: Date.parse(NOW) - 2_000 }),
    openAuthorizations: async () => over.open ?? [],
    persistAuthorization: async (input) => { persisted.push(input); },
    persistDenial: async (d) => { denials.push(d); },
  };
  return { sources, signing, projector, persisted, denials, cycle };
}

async function service(s: Stub) {
  return AuthorizerService.create({ sources: s.sources, signing: s.signing, projectionKeys: [s.projector], trustedAttestationFingerprints: [FP], policy: DEFAULT_RISK_POLICY, clock: { now: () => NOW, nowMs: () => Date.parse(NOW) } as never, logger, newId, config: { projectionMaxAgeMs: 30_000, intentExpiryMs: 60_000, balanceToleranceBps: 10, maxSlotLag: 150 } });
}

describe('risk-authorizer service and API', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solmate-authorizer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('authorizes a cleared LIVE cycle once, persists evaluation + intent + envelope, and a redelivery is denied as already authorized', async () => {
    const s = await stub();
    const svc = await service(s);
    const out = await svc.authorize({ actionCycleId: s.cycle.id, accountId: fixtures.IDS.account as Uuid });
    expect(out.kind).toBe('AUTHORIZED');
    if (out.kind !== 'AUTHORIZED') return;
    expect(await verifySignedEnvelope(out.envelope, [s.signing])).toEqual({ ok: true, keyId: s.signing.keyId });
    expect(out.envelope.payload).toMatchObject({ actionCycleId: s.cycle.id, maxInputAmount: '200000000', capitalAuthority: 'LIVE_APPROVAL', approvalRequired: true, inputMint: USDC, outputMint: TOKEN });
    expect(s.persisted).toHaveLength(1);
    const p = s.persisted[0]!;
    expect(p.intent).toMatchObject({ id: out.intentId, idempotencyKey: `entry:${s.cycle.id}`, riskEvaluationId: p.evaluation.id, maxInputAmount: '200000000', actionCycleId: s.cycle.id, exposureEffect: 'INCREASE' });
    expect(p.evaluation).toMatchObject({ actionCycleId: s.cycle.id, allowed: true, computedPositionAmount: '200000000' });
    expect(p.authorizationHash).toBe(out.authorizationHash);
    expect(svc.ledger.pendingExposure(NOW)).toBe('200000000');
    const again = await svc.authorize({ actionCycleId: s.cycle.id, accountId: fixtures.IDS.account as Uuid });
    expect(again).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CYCLE_ALREADY_AUTHORIZED'] } });
    expect(s.persisted).toHaveLength(1);
    expect(s.denials).toHaveLength(1);
  });

  it('a restart rebuilds pending exposure from stored open authorizations, so the same cycle cannot be signed twice across processes', async () => {
    const s = await stub({ open: [{ nonce: 'ab'.repeat(16) as never, intentId: newId(), actionCycleId: fixtures.IDS.cycle as Uuid, sleeveId: fixtures.IDS.sleeve as Uuid, exposureEffect: 'INCREASE', maxInputAmount: '150000000', issuedAt: NOW, expiresAt: addMs(NOW, 50_000) }] });
    const svc = await service(s);
    expect(svc.ledger.pendingExposure(NOW)).toBe('150000000');
    const out = await svc.authorize({ actionCycleId: s.cycle.id, accountId: fixtures.IDS.account as Uuid });
    expect(out).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CYCLE_ALREADY_AUTHORIZED'] } });
  });

  it('refuses a paper account, an unknown cycle, and a failed chain read, without signing anything', async () => {
    const paper = await service(await stub({ mode: 'PAPER' }));
    expect(await paper.authorize({ actionCycleId: fixtures.IDS.cycle as Uuid, accountId: fixtures.IDS.account as Uuid })).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['ACCOUNT_NOT_LIVE'] } });
    const s = await stub();
    const svc = await service(s);
    expect(await svc.authorize({ actionCycleId: newId(), accountId: fixtures.IDS.account as Uuid })).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CYCLE_NOT_FOUND'] } });
    const broken = await stub({ chainFails: true });
    const b = await service(broken);
    expect(await b.authorize({ actionCycleId: broken.cycle.id, accountId: fixtures.IDS.account as Uuid })).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CHAIN_READ_FAILED'] } });
    expect(broken.persisted).toHaveLength(0);
    expect(s.persisted).toHaveLength(0);
  });

  it('the API authorizes only behind the shared secret and exposes nothing else', async () => {
    const s = await stub();
    const svc = await service(s);
    const server = createAuthorizerApi({ service: svc, secretsHex: [SECRET], clock: { now: () => NOW, nowMs: () => Date.parse(NOW) } as never, logger, contractSetDigest: 'digest', signingKeyId: s.signing.keyId });
    const a = await listen(server, { host: '127.0.0.1', port: 0 });
    try {
      const body = JSON.stringify({ actionCycleId: s.cycle.id, accountId: fixtures.IDS.account });
      const headers = await signServiceRequest(SECRET, { method: 'POST', path: '/v1/authorize', body }, { nowMs: Date.parse(NOW), nonce: 'authorize-nonce-0000001' });
      const res = await fetch(`${a.url}/v1/authorize`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { kind: string; envelope?: { keyId: string } };
      expect(out.kind).toBe('AUTHORIZED');
      expect(out.envelope?.keyId).toBe(s.signing.keyId);
      const bare = await fetch(`${a.url}/v1/authorize`, { method: 'POST', body });
      expect(bare.status).toBe(401);
      const h2 = await signServiceRequest(SECRET, { method: 'GET', path: '/v1/health', body: '' }, { nowMs: Date.parse(NOW), nonce: 'health-nonce-000000001' });
      const health = await fetch(`${a.url}/v1/health`, { headers: { ...h2 } });
      expect(await health.json()).toMatchObject({ service: 'risk-authorizer', signingKeyId: s.signing.keyId, openAuthorizations: 1 });
      const h3 = await signServiceRequest(SECRET, { method: 'POST', path: '/v1/sign', body: '{}' }, { nowMs: Date.parse(NOW), nonce: 'sign-nonce-00000000001' });
      expect((await fetch(`${a.url}/v1/sign`, { method: 'POST', headers: { ...h3, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally {
      await close(server);
    }
  });
});

export type { Sequence };
