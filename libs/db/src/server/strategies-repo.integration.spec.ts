import { randomUUID } from 'node:crypto';
import { addMs, DEFAULT_S0_SAFETY_GATE_POLICY, S0_STRATEGY_VERSION_IDS, toInstant, type ActionCycle, type Candidate, type DiscoveredToken, type FeatureSnapshot, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion, listCandidatesAwaitingStrategy, listCyclesForCandidate, persistS0Decisions, type PersistedDecision } from './strategies-repo.js';

const url = databaseUrlFromEnv();

/** A strategy version shaped like S0 but under a test-only version id, so the S0 rows the worker registers are untouched. */
function testStrategy(versionId: string): StrategyVersion {
  return {
    id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId: versionId as StrategyVersion['versionId'], variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {},
    riskPolicyVersion: 'risk-v1' as never, skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: DEFAULT_S0_SAFETY_GATE_POLICY.maxCandidateAgeMs, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as never,
    allowedActionTypes: ['ENTER', 'IGNORE'], reassessmentPolicy: {}, adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {},
    outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 }, eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null },
    attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: toInstant(Date.UTC(2026, 8, 8)), activeTo: null,
  };
}

describe.skipIf(!url)('strategies repository (§6.21, §6.10D, §6.11)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mint = () => Array.from({ length: 44 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('') as DiscoveredToken['mintAddress'];
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'strategies-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('registers a strategy version once, lists candidates awaiting it with their point-in-time snapshot, persists a decision pair atomically and refuses a second decision on the same candidate', async () => {
    const versionId = `S0_SAFE@test-${randomUUID().slice(0, 8)}`;
    const strategy = testStrategy(versionId);
    expect(await ensureStrategyVersion(sql, strategy)).toBe('INSERTED');
    expect(await ensureStrategyVersion(sql, strategy)).toBe('EXISTS');
    void S0_STRATEGY_VERSION_IDS;

    const [a] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint(), symbol: 'S', name: 'S', decimals: 6, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = a!.id;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 100, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const older: FeatureSnapshot = { id: randomUUID() as Uuid, assetId, asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_1h: 0.05 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false };
    const newer: FeatureSnapshot = { ...older, id: randomUUID() as Uuid, asOf: NOW, features: { ret_1h: 0.9 } };
    await insertFeatureSnapshot(sql, older);
    await insertFeatureSnapshot(sql, newer);
    const candidate: Candidate = { id: randomUUID() as Uuid, assetId, discoveredAt: addMs(NOW, -30_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'DETECTED', featureSnapshotId: older.id, eligibilityEvaluationId: eligibilityId, /* far expiry: the candidates-repo spec expires everything due within ten minutes of its NOW */ expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:MOMENTUM_CONTINUATION:1`, strategyVersionIds: [] };
    await insertCandidate(sql, candidate);

    const awaiting = await listCandidatesAwaitingStrategy(sql, strategy.versionId, NOW, 10_000);
    const mine = awaiting.find((x) => x.candidate.id === candidate.id);
    expect(mine).toBeDefined();
    // the snapshot the candidate was detected on, not the newer one
    expect(mine!.snapshot.id).toBe(older.id);
    expect(mine!.snapshot.features).toEqual({ ret_1h: 0.05 });
    expect(mine!.candidate).toMatchObject({ scannerScore: 70, eligibilityEvaluationId: eligibilityId });

    const decision = (verdict: 'CONFIRM' | 'REJECT', codes: string[]): PersistedDecision => {
      const proposalId = randomUUID() as Uuid;
      // Terminal cycle shaped as the machine in libs/agents produces it (the db lib does not depend on agents).
      const cleared = verdict === 'CONFIRM';
      const cycle: ActionCycle = { id: randomUUID() as Uuid, automationRunId: null, triggerId: candidate.id, candidateId: candidate.id, positionId: null, strategyVersionId: strategy.versionId, skillVersionId: null, guidelineVersionId: null, speedTier: 'T0_FAST', decisionBudgetMs: 30_000, proposedAction: 'ENTER', proposalId, proposerRunIds: [], adversaryRunIds: [], verdict, reasonCodes: codes, revisionRound: 0, state: cleared ? 'CLEARED' : 'REJECTED', unresolvedReason: null, cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }], clearedCutoffVersion: cleared ? 1 : null, riskEvaluationId: null, intentId: null, startedAt: NOW, terminalAt: NOW };
      return {
        cycle,
        proposal: { id: proposalId, actionCycleId: cycle.id, candidateId: candidate.id, positionId: null, strategyVersionId: strategy.versionId, source: 'DETERMINISTIC', createdAt: NOW, expiresAt: addMs(NOW, 60_000), proposal: { actionType: 'ENTER', direction: 'LONG', candidateId: candidate.id, positionId: null, strategyVersionId: strategy.versionId, skillVersionId: null, triggerId: candidate.id, thesis: 't', supportingEvidenceIds: [older.id], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 60, confidence: 0.7, invalidation: 'i', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 60_000), reasoningSummary: 'r', evidenceCutoffVersion: 1 } },
        review: { id: randomUUID() as Uuid, actionCycleId: cycle.id, agentRunId: null, deterministicGate: true, verdict, objections: codes.map((code) => ({ code, detail: code, evidenceIds: [older.id] })), confidence: 1, cutoffVersion: 1, latencyMs: 0, blocking: true, createdAt: NOW },
      };
    };
    await persistS0Decisions(sql, candidate.id, [decision('REJECT', ['OVEREXTENDED_1H'])], 'REJECTED', 'OVEREXTENDED_1H');
    const [row] = await sql<{ status: string; deterministic_rejection_reason: string | null; strategy_version_ids: string[] }[]>`select status, deterministic_rejection_reason, strategy_version_ids from signals.candidates where id = ${candidate.id}`;
    expect(row).toEqual({ status: 'REJECTED', deterministic_rejection_reason: 'OVEREXTENDED_1H', strategy_version_ids: [strategy.versionId] });
    const stored = await listCyclesForCandidate(sql, candidate.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.cycle).toMatchObject({ strategyVersionId: strategy.versionId, state: 'REJECTED', verdict: 'REJECT', reasonCodes: ['OVEREXTENDED_1H'] });
    expect(stored[0]!.review).toMatchObject({ verdict: 'REJECT', deterministicGate: true, blocking: true });
    expect(stored[0]!.review!.objections[0]).toMatchObject({ code: 'OVEREXTENDED_1H' });
    // no longer awaiting, and a second decision on the same candidate rolls back entirely
    expect((await listCandidatesAwaitingStrategy(sql, strategy.versionId, NOW, 10_000)).some((x) => x.candidate.id === candidate.id)).toBe(false);
    await expect(persistS0Decisions(sql, candidate.id, [decision('CONFIRM', [])], 'QUALIFIED', null)).rejects.toThrow(/no longer DETECTED/);
    expect(await listCyclesForCandidate(sql, candidate.id)).toHaveLength(1);
  });
});
