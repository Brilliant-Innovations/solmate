import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMs, canonicalHash, ClearedTransitionSummary, toInstant, type ActionCycle, type AdversarialReview, type Bps, type DiscoveredToken, type MintAddress, type Proposal, type Sha256Hex, type SolanaAddress, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { auditEventAt, auditHead, checkpointAuditChain, FileCheckpointReplicator, verifyAgainstExternalCheckpoint } from './audit.js';
import { loadActionCycle } from './authorizer-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { ensurePaperAccount } from './paper-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion, persistS0Decisions } from './strategies-repo.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('clearance provenance in the audit ledger (ADR-0009 P2)', () => {
  let sql: Sql;
  let dir: string;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'audit-clearance-test' });
    dir = mkdtempSync(join(tmpdir(), 'solmate-audit-'));
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a CLEARED S0 decision writes an ACTION_CYCLE_CLEARED event the cycle row points at, with the proposal hash and Release digest; the head is checkpointable and verifiable', async () => {
    await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-aud-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const versionId = `S0_SAFE@aud-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER', 'EXIT'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'AUD', name: 'Aud', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: {}, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const candidateId = randomUUID() as Uuid;
    await insertCandidate(sql, { id: candidateId, assetId, discoveredAt: NOW, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'DETECTED', featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:aud:1`, strategyVersionIds: [] });

    const cycleId = randomUUID() as Uuid;
    const proposalId = randomUUID() as Uuid;
    const cycle: ActionCycle = { id: cycleId, automationRunId: null, triggerId: candidateId, candidateId, positionId: null, strategyVersionId: versionId, skillVersionId: null, guidelineVersionId: null, speedTier: 'T0_FAST', decisionBudgetMs: 30_000, proposedAction: 'ENTER', proposalId, proposerRunIds: [], adversaryRunIds: [], verdict: 'CONFIRM', reasonCodes: [], revisionRound: 0, state: 'CLEARED', unresolvedReason: null, cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: NOW, terminalAt: NOW };
    const proposal: Proposal = { id: proposalId, actionCycleId: cycleId, candidateId, positionId: null, strategyVersionId: versionId, source: 'DETERMINISTIC', createdAt: NOW, expiresAt: addMs(NOW, 60_000), proposal: { actionType: 'ENTER', direction: 'LONG', candidateId, positionId: null, strategyVersionId: versionId, skillVersionId: null, triggerId: candidateId, thesis: 'deterministic S0', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystEvidenceIds: [], requestedFractionToReduce: null, riskNotes: [], invalidationConditions: [], eventWindowRequest: null } as unknown as Proposal['proposal'] };
    const review: AdversarialReview = { id: randomUUID() as Uuid, actionCycleId: cycleId, agentRunId: null, deterministicGate: true, verdict: 'CONFIRM', objections: [], confidence: 1, cutoffVersion: 1, latencyMs: 0, blocking: false, createdAt: NOW };
    const releaseDigest = 'ab'.repeat(32) as Sha256Hex;
    await persistS0Decisions(sql, candidateId, [{ cycle, proposal, review }], 'QUALIFIED', null, () => releaseDigest);

    const stored = await loadActionCycle(sql, cycleId);
    expect(stored?.clearedAudit).toBeTruthy();
    const ref = stored!.clearedAudit!;
    const event = await auditEventAt(sql, ref.sequence);
    expect(event).toMatchObject({ sequence: ref.sequence, hash: ref.hash, actionClass: 'ACTION_CYCLE_CLEARED', entity: { type: 'action_cycle', id: cycleId } });
    const summary = ClearedTransitionSummary.parse(event!.afterSummary);
    expect(summary).toEqual({ cycleId, proposalId, proposalHash: await canonicalHash(proposal.proposal), cutoffVersion: 1, verdict: 'CONFIRM', strategyVersionId: versionId, releaseDigest, positionId: null, lotIds: [] });
    // the ledger head covers the clearance, and the external checkpoint anchors it
    const head = await auditHead(sql);
    expect(head!.sequence).toBeGreaterThanOrEqual(ref.sequence);
    const replicator = new FileCheckpointReplicator(join(dir, 'checkpoints.jsonl'));
    const cp = await checkpointAuditChain(sql, [replicator]);
    expect(cp?.sequence).toBe(head!.sequence);
    expect(await verifyAgainstExternalCheckpoint(sql, replicator)).toMatchObject({ ok: true, checkpoint: { sequence: head!.sequence } });
    // the pointer is a pair: a lone hash cannot be planted on a cycle
    await expect(sql`update agents.action_cycles set cleared_audit_hash = ${'cd'.repeat(32)} where id = ${cycleId}`).resolves.toBeDefined();
    await expect(sql`update agents.action_cycles set cleared_audit_sequence = null where id = ${cycleId}`).rejects.toThrow();
  });
});
