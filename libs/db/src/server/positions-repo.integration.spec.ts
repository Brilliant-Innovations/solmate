import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Amount, type Bps, type DiscoveredToken, type Fill, type MintAddress, type Slot, type SolanaAddress, type TradeIntent, type TxSignature, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets, writeCandles } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { createIntent, ensurePaperAccount, ensureSleeve, openPosition, paperBook, recordRiskEvaluation } from './paper-repo.js';
import { applyExit, highSince, listOpenPositionsForAccount, recordExitDecision, tightenStop, updateMark } from './positions-repo.js';
import { ensureStrategyVersion } from './strategies-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('positions repository (§6.19, D24, D39, D44, INV-22)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'positions-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('lists open positions with their lots, marks, tightens only, records an exit cycle and applies a finalized exit to lots, position, sleeve and intent', async () => {
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-pos-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const versionId = `S0_SAFE@pos-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER', 'EXIT'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const sleeve = await ensureSleeve(sql, { id: randomUUID() as Uuid, accountId: account.id, strategyVersionId: versionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: true, createdAt: NOW });
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'POS', name: 'Pos', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const mint = asset!.mintAddress as MintAddress;

    // entry scaffolding: eligibility, snapshot, candidate, a cleared entry cycle, evaluation and intent the position's lot points at
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: {}, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const candidateId = randomUUID() as Uuid;
    await insertCandidate(sql, { id: candidateId, assetId, discoveredAt: NOW, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'QUALIFIED', featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:pos:1`, strategyVersionIds: [versionId] });
    const entryCycle = randomUUID() as Uuid;
    const entryProposal = randomUUID() as Uuid;
    await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${entryCycle}, ${candidateId}, ${candidateId}, ${versionId}, 'T0_FAST', 30000, 'ENTER', ${entryProposal}, 'CONFIRM', 'CLEARED', '[{"version":1,"at":"2026-09-08T14:00:00.000Z","consumedByRunIds":[]}]'::jsonb, 1, ${NOW}, ${NOW})`;
    await sql`insert into trading.proposals (id, action_cycle_id, candidate_id, strategy_version_id, source, proposal, created_at, expires_at) values (${entryProposal}, ${entryCycle}, ${candidateId}, ${versionId}, 'DETERMINISTIC', '{}'::jsonb, ${NOW}, ${addMs(NOW, 60_000)})`;
    const evaluationId = randomUUID() as Uuid;
    await recordRiskEvaluation(sql, { id: evaluationId, proposalId: entryProposal, actionCycleId: entryCycle, policyVersion: 'risk-v1' as VersionId, allowed: true, reasonCodes: [], settlementMint: USDC, equityBaseUnits: '10000000000' as Amount, equityUsd: null, exposureBaseUnits: '0' as Amount, cohortExposure: {}, clusterExposure: {}, sleeveExposure: 0, assetEligibilityEvaluationId: null, computedMaxLossBaseUnits: null, computedPositionAmount: '200000000' as Amount, maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, stopPolicy: null, targetPolicy: null, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: NOW });
    const entryIntent: TradeIntent = { id: randomUUID() as Uuid, idempotencyKey: `entry:${entryCycle}` as never, accountId: account.id, strategyVersionId: versionId, sleeveId: sleeve.id, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: mint, maxInputAmount: '200000000' as Amount, riskEvaluationId: evaluationId, actionCycleId: entryCycle, clearedCutoffVersion: 1, constraints: { maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, chaseToleranceBps: 75 as Bps, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: NOW, expiresAt: addMs(NOW, 60_000) };
    await createIntent(sql, entryIntent, 'AUTHORIZED');
    const positionId = randomUUID() as Uuid;
    const lotId = randomUUID() as Uuid;
    await openPosition(sql,
      { id: positionId, accountId: account.id, assetId, mint, quantity: '2000000000' as Amount, averageEntryPrice: 100, costBasisBaseUnits: '200000000' as Amount, realizedPnlBaseUnits: '0' as never, unrealizedPnlBaseUnits: null, stop: { model: 'ATR', level: 96, distanceFraction: 0.04 }, target: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: {} }, unreviewedStop: 96, custodySplit: [], status: 'OPEN', reviewState: 'REVIEWED', reviewStateReason: null, reviewStateSince: NOW, lastReviewedCycleId: entryCycle, nextReassessmentAt: null, safetyState: 'NORMAL', lotIds: [], openedAt: NOW, closedAt: null },
      { id: lotId, positionId, sleeveId: sleeve.id, strategyVersionId: versionId, assetId, mint, quantity: '2000000000' as Amount, costBasisBaseUnits: '200000000' as Amount, entryIntentId: entryIntent.id, entryFillIds: [], exitFillIds: [], realizedPnlBaseUnits: '0' as never, protectionMode: 'MONITORED_EXIT', providerOrderId: null, reservedForProtection: '0' as Amount, status: 'OPEN', openedAt: NOW, closedAt: null });

    const open = await listOpenPositionsForAccount(sql, account.id, 10);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: positionId, decimals: 9, symbol: 'POS', quantity: '2000000000', averageEntryPrice: 100, costBasisBaseUnits: '200000000', unreviewedStop: 96, safetyState: 'NORMAL' });
    expect(open[0]!.lots).toEqual([{ id: lotId, sleeveId: sleeve.id, strategyVersionId: versionId, quantity: '2000000000', costBasisBaseUnits: '200000000', entryIntentId: entryIntent.id }]);

    // candles give the high since open
    await writeCandles(sql, [
      { assetId, provider: 'test', resolution: '1m', bucketTime: addMs(NOW, 60_000), observedAt: addMs(NOW, 120_000), provenance: 'LIVE', open: 100, high: 107, low: 99, close: 105, volumeUsd: 1, tradeCount: null },
      { assetId, provider: 'test', resolution: '1m', bucketTime: addMs(NOW, -60_000), observedAt: NOW, provenance: 'LIVE', open: 100, high: 150, low: 99, close: 100, volumeUsd: 1, tradeCount: null },
    ]);
    expect(await highSince(sql, assetId, NOW, addMs(NOW, 600_000))).toBe(107);

    await updateMark(sql, positionId, '10000000' as never, addMs(NOW, 30_000));
    const book = await paperBook(sql, account.id, USDC, '10000000000' as Amount, NOW);
    expect(book.markValue).toBe('210000000');
    expect(await tightenStop(sql, positionId, 101.76)).toBe(true);
    expect(await tightenStop(sql, positionId, 100)).toBe(false);
    const [stored] = await sql<{ unreviewed_stop: number; stop: { level: number } }[]>`select unreviewed_stop, stop from trading.positions where id = ${positionId}`;
    expect(stored).toEqual({ unreviewed_stop: 101.76, stop: { level: 101.76, model: 'ATR', distanceFraction: 0.04 } });

    // exit: cycle + proposal + review + evaluation, then a finalized fill applied to the lot
    const exitCycle = randomUUID() as Uuid;
    const exitProposal = randomUUID() as Uuid;
    const exitEvaluation = randomUUID() as Uuid;
    await recordExitDecision(sql,
      { id: exitCycle, automationRunId: null, triggerId: positionId, candidateId: null, positionId, strategyVersionId: versionId, skillVersionId: null, guidelineVersionId: null, speedTier: 'T0_FAST', decisionBudgetMs: 30_000, proposedAction: 'EXIT', proposalId: exitProposal, proposerRunIds: [], adversaryRunIds: [], verdict: 'CONFIRM', reasonCodes: ['HARD_STOP'], revisionRound: 0, state: 'CLEARED', unresolvedReason: null, cutoffs: [{ version: 1, at: NOW, consumedByRunIds: [] }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: NOW, terminalAt: NOW },
      { id: exitProposal, actionCycleId: exitCycle, candidateId: null, positionId, strategyVersionId: versionId, source: 'DETERMINISTIC', createdAt: NOW, expiresAt: addMs(NOW, 60_000), proposal: { actionType: 'EXIT', direction: 'LONG', candidateId: null, positionId, strategyVersionId: versionId, skillVersionId: null, triggerId: positionId, thesis: 't', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 1, confidence: 1, invalidation: 'n/a', requestedFractionToReduce: null, protectionIntent: null, urgency: 'high', expiresAt: addMs(NOW, 60_000), reasoningSummary: 'r', evidenceCutoffVersion: 1 } },
      { id: randomUUID() as Uuid, actionCycleId: exitCycle, agentRunId: null, deterministicGate: true, verdict: 'CONFIRM', objections: [], confidence: 1, cutoffVersion: 1, latencyMs: 0, blocking: false, createdAt: NOW },
      { id: exitEvaluation, proposalId: exitProposal, actionCycleId: exitCycle, policyVersion: 'risk-v1' as VersionId, allowed: true, reasonCodes: ['HARD_STOP'], settlementMint: USDC, equityBaseUnits: '0' as Amount, equityUsd: null, exposureBaseUnits: '200000000' as Amount, cohortExposure: {}, clusterExposure: {}, sleeveExposure: null, assetEligibilityEvaluationId: null, computedMaxLossBaseUnits: null, computedPositionAmount: '2000000000' as Amount, maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, stopPolicy: null, targetPolicy: null, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: NOW },
    );
    const [linked] = await sql<{ risk_evaluation_id: string; last_reviewed_cycle_id: string }[]>`select c.risk_evaluation_id, p.last_reviewed_cycle_id from agents.action_cycles c join trading.positions p on p.id = c.position_id where c.id = ${exitCycle}`;
    expect(linked).toEqual({ risk_evaluation_id: exitEvaluation, last_reviewed_cycle_id: exitCycle });

    const exitIntent: TradeIntent = { ...entryIntent, id: randomUUID() as Uuid, idempotencyKey: `exit:${positionId}:${exitCycle}` as never, action: 'EXIT', side: 'SELL', exposureEffect: 'REDUCE', inputMint: mint, outputMint: USDC, maxInputAmount: '2000000000' as Amount, riskEvaluationId: exitEvaluation, actionCycleId: exitCycle, targetLotIds: [lotId] };
    await createIntent(sql, exitIntent, 'AUTHORIZED');
    const orderId = randomUUID() as Uuid;
    const attemptId = randomUUID() as Uuid;
    await sql`insert into trading.orders (id, intent_id, execution_path, transaction_class, created_at) values (${orderId}, ${exitIntent.id}, 'JUPITER_ORDER', 'SWAP_V2', ${NOW})`;
    await sql`insert into trading.order_attempts (id, order_id, intent_id, attempt_number, state, signed_tx_hash, finalized_slot, created_at) values (${attemptId}, ${orderId}, ${exitIntent.id}, 1, 'FINALIZED', ${'b'.repeat(64)}, 2000, ${NOW})`;
    const fill: Fill = { id: randomUUID() as Uuid, orderAttemptId: attemptId, txSignature: b58(88) as TxSignature, commitment: 'finalized', slot: 2000 as Slot, inputMint: mint, outputMint: USDC, inputAmount: '2000000000' as Amount, outputAmount: '189715000' as Amount, fees: { networkBaseUnits: '5000' as Amount, priorityBaseUnits: '20000' as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount }, executionShortfallBps: 15, executionPath: 'JUPITER_ORDER', lotAllocations: [{ lotId, quantity: '2000000000' as Amount }], filledAt: addMs(NOW, 15_000) };
    await sql`insert into trading.fills (id, order_attempt_id, tx_signature, commitment, slot, input_mint, output_mint, input_amount, output_amount, fees, execution_shortfall_bps, execution_path, lot_allocations, filled_at)
      values (${fill.id}, ${attemptId}, ${fill.txSignature}, 'finalized', 2000, ${mint}, ${USDC}, ${fill.inputAmount}, ${fill.outputAmount}, ${sql.json(fill.fees)}, 15, 'JUPITER_ORDER', ${sql.json(fill.lotAllocations)}, ${fill.filledAt})`;

    await expect(applyExit(sql, { positionId, intentId: exitIntent.id, fill: { ...fill, commitment: 'confirmed' }, lots: [], closesPosition: true, closedAt: fill.filledAt })).rejects.toThrow(/INV-22/);
    await applyExit(sql, { positionId, intentId: exitIntent.id, fill, lots: [{ lotId, sleeveId: sleeve.id, quantity: '2000000000' as Amount, costReleased: '200000000' as Amount, realizedPnl: '-10285000' as never }], closesPosition: true, closedAt: fill.filledAt });
    const [pos] = await sql<{ status: string; quantity: string; cost_basis_base_units: string; realized_pnl_base_units: string; closed_at: string | null }[]>`select status, quantity::text, cost_basis_base_units::text, realized_pnl_base_units::text, closed_at from trading.positions where id = ${positionId}`;
    expect(pos).toMatchObject({ status: 'CLOSED', quantity: '0', cost_basis_base_units: '0', realized_pnl_base_units: '-10285000' });
    expect(pos!.closed_at).not.toBeNull();
    const [lot] = await sql<{ status: string; quantity: string; realized_pnl_base_units: string; exit_fill_ids: string[] }[]>`select status, quantity::text, realized_pnl_base_units::text, exit_fill_ids from trading.position_lots where id = ${lotId}`;
    expect(lot).toEqual({ status: 'CLOSED', quantity: '0', realized_pnl_base_units: '-10285000', exit_fill_ids: [fill.id] });
    const [sl] = await sql<{ committed_base_units: string }[]>`select committed_base_units::text from trading.strategy_sleeves where id = ${sleeve.id}`;
    expect(sl).toEqual({ committed_base_units: '0' });
    const [it] = await sql<{ lifecycle_state: string }[]>`select lifecycle_state from trading.intents where id = ${exitIntent.id}`;
    expect(it).toEqual({ lifecycle_state: 'COMPLETED' });
    expect(await listOpenPositionsForAccount(sql, account.id, 10)).toEqual([]);
    const after = await paperBook(sql, account.id, USDC, '10000000000' as Amount, NOW);
    // the lot's realized loss is visible per sleeve; settlement reflects the exit proceeds
    expect(after.realizedBySleeve[sleeve.id]).toBe('-10285000');
    expect(after.settlementBalance).toBe('10189715000'); // no finalized entry fill was recorded in this test, so only proceeds move the balance
    // the same lot cannot be released twice
    await expect(applyExit(sql, { positionId, intentId: exitIntent.id, fill, lots: [{ lotId, sleeveId: sleeve.id, quantity: '1' as Amount, costReleased: '0' as Amount, realizedPnl: '0' as never }], closesPosition: true, closedAt: fill.filledAt })).rejects.toThrow(/cannot release/);
  });
});
