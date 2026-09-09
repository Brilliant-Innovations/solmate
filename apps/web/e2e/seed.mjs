import { createClient } from '@supabase/supabase-js';
import { addMs, toInstant } from '@sol-agent-trader/contracts';
import { createIntent, createRuntimeSession, createSql, ensurePaperAccount, ensureRelease, ensureSleeve, ensureStrategyVersion, insertCandidate, insertFeatureSnapshot, insertPortfolioSnapshot, insertReadinessVerdict, openPosition, raiseNotification, recordReconciliation, recordRiskEvaluation, upsertDiscoveredAssets, upsertFeedHealth } from '@sol-agent-trader/db/server';
const OPERATOR = { email: 'e2e-operator@example.test', password: 'e2e-operator-password-1' };
import { seeded as S } from './seed-state.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'E2EWa11et1111111111111111111111111111111111';
const LIVE_WALLET = 'E2ELiveWa11et111111111111111111111111111111';
const SIG = 'E2E' + '1'.repeat(85);

/**
 * §24.7 seed: one operator (password sign-in, aal1) and the ledger rows the assertions need. Runs
 * once per Playwright invocation against the local Supabase named by the config; idempotent by
 * marker (the E2E asset) so a second run on an unreset database does nothing. Every row is
 * written with the same repositories the worker uses, so a schema drift fails here, not in the UI.
 */
