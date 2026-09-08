import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type ActionCycle, type AdversarialReview, type AgentRun, type Bps, type DiscoveredToken, type MintAddress, type Proposal, type QueueMessageEnvelope, type Sha256Hex, type SkillVersion, type SolanaAddress, type ToolInvocation, type ToolRefusal, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { PgmqClient } from './queue-client.js';
import { chargeSpendUsage, ensureSkillVersion, ensureSpendBudget, listActiveSpendBudgets, listSpendUsageAt, loadCycleSummary, loadSkillVersion, pauseSpendWindow, persistDiscretionaryOutcome, spendWindow } from './agents-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { ensurePaperAccount } from './paper-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion } from './strategies-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;

describe.skipIf(!url)('agents repository (§6.10, D39, D43; ADR-0001 amendment)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 16, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'agents-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('persists a position cycle with runs, proposal, review, tool audit, the review transition and the outbox message atomically', async () => {
    const suffix = randomUUID().slice(0, 8);
    const strategyVersionId = `S1@agents-${suffix}` as VersionId;
    const skillVersionId = `skill@agents-${suffix}` as VersionId;
    const skill: SkillVersion = { id: randomUUID() as Uuid, skillId: 'trading-skill', versionId: skillVersionId, gitSha: 'abcdef1' as SkillVersion['gitSha'], toolManifestVersion: 'tools-v1' as VersionId, guidelineVersion: 'guide-v1' as VersionId, supportedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'], workflowGraphVersion: 'wf-v1' as VersionId, contextBuilderVersion: 'ctx-v1' as VersionId, proposerModelPolicyVersion: 'prop-v1' as VersionId, adversaryPolicyRequired: true, status: 'PAPER', effectiveFrom: NOW, effectiveTo: null };
    expect(await ensureSkillVersion(sql, skill)).toBe('INSERTED');
    expect(await ensureSkillVersion(sql, skill)).toBe('EXISTS');
    expect(await loadSkillVersion(sql, skillVersionId)).toMatchObject({ versionId: skillVersionId, toolManifestVersion: 'tools-v1', adversaryPolicyRequired: true });
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S1', versionId: strategyVersionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v2' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId, guidelineVersionId: 'guide-v1' as VersionId, automationSetVersionId: null, speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 60_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER', 'HOLD', 'REDUCE', 'EXIT'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: 'anthropic/x', adversaryModel: 'openai/y', deterministicGate: false }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `agents-test-${suffix}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const mint = b58(44) as MintAddress;
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint as DiscoveredToken['mintAddress'], symbol: 'AGT', name: 'Agents', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const positionId = randomUUID() as Uuid;
    await sql`insert into trading.positions (id, account_id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, custody_split, status, review_state, review_state_reason, review_state_since, safety_state, opened_at)
      values (${positionId}, ${account.id}, ${asset!.id}, ${mint}, '1000', 1, '1000', '0', '0', '{"wallet":"1000","providerVault":"0"}'::jsonb, 'OPEN', 'REVIEWED', null, ${NOW}, 'NORMAL', ${NOW})`;

    const cycleId = randomUUID() as Uuid;
    const proposalId = randomUUID() as Uuid;
    const runIds = [randomUUID() as Uuid, randomUUID() as Uuid];
    const run = (i: number, role: AgentRun['role']): AgentRun => ({ id: runIds[i]!, actionCycleId: cycleId, candidateId: null, positionId, role, provider: i === 0 ? 'anthropic' : 'openai', model: 'm', promptVersion: 'p@1' as VersionId, temperature: 0.2, reasoningConfig: null, inputEvidenceIds: [], cutoffVersion: 1, cutoffAt: NOW, structuredOutput: { ok: true }, tokens: { input: 10, output: 5 }, costUsd: 0.002, latencyMs: 120, success: true, schemaValidation: { ok: true, errors: [] }, createdAt: NOW });
    const cycle: ActionCycle = { id: cycleId, automationRunId: null, triggerId: positionId, candidateId: null, positionId, strategyVersionId, skillVersionId, guidelineVersionId: 'guide-v1' as VersionId, speedTier: 'T2_CONTEXTUAL', decisionBudgetMs: 60_000, proposedAction: 'HOLD', proposalId, proposerRunIds: [runIds[0]!], adversaryRunIds: [runIds[1]!], verdict: 'CONFIRM', reasonCodes: [], revisionRound: 0, state: 'CLEARED', unresolvedReason: null, cutoffs: [{ version: 1, at: NOW, consumedByRunIds: runIds }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: NOW, terminalAt: addMs(NOW, 5_000) };
    const proposal: Proposal = { id: proposalId, actionCycleId: cycleId, candidateId: null, positionId, strategyVersionId, source: 'AI', createdAt: NOW, expiresAt: addMs(NOW, 600_000), proposal: { actionType: 'HOLD', direction: 'LONG', candidateId: null, positionId, strategyVersionId, skillVersionId, triggerId: positionId, thesis: 'thesis intact', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 120, confidence: 0.7, invalidation: 'loss of VWAP', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 600_000), reasoningSummary: 'hold', evidenceCutoffVersion: 1 } };
    const review: AdversarialReview = { id: randomUUID() as Uuid, actionCycleId: cycleId, agentRunId: runIds[1]!, deterministicGate: false, verdict: 'CONFIRM', objections: [], confidence: 0.8, cutoffVersion: 1, latencyMs: 90, blocking: true, createdAt: NOW };
    const invocation: ToolInvocation = { id: randomUUID() as Uuid, agentRunId: runIds[0]!, actionCycleId: cycleId, toolName: 'getPositionContext', toolVersion: 'v1' as VersionId, classification: 'READ_ONLY', requestHash: 'ab'.repeat(32) as Sha256Hex, responseRefs: [positionId], cutoffVersion: 1, latencyMs: 3, error: null, createdAt: NOW };
    const refusal: ToolRefusal = { id: randomUUID() as Uuid, agentRunId: runIds[0]!, actionCycleId: cycleId, requestedTool: 'signTransaction', reason: 'UNREGISTERED_TOOL', detail: 'no tool named "signTransaction"', requestHash: 'cd'.repeat(32), cutoffVersion: 1, createdAt: NOW };
    const outbox: QueueMessageEnvelope = { messageId: randomUUID() as Uuid, queue: 'trading-actions', kind: 'action_cycle.cleared', kindVersion: 1, idempotencyKey: `cycle:${cycleId}` as never, correlationId: cycleId, causationId: null, enqueuedAt: NOW, attempt: 1, contractSetDigest: 'ef'.repeat(32) as Sha256Hex, payload: { actionCycleId: cycleId, positionId } };

    await persistDiscretionaryOutcome(sql, { cycle, proposals: [proposal], reviews: [review], runs: [run(0, 'TRADING_PROPOSER'), run(1, 'ACTION_ADVERSARY')], toolInvocations: [invocation], toolRefusals: [refusal] }, { positionReview: { positionId, reviewState: 'REVIEWED', reason: null, since: addMs(NOW, 5_000), lastReviewedCycleId: cycleId }, outbox });
    expect(await loadCycleSummary(sql, cycleId)).toMatchObject({ cycle: { state: 'CLEARED', verdict: 'CONFIRM', proposedAction: 'HOLD', clearedCutoffVersion: 1 }, runs: 2, reviews: 1, toolInvocations: 1, toolRefusals: 1 });
    const [pos] = await sql<{ review_state: string; last_reviewed_cycle_id: string }[]>`select review_state, last_reviewed_cycle_id from trading.positions where id = ${positionId}`;
    expect(pos).toEqual({ review_state: 'REVIEWED', last_reviewed_cycle_id: cycleId });
    // the refusal row is append-only
    await expect(sql`update agents.tool_refusals set reason = 'INVALID_ARGUMENTS' where id = ${refusal.id}`).rejects.toThrow();
    // the outbox message is on the queue
    const q = new PgmqClient(sql);
    const leased = await q.read('trading-actions', 1, 50);
    const mine = leased.find((m) => m.envelope.correlationId === cycleId);
    expect(mine?.envelope.kind).toBe('action_cycle.cleared');
    if (mine) await q.delete('trading-actions', mine.messageId);

    // a second, UNRESOLVED cycle flips the position to PROTECTION_ONLY in the same write; a non-terminal cycle is refused
    const unresolvedId = randomUUID() as Uuid;
    const unresolved: ActionCycle = { ...cycle, id: unresolvedId, proposedAction: null, proposalId: null, proposerRunIds: [], adversaryRunIds: [], verdict: null, state: 'UNRESOLVED', unresolvedReason: 'ADVERSARY_UNAVAILABLE', clearedCutoffVersion: null, cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }] };
    await persistDiscretionaryOutcome(sql, { cycle: unresolved, proposals: [], reviews: [], runs: [] }, { positionReview: { positionId, reviewState: 'PROTECTION_ONLY', reason: 'ADVERSARY_UNAVAILABLE', since: addMs(NOW, 60_000), lastReviewedCycleId: null } });
    const [pos2] = await sql<{ review_state: string; review_state_reason: string; last_reviewed_cycle_id: string }[]>`select review_state, review_state_reason, last_reviewed_cycle_id from trading.positions where id = ${positionId}`;
    expect(pos2).toEqual({ review_state: 'PROTECTION_ONLY', review_state_reason: 'ADVERSARY_UNAVAILABLE', last_reviewed_cycle_id: cycleId });
    await expect(persistDiscretionaryOutcome(sql, { cycle: { ...unresolved, id: randomUUID() as Uuid, state: 'PROPOSED', unresolvedReason: null }, proposals: [], reviews: [], runs: [] })).rejects.toThrow(/not terminal/);
    // a failed write leaves nothing behind: reusing the cycle id violates the primary key and the position stays as it was
    await expect(persistDiscretionaryOutcome(sql, { cycle: unresolved, proposals: [], reviews: [], runs: [] }, { positionReview: { positionId, reviewState: 'REVIEWED', reason: null, since: NOW, lastReviewedCycleId: unresolvedId } })).rejects.toThrow();
    const [pos3] = await sql<{ review_state: string }[]>`select review_state from trading.positions where id = ${positionId}`;
    expect(pos3?.review_state).toBe('PROTECTION_ONLY');
  });

  it('charges spend-usage windows atomically, lists the windows containing now, and keeps a paused window paused', async () => {
    const budgetId = randomUUID() as Uuid;
    const scopeId = `S-${randomUUID().slice(0, 8)}`;
    expect(await ensureSpendBudget(sql, { id: budgetId, versionId: 'budget-v1' as VersionId, scope: 'STRATEGY', scopeId, limits: { cyclesPerHour: 3, modelUsdPerDay: 2, providerRequestsPerMinute: null }, active: true, createdAt: NOW })).toBe('INSERTED');
    expect((await listActiveSpendBudgets(sql)).some((b) => b.id === budgetId && b.limits.cyclesPerHour === 3)).toBe(true);
    const hour = spendWindow(addMs(NOW, 1_234), 'HOUR');
    expect(hour).toEqual({ start: NOW, end: addMs(NOW, 3_600_000) });
    const a = await chargeSpendUsage(sql, budgetId, hour, { cycles: 1, modelUsd: 0.5 });
    const b = await chargeSpendUsage(sql, budgetId, hour, { cycles: 2, modelUsd: 0.25, providerRequests: 4 });
    expect(a.id).toBe(b.id);
    expect(b).toMatchObject({ cycles: 3, modelUsd: 0.75, providerRequests: 4, state: 'OK' });
    expect((await listSpendUsageAt(sql, [budgetId], addMs(NOW, 1_800_000))).map((u) => u.id)).toEqual([a.id]);
    expect(await listSpendUsageAt(sql, [budgetId], addMs(NOW, 3_600_000))).toEqual([]);
    await pauseSpendWindow(sql, a.id);
    expect((await listSpendUsageAt(sql, [budgetId], NOW))[0]?.state).toBe('BUDGET_PAUSED');
    await expect(sql`update ops.spend_usage set state = 'OK' where id = ${a.id}`).rejects.toThrow(/paused/);
    await expect(chargeSpendUsage(sql, budgetId, hour, { cycles: -1 })).rejects.toThrow();
  });
});
