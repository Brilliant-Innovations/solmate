import { addMs, canonicalHash, DEFAULT_RISK_POLICY, fixtures, generateSigningKeyPair, signPayload, toInstant, verifySignedEnvelope, type ActionCycle, type Amount, type Bps, type MintAddress, type Nonce, type Proposal, type Release, type ReleaseAttestation, type RiskStateProjection, type Sequence, type Sha256Hex, type Slot, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { authorizeEntry, type AuthorizeEntryInput } from './authorize.js';
import { AuthorizationLedger } from './ledger.js';
import type { IndependentChainReads } from '../projection/verify.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const FP = 'ab'.repeat(32) as Sha256Hex;
const USDC = fixtures.MINTS.USDC as MintAddress;
const TOKEN = fixtures.MINTS.RISK as MintAddress;
let nonceSeq = 0;
const newNonce = () => String(++nonceSeq).padStart(32, '0') as Nonce;
let idSeq = 100;
const newId = () => `${String(++idSeq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;

async function harness(over: { authority?: 'PAPER' | 'LIVE_APPROVAL' | 'LIVE_AUTO'; projection?: Partial<RiskStateProjection>; cycle?: Partial<ActionCycle>; chain?: IndependentChainReads | null; mint?: AuthorizeEntryInput['mint']; quote?: AuthorizeEntryInput['quote'] } = {}) {
  const signing = await generateSigningKeyPair();
  const projector = await generateSigningKeyPair();
  const authority = over.authority ?? 'LIVE_APPROVAL';
  const binding: Release['binding'] = {
    strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: 'skill@1' as VersionId, guidelineVersionId: 'guide@1' as VersionId, automationSetVersionId: 'auto@1' as VersionId, proposerModelPolicyVersion: null,
    adversaryModelPolicyVersion: 'adv@1' as VersionId, riskPolicyVersion: DEFAULT_RISK_POLICY.version, cohortPolicyVersion: 'cohorts@1' as VersionId, freshnessPolicyVersion: 'fresh@1' as VersionId, executorPolicyRef: 'exec@1' as VersionId, contractSetDigest: 'cd'.repeat(32) as Sha256Hex,
  };
  const release: Release = { id: fixtures.IDS.release as Uuid, digest: await canonicalHash(binding), binding, status: authority === 'PAPER' ? 'PAPER_VALIDATED' : 'ARMED', createdAt: NOW, promotedAt: NOW, retiredAt: null };
  const attestation: ReleaseAttestation = { id: fixtures.IDS.attestation as Uuid, releaseId: release.id, releaseDigest: release.digest, purpose: 'ARM', operatorId: fixtures.IDS.operator as Uuid, operatorRole: 'admin', credentialId: 'cred', credentialFingerprint: FP, challenge: 'c'.repeat(32), verificationResult: true, attestedAt: NOW, expiresAt: addMs(NOW, 3_600_000) };
  const projection: RiskStateProjection = {
    ...fixtures.riskStateProjection(), asOf: addMs(NOW, -3_000), releaseDigest: release.digest, policyVersion: DEFAULT_RISK_POLICY.version,
    sleeves: [{ sleeveId: fixtures.IDS.sleeve as Uuid, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, committedBaseUnits: '0' as Amount, capBaseUnits: '2000000000' as Amount, riskRemainingBaseUnits: '100000000' as Amount }],
    ...over.projection,
  };
  const chain: IndependentChainReads | null = over.chain === undefined ? { slot: (projection.chainSlot + 2) as Slot, settlementBaseUnits: projection.settlementAvailableBaseUnits, gasLamports: projection.gasReserveLamports, custody: projection.custody } : over.chain;
  const cycle: ActionCycle = {
    id: fixtures.IDS.cycle as Uuid, automationRunId: null, triggerId: fixtures.IDS.trigger as Uuid, candidateId: fixtures.IDS.candidate as Uuid, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: null, guidelineVersionId: null,
    speedTier: 'T0_FAST', decisionBudgetMs: 30_000, proposedAction: 'ENTER', proposalId: fixtures.IDS.intent as Uuid, proposerRunIds: [], adversaryRunIds: [], verdict: 'CONFIRM', reasonCodes: [], revisionRound: 0, state: 'CLEARED', unresolvedReason: null,
    cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: addMs(NOW, -10_000), terminalAt: addMs(NOW, -9_000), ...over.cycle,
  };
  const proposal: Proposal = {
    id: fixtures.IDS.intent as Uuid, actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, source: 'DETERMINISTIC', createdAt: cycle.startedAt, expiresAt: addMs(NOW, 300_000),
    proposal: { actionType: 'ENTER', direction: 'LONG', candidateId: cycle.candidateId, positionId: null, strategyVersionId: 'S0_SAFE@1.0.0' as VersionId, skillVersionId: null, triggerId: cycle.triggerId, thesis: 't', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 240, confidence: 0.7, invalidation: 'i', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 300_000), reasoningSummary: 'r', evidenceCutoffVersion: 1 },
  };
  const ledger = new AuthorizationLedger();
  const input: AuthorizeEntryInput = {
    now: NOW, cycle, proposal,
    asset: { id: fixtures.IDS.asset as Uuid, mint: TOKEN, decimals: 9, tokenProgram: 'TOKEN', settlementRouteConfirmed: true },
    quote: over.quote === undefined ? { ageMs: 2_000, impactBps: 20 as Bps, slippageBps: 100 as Bps, priceUsd: 1, atrPct: 0.02, liquidityUsd: 800_000 } : over.quote,
    release, attestation, projection: await signPayload(projection, projector, NOW), chain,
    mint: over.mint === undefined ? { isInitialized: true, mintAuthority: 'NONE', freezeAuthority: 'NONE', readSlot: projection.chainSlot + 2 } : over.mint,
    sessionAllowsEntries: true,
    account: { id: fixtures.IDS.account as Uuid, cluster: 'mainnet-beta', capitalAuthority: authority, settlementDecimals: 6 },
    policy: DEFAULT_RISK_POLICY,
    keys: { signing, projection: [projector], trustedAttestationFingerprints: [FP] },
    ledger, lastProjectionSequence: 41 as Sequence,
    config: { projectionMaxAgeMs: 30_000, intentExpiryMs: 60_000, balanceToleranceBps: 10, maxSlotLag: 150 },
    newNonce, newIntentId: newId,
  };
  return { input, signing, projector, projection, release };
}

describe('risk-authorizer entry authorization (D21, D45, D52, §13.7, §15.5)', () => {
  it('a cleared cycle over a verified projection with agreeing chain reads yields a signed envelope bound to the recomputed maximum; the executor can verify it with the pinned key', async () => {
    const { input, signing } = await harness();
    const out = await authorizeEntry(input);
    expect(out.kind).toBe('AUTHORIZED');
    if (out.kind !== 'AUTHORIZED') return;
    expect(await verifySignedEnvelope(out.envelope, [signing])).toEqual({ ok: true, keyId: signing.keyId });
    const p = out.envelope.payload;
    expect(p).toMatchObject({ actionCycleId: fixtures.IDS.cycle, clearedCutoffVersion: 1, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: TOKEN, capitalAuthority: 'LIVE_APPROVAL', approvalRequired: true, projectionSequence: 42, sleeveId: fixtures.IDS.sleeve, policyVersion: 'risk-v1' });
    // INV-02: 5 000 USDC equity, 0.5 % risk, 4 % ATR stop → 625 USDC by stop, capped by max position value 200 USDC
    expect(p.maxInputAmount).toBe('200000000');
    const { intentHash, ...unsigned } = p;
    expect(intentHash).toBe(await canonicalHash(unsigned));
    expect(p.projectionHash).toBe(input.projection.payloadHash);
    expect(input.ledger.pendingExposure(NOW)).toBe('200000000');
    // the same cycle is never authorized twice (idempotent redelivery)
    const again = await authorizeEntry(input);
    expect(again.kind).toBe('DENIED');
    if (again.kind === 'DENIED') expect(again.denial.reasonCodes).toEqual(['CYCLE_ALREADY_AUTHORIZED']);
  });

  it('INV-14: an uncleared, challenged, stale-cutoff or non-entry cycle, or a proposal that does not belong to it, is denied before any sizing', async () => {
    const cases: [Partial<ActionCycle>, string][] = [
      [{ state: 'REJECTED', verdict: 'REJECT' }, 'CYCLE_NOT_CLEARED'],
      [{ state: 'UNRESOLVED', verdict: 'CHALLENGE', unresolvedReason: 'REVISION_EXHAUSTED' }, 'CYCLE_NOT_CLEARED'],
      [{ cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }, { version: 2, at: NOW, consumedByRunIds: [] }] }, 'CYCLE_CUTOFF_STALE'],
      [{ proposedAction: 'HOLD' }, 'CYCLE_ACTION_NOT_ENTRY'],
      [{ proposalId: newId() }, 'PROPOSAL_CYCLE_MISMATCH'],
    ];
    for (const [cycle, reason] of cases) {
      const { input } = await harness({ cycle });
      const out = await authorizeEntry(input);
      expect(out.kind, reason).toBe('DENIED');
      if (out.kind === 'DENIED') expect(out.denial.reasonCodes, reason).toContain(reason);
    }
  });

  it('INV-07 and D45: a projection that disagrees with chain, a missing chain read for live authority, or a mint whose authorities are not proven absent is denied', async () => {
    const base = await harness();
    const wider = await harness({ projection: { settlementAvailableBaseUnits: '9000000000' as Amount }, chain: base.input.chain });
    const w = await authorizeEntry(wider.input);
    expect(w.kind === 'DENIED' && w.denial.reasonCodes).toEqual(['CHAIN_SETTLEMENT_DISAGREES']);
    const noChain = await harness({ chain: null });
    expect((await authorizeEntry(noChain.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CHAIN_READS_REQUIRED'] } });
    const mintAuth = await harness({ mint: { isInitialized: true, mintAuthority: 'PRESENT', freezeAuthority: 'NONE', readSlot: 1 } });
    expect((await authorizeEntry(mintAuth.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CHAIN_MINT_AUTHORITY_PRESENT'] } });
    const unknown = await harness({ mint: { isInitialized: true, mintAuthority: 'NONE', freezeAuthority: 'UNKNOWN', readSlot: 1 } });
    expect((await authorizeEntry(unknown.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CHAIN_FREEZE_AUTHORITY_UNKNOWN'] } });
    // paper authority needs no chain reads and no mint read
    const paper = await harness({ authority: 'PAPER', chain: null, mint: null });
    expect((await authorizeEntry(paper.input)).kind).toBe('AUTHORIZED');
  });

  it('INV-03, INV-28, INV-18 and the session gate: ineligible asset, crossed capital ceiling, unattested release and a closed session each deny', async () => {
    const ineligible = await harness({ projection: { eligibilitySummary: [{ assetId: fixtures.IDS.asset as Uuid, evaluationId: fixtures.IDS.evaluation as Uuid, eligible: false, evaluatedAt: NOW }] } });
    expect((await authorizeEntry(ineligible.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['NOT_ELIGIBLE'] } });
    const noRecord = await harness({ projection: { eligibilitySummary: [] } });
    expect((await authorizeEntry(noRecord.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['NOT_ELIGIBLE'] } });
    const ceiling = await harness({ projection: { capitalAttestation: { ceilingUsd: 5000, recognizedUsd: 5001, reattestRequired: false } } });
    expect((await authorizeEntry(ceiling.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['CAPITAL_CEILING_EXCEEDED'] } });
    const unattested = await harness();
    unattested.input.attestation = null;
    expect((await authorizeEntry(unattested.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['ATTESTATION_MISSING'] } });
    const closed = await harness();
    closed.input.sessionAllowsEntries = false;
    expect((await authorizeEntry(closed.input)) as never).toMatchObject({ kind: 'DENIED', denial: { reasonCodes: ['SESSION_NOT_ACTIVE'] } });
  });

  it('ADR-0009 P1: the authorizer counts its own unconsumed authorizations as spent, so a second cycle cannot take the same capital and a third waits for the first to finish', async () => {
    const first = await harness();
    const one = await authorizeEntry(first.input);
    expect(one.kind).toBe('AUTHORIZED');
    // a second cycle against the same projection sequence would be a rollback; advance the sequence as a fresh projection would
    const second = await harness({ projection: { sequence: 43 as Sequence }, cycle: { id: newId(), proposalId: fixtures.IDS.intent as Uuid } });
    second.input.ledger = first.input.ledger;
    second.input.lastProjectionSequence = 42 as Sequence;
    const two = await authorizeEntry(second.input);
    expect(two.kind).toBe('DENIED');
    if (two.kind === 'DENIED') expect(two.denial.reasonCodes).toContain('EXPOSURE_IN_FLIGHT');
    // once the executor reports the first as finished, capital frees but the pending amount stays counted until consumed
    const nonce = first.input.ledger.nonceForCycle(fixtures.IDS.cycle as Uuid)!;
    expect(first.input.ledger.consume(nonce, NOW)).toBe(true);
    expect(first.input.ledger.consume(nonce, NOW)).toBe(false);
    expect(first.input.ledger.pendingExposure(NOW)).toBe('0');
    const three = await authorizeEntry(second.input);
    expect(three.kind).toBe('AUTHORIZED');
  });
});