export async function seed() {
  const dbUrl = process.env['E2E_DB_URL'];
  const supabaseUrl = process.env['E2E_SUPABASE_URL'];
  const serviceRole = process.env['E2E_SERVICE_ROLE_KEY'];
  if (!dbUrl || !supabaseUrl || !serviceRole) throw new Error('E2E: local Supabase not resolved (run `supabase start` first)');
  const sql = createSql({ url: dbUrl, applicationName: 'web-e2e-seed' });
  const NOW = toInstant(Date.now());
  try {
    // 1. operator user + role
    const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const existing = await sql`select id from auth.users where email = ${OPERATOR.email}`;
    let userId = existing[0]?.id ?? null;
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({ email: OPERATOR.email, password: OPERATOR.password, email_confirm: true });
      if (error || !data.user) throw new Error(`E2E: cannot create operator user: ${error?.message ?? 'no user'}`);
      userId = data.user.id;
    }
    await sql`insert into ops.operators (user_id, role, display_name) values (${userId}, 'operator', 'E2E operator') on conflict (user_id) do nothing`;

    const marker = await sql`select id from core.assets where mint_address = ${S.mint}`;
    if (marker.length > 0) return;

    // 2. accounts, strategy, sleeve, session
    const account = await ensurePaperAccount(sql, { id: S.paperAccountId, name: 'paper-e2e', cluster: 'devnet', tradingWallet: WALLET, settlementMint: USDC });
    await sql`insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint, mode) values (${S.liveAccountId}, 'live-e2e', 'devnet', ${LIVE_WALLET}, ${USDC}, 'LIVE') on conflict (name) do nothing`;
    const versionId = S.strategyVersionId;
    await ensureStrategyVersion(sql, {
      id: 'e2e00000-0000-4000-8000-00000000b000', strategyId: 'S0_SAFE', versionId, variant: 'e2e', gitSha: 'abcdef1', featureVersion: 'features-v1', promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1',
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75, allowedActionTypes: ['ENTER', 'EXIT', 'HOLD'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER', 'LIVE_APPROVAL'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const sleeve = await ensureSleeve(sql, { id: S.sleeveId, accountId: account.id, strategyVersionId: versionId, versionId: 'sleeve-v1', settlementMint: USDC, capitalCapBaseUnits: '4000000000', riskBudgetBaseUnits: '500000000', committedBaseUnits: String(S.lotCostBaseUnits), riskUsedBaseUnits: '0', active: true, createdAt: NOW });
    const sessionId = await createRuntimeSession(sql, { accountId: account.id, profile: 'P1A', attended: true, capitalAuthority: 'PAPER' });
    await sql`update ops.runtime_sessions set activity_state = 'ACTIVE', actual_start_at = ${NOW}, last_presence_heartbeat_at = ${NOW} where id = ${sessionId}`;

    // 3. asset, eligibility, features, candidate
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: S.mint, symbol: S.symbol, name: 'E2E Token', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: 250_000, volume24hUsd: 100_000, priceUsd: 0.1, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset.id;
    await sql`update core.assets set id = id where id = ${assetId}`;
    const mint = asset.mintAddress;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, holder_count, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${S.eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 250000, 1200, 'NONE', 'NONE', true, true, '[]'::jsonb, ${sql.json({ securityProviderAt: null, chainReadAt: NOW, chainSlot: 1000 })})`;
    await sql`update core.assets set status = 'ELIGIBLE' where id = ${assetId}`;
    await insertFeatureSnapshot(sql, { id: S.featureSnapshotId, assetId, asOf: NOW, featureEngineVersion: 'features-v1', provenance: 'LIVE', marketSnapshotId: null, features: { ret_15m: 0.03 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    await insertCandidate(sql, { id: S.candidateId, assetId, discoveredAt: NOW, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 72, status: 'QUALIFIED', featureSnapshotId: S.featureSnapshotId, eligibilityEvaluationId: S.eligibilityId, expiresAt: addMs(NOW, 6 * 3_600_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:e2e:1`, strategyVersionIds: [versionId] });

    // 4. entry cycle → proposal → deterministic review → risk → intent → order → fill
    const cutoffs = [{ version: 1, at: NOW, consumedByRunIds: [] }];
    await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, reason_codes, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${S.entryCycleId}, ${S.candidateId}, ${S.candidateId}, ${versionId}, 'T0_FAST', 30000, 'ENTER', ${S.entryProposalId}, 'CONFIRM', '{}', 'CLEARED', ${sql.json(cutoffs)}, 1, ${NOW}, ${NOW})`;
    const proposal = (actionType, positionId, thesis) => ({ actionType, direction: 'LONG', candidateId: positionId ? null : S.candidateId, positionId, strategyVersionId: versionId, skillVersionId: null, triggerId: positionId ?? S.candidateId, thesis, supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 60, confidence: 1, invalidation: 'deterministic gate rejects', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 60_000), reasoningSummary: thesis, evidenceCutoffVersion: 1 });
    await sql`insert into trading.proposals (id, action_cycle_id, candidate_id, strategy_version_id, source, proposal, created_at, expires_at) values (${S.entryProposalId}, ${S.entryCycleId}, ${S.candidateId}, ${versionId}, 'DETERMINISTIC', ${sql.json(proposal('ENTER', null, 'E2E deterministic entry: 15m breakout with relative volume'))}, ${NOW}, ${addMs(NOW, 60_000)})`;
    await sql`insert into agents.adversarial_reviews (id, action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at) values (${S.entryReviewId}, ${S.entryCycleId}, null, true, 'CONFIRM', '[]'::jsonb, 1, 1, 0, true, ${NOW})`;
    await recordRiskEvaluation(sql, { id: S.entryEvaluationId, proposalId: S.entryProposalId, actionCycleId: S.entryCycleId, policyVersion: 'risk-v1', allowed: true, reasonCodes: [], settlementMint: USDC, equityBaseUnits: '10000000000', equityUsd: 10_000, exposureBaseUnits: '0', cohortExposure: {}, clusterExposure: {}, sleeveExposure: 0, assetEligibilityEvaluationId: S.eligibilityId, computedMaxLossBaseUnits: '8000000', computedPositionAmount: String(S.lotCostBaseUnits), maxSlippageBps: 100, maxPriceImpactBps: 100, stopPolicy: { model: 'ATR', level: 0.096, distanceFraction: 0.04 }, targetPolicy: null, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [{ dataClass: 'CANDLES', fresh: true, ageMs: 1200, limitMs: 60_000 }], createdAt: NOW });
    await createIntent(sql, { id: S.entryIntentId, idempotencyKey: `entry:${S.entryCycleId}`, accountId: account.id, strategyVersionId: versionId, sleeveId: sleeve.id, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: mint, maxInputAmount: String(S.lotCostBaseUnits), riskEvaluationId: S.entryEvaluationId, actionCycleId: S.entryCycleId, clearedCutoffVersion: 1, constraints: { maxSlippageBps: 100, maxPriceImpactBps: 100, chaseToleranceBps: 75, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: NOW, expiresAt: addMs(NOW, 60_000) }, 'AUTHORIZED');
    await sql`update agents.action_cycles set risk_evaluation_id = ${S.entryEvaluationId}, intent_id = ${S.entryIntentId} where id = ${S.entryCycleId}`;
    await sql`insert into trading.orders (id, intent_id, execution_path, transaction_class, created_at) values (${S.orderId}, ${S.entryIntentId}, 'JUPITER_ORDER', 'SWAP_V2', ${NOW})`;
    await sql`insert into trading.order_attempts (id, order_id, intent_id, attempt_number, state, signed_tx_hash, signed_at, submitted_at, confirmed_at, finalized_at, finalized_slot, created_at) values (${S.attemptId}, ${S.orderId}, ${S.entryIntentId}, 1, 'FINALIZED', ${'b'.repeat(64)}, ${NOW}, ${NOW}, ${NOW}, ${NOW}, 2000, ${NOW})`;
    await sql`insert into trading.fills (id, order_attempt_id, tx_signature, commitment, slot, input_mint, output_mint, input_amount, output_amount, fees, execution_shortfall_bps, execution_path, lot_allocations, filled_at)
      values (${S.fillId}, ${S.attemptId}, ${SIG}, 'finalized', 2000, ${USDC}, ${mint}, ${String(S.lotCostBaseUnits)}, '2000000000', ${sql.json({ networkBaseUnits: '5000', priorityBaseUnits: '20000', routerBaseUnits: '0', transferFeeBaseUnits: '0' })}, 12, 'JUPITER_ORDER', ${sql.json([{ lotId: S.lotId, quantity: '2000000000' }])}, ${NOW})`;

    // 5. position in PROTECTION_ONLY with one open lot; a cleared HOLD reassessment cycle
    await openPosition(sql,
      { id: S.positionId, accountId: account.id, assetId, mint, quantity: '2000000000', averageEntryPrice: 0.1, costBasisBaseUnits: String(S.lotCostBaseUnits), realizedPnlBaseUnits: '0', unrealizedPnlBaseUnits: '4000000', stop: { model: 'ATR', level: 0.096, distanceFraction: 0.04 }, target: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: {} }, unreviewedStop: 0.096, custodySplit: [], status: 'OPEN', reviewState: 'PROTECTION_ONLY', reviewStateReason: 'ADVERSARY_UNAVAILABLE', reviewStateSince: NOW, lastReviewedCycleId: S.entryCycleId, nextReassessmentAt: addMs(NOW, 300_000), safetyState: 'NORMAL', lotIds: [], openedAt: NOW, closedAt: null },
      { id: S.lotId, positionId: S.positionId, sleeveId: sleeve.id, strategyVersionId: versionId, assetId, mint, quantity: '2000000000', costBasisBaseUnits: String(S.lotCostBaseUnits), entryIntentId: S.entryIntentId, entryFillIds: [S.fillId], exitFillIds: [], realizedPnlBaseUnits: '0', protectionMode: 'MONITORED_EXIT', providerOrderId: null, reservedForProtection: '0', status: 'OPEN', openedAt: NOW, closedAt: null });
    await sql`insert into agents.action_cycles (id, trigger_id, position_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, reason_codes, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${S.holdCycleId}, ${S.positionId}, ${S.positionId}, ${versionId}, 'T0_FAST', 30000, 'HOLD', ${S.holdProposalId}, 'CONFIRM', '{}', 'CLEARED', ${sql.json(cutoffs)}, 1, ${addMs(NOW, 1000)}, ${addMs(NOW, 1500)})`;
    await sql`insert into trading.proposals (id, action_cycle_id, position_id, strategy_version_id, source, proposal, created_at, expires_at) values (${S.holdProposalId}, ${S.holdCycleId}, ${S.positionId}, ${versionId}, 'DETERMINISTIC', ${sql.json(proposal('HOLD', S.positionId, 'E2E reassessment: thesis intact, stop respected'))}, ${addMs(NOW, 1000)}, ${addMs(NOW, 61_000)})`;
    await sql`insert into agents.adversarial_reviews (id, action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at) values (${S.holdReviewId}, ${S.holdCycleId}, null, true, 'CONFIRM', '[]'::jsonb, 1, 1, 0, true, ${addMs(NOW, 1500)})`;
    await insertPortfolioSnapshot(sql, { id: S.snapshotId, accountId: account.id, asOf: NOW, settlementMint: USDC, equityBaseUnits: '10004000000', equityUsd: 10_004, exposureBaseUnits: String(S.lotCostBaseUnits), exposureFraction: 0.02, perSleeve: [{ sleeveId: sleeve.id, committedBaseUnits: String(S.lotCostBaseUnits), pnlBaseUnits: '0' }], perCohort: [], drawdown: { dailyFraction: 0, rollingFraction: 0 }, createdAt: NOW });

    // 6. stale feed, healthy chain, CRITICAL alert, reconciliation mismatch on the LIVE account
    await upsertFeedHealth(sql, { provider: 'BIRDEYE:CANDLES', state: 'FAILED', lastSuccessAt: addMs(NOW, -600_000), freshnessAgeMs: 600_000, latencyMs: 120, rateLimitState: 'OK', effectOnEntries: 'BLOCK', effectOnExits: 'NONE', lastError: 'e2e: stale for 10 minutes', updatedAt: NOW });
    await upsertFeedHealth(sql, { provider: 'SOLANA_CHAIN', state: 'HEALTHY', lastSuccessAt: NOW, freshnessAgeMs: 900, latencyMs: 80, rateLimitState: 'OK', effectOnEntries: 'NONE', effectOnExits: 'NONE', lastError: null, updatedAt: NOW });
    await raiseNotification(sql, { id: S.notificationId, severity: 'CRITICAL', alertClass: 'UNABLE_TO_EXIT', summary: 'E2E: unable to exit E2E under current liquidity', affected: { assetId, positionId: S.positionId }, automatedResponse: 'PAUSE_NEW_ENTRIES', raisedAt: NOW, deadManDeadline: addMs(NOW, 900_000) });
    await recordReconciliation(sql, { id: S.reconciliationId, accountId: S.liveAccountId, evaluatedAt: NOW, policyVersion: 'reconciliation-v1', chainSlot: 1000, status: 'MISMATCH', reasons: ['UNKNOWN_MOVEMENT'], balances: [{ custodyAccountId: null, address: LIVE_WALLET, mint: null, expected: '50000000', observed: '20000000', delta: '-30000000', ok: false }], unexpectedTokenAccounts: [], movements: [], unparsedSignatures: [], movementSource: 'NONE', cursor: { lastSignature: null, lastSlot: null, solLamports: '20000000' }, pauseTriggered: true });

    // 7. an ELIGIBLE_LIVE Release whose readiness verdict is NOT_READY, and a LIVE_APPROVAL authorization awaiting approval
    await ensureRelease(sql, { id: S.releaseId, digest: S.releaseDigest, binding: { strategyVersionId: versionId, skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, proposerModelPolicyVersion: null, adversaryModelPolicyVersion: 'deterministic-gate', riskPolicyVersion: 'risk-v1', cohortPolicyVersion: 'cohorts-v1', freshnessPolicyVersion: 'freshness-v1', executorPolicyRef: 'executor-v1', contractSetDigest: S.contractSetDigest }, status: 'ELIGIBLE_LIVE', createdAt: NOW, promotedAt: NOW, retiredAt: null });
    await insertReadinessVerdict(sql, { id: S.verdictId, name: 'READY_FOR_ATTENDED_TINY_LIVE', profile: 'P1A', strategyClass: 'DETERMINISTIC', releaseId: S.releaseId, verdict: 'NOT_READY', rows: [{ rowId: 'CHAIN_HEALTH', kind: 'COMPUTED', required: true, verdict: 'FAIL', reason: 'e2e: chain view stalled', evaluatedAt: NOW, rowRef: null }], missing: [], stale: [], failed: ['CHAIN_HEALTH'], notApplicable: [], enabledCapabilities: [], binding: { gitSha: 'abcdef1', imageDigest: null, contractSetDigest: S.contractSetDigest, policyDigests: {}, tradingWallet: null, cluster: 'devnet', profile: 'P1A', releaseId: S.releaseId, releaseDigest: S.releaseDigest }, policyVersion: 'readiness-v1', computedAt: NOW });
    await createIntent(sql, { id: S.approvalIntentId, idempotencyKey: `approve:${S.approvalIntentId}`, accountId: S.liveAccountId, strategyVersionId: versionId, sleeveId: null, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: mint, maxInputAmount: '150000000', riskEvaluationId: S.entryEvaluationId, actionCycleId: S.entryCycleId, clearedCutoffVersion: 1, constraints: { maxSlippageBps: 100, maxPriceImpactBps: 100, chaseToleranceBps: 75, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: true, createdAt: NOW, expiresAt: addMs(NOW, 30 * 60_000) }, 'AUTHORIZED');
    await sql`insert into trading.risk_authorizations (id, intent_id, authorization_hash, envelope, key_id, nonce, expires_at, created_at) values (${S.authorizationId}, ${S.approvalIntentId}, ${S.authorizationHash}, '{}'::jsonb, ${'ed25519:' + '0'.repeat(32)}, ${'1'.repeat(32)}, ${addMs(NOW, 30 * 60_000)}, ${NOW})`;

    // createIntent links a cycle to the newest intent; the entry cycle must keep pointing at its own executed intent
    await sql`update agents.action_cycles set intent_id = ${S.entryIntentId} where id = ${S.entryCycleId}`;

    // 8. watch the asset
    await sql`insert into intelligence.watchlist (asset_id, reason, note, added_by) values (${assetId}, 'e2e watch', 'seeded by the E2E suite', ${userId})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await seed();
console.log("e2e seed complete");
