import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Amount, type Bps, type DiscoveredToken, type Fill, type MintAddress, type Order, type OrderAttempt, type Position, type PositionLot, type RiskEvaluation, type Slot, type SolanaAddress, type TradeIntent, type TxSignature, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { createIntent, ensurePaperAccount, ensureSleeve, entryHealth, finishAttempt, journalAttempt, listCyclesAwaitingEntry, openPosition, paperBook, recordRiskEvaluation, setIntentState } from './paper-repo.js';
import { ensureStrategyVersion } from './strategies-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('paper book repository (§17, §6.11–6.20)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'paper-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('a paper account with sleeves, a cleared cycle listed once, an evaluation, an intent, a journaled then finalized attempt, a fill, an open lot and the book that reflects it', async () => {
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-test-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    expect(await ensurePaperAccount(sql, { ...account })).toMatchObject({ id: account.id });
    // reconciliation never sees a paper account
    const [live] = await sql<{ n: number }[]>`select count(*)::int as n from trading.accounts where id = ${account.id} and mode = 'PAPER'`;
    expect(live?.n).toBe(1);

    const versionId = `S0_SAFE@paper-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const sleeve = await ensureSleeve(sql, { id: randomUUID() as Uuid, accountId: account.id, strategyVersionId: versionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: true, createdAt: NOW });
    expect((await ensureSleeve(sql, { ...sleeve, id: randomUUID() as Uuid })).id).toBe(sleeve.id);

    // asset, eligibility, snapshot, candidate, cleared cycle + proposal
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'PAP', name: 'Paper', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 750000, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { atr_14_pct: 0.02 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const candidateId = randomUUID() as Uuid;
    await insertCandidate(sql, { id: candidateId, assetId, discoveredAt: addMs(NOW, -30_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'QUALIFIED', featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:paper:1`, strategyVersionIds: [versionId] });
    const cycleId = randomUUID() as Uuid;
    const proposalId = randomUUID() as Uuid;
    await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, reason_codes, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${cycleId}, ${candidateId}, ${candidateId}, ${versionId}, 'T0_FAST', 30000, 'ENTER', ${proposalId}, 'CONFIRM', '{}', 'CLEARED', '[{"version":1,"at":"2026-09-08T14:00:00.000Z","consumedByRunIds":[]}]'::jsonb, 1, ${NOW}, ${NOW})`;
    await sql`insert into trading.proposals (id, action_cycle_id, candidate_id, strategy_version_id, source, proposal, created_at, expires_at)
      values (${proposalId}, ${cycleId}, ${candidateId}, ${versionId}, 'DETERMINISTIC', '{"actionType":"ENTER"}'::jsonb, ${NOW}, ${addMs(NOW, 300_000)})`;

    const awaiting = await listCyclesAwaitingEntry(sql, [versionId], 100);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ cycle: { id: cycleId, strategyVersionId: versionId, clearedCutoffVersion: 1 }, asset: { id: assetId, decimals: 9, symbol: 'PAP', tokenProgram: 'UNKNOWN' }, eligibility: { id: eligibilityId, settlementRouteConfirmed: true, liquidityUsd: 750000 }, snapshot: { id: snapshotId, features: { atr_14_pct: 0.02 } } });

    const book0 = await paperBook(sql, account.id, USDC, '10000000000' as Amount, NOW);
    expect(book0).toMatchObject({ settlementBalance: '10000000000', exposureAtCost: '0', openPositions: [], pendingExposure: '0', inFlightIncreasing: 0, consecutiveLosses: 0 });
    expect(book0.sleeves.map((s) => s.id)).toEqual([sleeve.id]);
    expect(await entryHealth(sql)).toMatchObject({ entriesPaused: expect.any(Boolean), feedsBlockEntries: expect.any(Boolean) });

    const evaluation: RiskEvaluation = { id: randomUUID() as Uuid, proposalId, actionCycleId: cycleId, policyVersion: 'risk-v1' as VersionId, allowed: true, reasonCodes: [], settlementMint: USDC, equityBaseUnits: '10000000000' as Amount, equityUsd: null, exposureBaseUnits: '0' as Amount, cohortExposure: {}, clusterExposure: {}, sleeveExposure: 0, assetEligibilityEvaluationId: eligibilityId, computedMaxLossBaseUnits: '8000000' as Amount, computedPositionAmount: '200000000' as Amount, maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, stopPolicy: { model: 'ATR', level: 96, distanceFraction: 0.04 }, targetPolicy: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: {} }, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: NOW };
    await recordRiskEvaluation(sql, evaluation);
    await expect(recordRiskEvaluation(sql, { ...evaluation, id: randomUUID() as Uuid })).rejects.toThrow(/already evaluated/);
    expect(await listCyclesAwaitingEntry(sql, [versionId], 100)).toEqual([]);

    const intent: TradeIntent = { id: randomUUID() as Uuid, idempotencyKey: `entry:${cycleId}` as TradeIntent['idempotencyKey'], accountId: account.id, strategyVersionId: versionId, sleeveId: sleeve.id, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: asset!.mintAddress as MintAddress, maxInputAmount: '200000000' as Amount, riskEvaluationId: evaluation.id, actionCycleId: cycleId, clearedCutoffVersion: 1, constraints: { maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, chaseToleranceBps: 75 as Bps, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: NOW, expiresAt: addMs(NOW, 60_000) };
    await createIntent(sql, intent, 'AUTHORIZED');
    await setIntentState(sql, intent.id, 'EXECUTING');
    const book1 = await paperBook(sql, account.id, USDC, '10000000000' as Amount, NOW);
    expect(book1).toMatchObject({ pendingExposure: '200000000', inFlightIncreasing: 1 });
    const [linked] = await sql<{ intent_id: string | null; risk_evaluation_id: string | null }[]>`select intent_id, risk_evaluation_id from agents.action_cycles where id = ${cycleId}`;
    expect(linked).toEqual({ intent_id: intent.id, risk_evaluation_id: evaluation.id });

    const order: Order = { id: randomUUID() as Uuid, intentId: intent.id, authorizationHash: null, executionPath: 'JUPITER_ORDER', transactionClass: 'SWAP_V2', createdAt: NOW };
    const signature = b58(88) as TxSignature;
    const attempt: OrderAttempt = { id: randomUUID() as Uuid, orderId: order.id, intentId: intent.id, authorizationHash: null, attemptNumber: 1, state: 'SIGNED_NOT_SUBMITTED', jupiterRequestId: null, router: 'paper', signedTxHash: 'a'.repeat(64) as never, walletSignature: null, expectedTxSignature: signature, blockhash: null, lastValidBlockHeight: 500, quoteExpiresAt: null, signedAt: NOW, submittedAt: null, submissions: [], confirmedAt: null, confirmedSlot: null, finalizedAt: null, finalizedSlot: null, reorgDetectedAt: null, notLandedReason: null, reconciliationOutcome: null, createdAt: NOW };
    await journalAttempt(sql, order, attempt);
    const fill: Fill = { id: randomUUID() as Uuid, orderAttemptId: attempt.id, txSignature: signature, commitment: 'finalized', slot: 1032 as Slot, inputMint: USDC, outputMint: intent.outputMint, inputAmount: '200000000' as Amount, outputAmount: '1987000000' as Amount, fees: { networkBaseUnits: '5000' as Amount, priorityBaseUnits: '20000' as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount }, executionShortfallBps: 64, executionPath: 'JUPITER_ORDER', lotAllocations: [], filledAt: addMs(NOW, 15_300) };
    await finishAttempt(sql, order, { ...attempt, state: 'FINALIZED', submittedAt: addMs(NOW, 1_500), submissions: [{ at: addMs(NOW, 1_500), path: 'JUPITER_ORDER', ok: true, providerResponseSignature: signature, error: null }], confirmedAt: addMs(NOW, 2_300), confirmedSlot: 1000 as Slot, finalizedAt: addMs(NOW, 15_300), finalizedSlot: 1032 as Slot, reconciliationOutcome: 'PAPER_MODELLED' }, fill);
    const [att] = await sql<{ state: string; finalized_slot: number }[]>`select state, finalized_slot from trading.order_attempts where id = ${attempt.id}`;
    expect(att).toEqual({ state: 'FINALIZED', finalized_slot: '1032' }); // bigint columns come back as text

    const positionId = randomUUID() as Uuid;
    const position: Position = { id: positionId, accountId: account.id, assetId, mint: intent.outputMint, quantity: fill.outputAmount, averageEntryPrice: 100.65, costBasisBaseUnits: fill.inputAmount, realizedPnlBaseUnits: '0' as never, unrealizedPnlBaseUnits: null, stop: { model: 'ATR', level: 96.6, distanceFraction: 0.04 }, target: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: {} }, unreviewedStop: 96.6, custodySplit: [], status: 'OPEN', reviewState: 'REVIEWED', reviewStateReason: null, reviewStateSince: NOW, lastReviewedCycleId: cycleId, nextReassessmentAt: addMs(NOW, 60_000), safetyState: 'NORMAL', lotIds: [], openedAt: fill.filledAt, closedAt: null };
    const lot: PositionLot = { id: randomUUID() as Uuid, positionId, sleeveId: sleeve.id, strategyVersionId: versionId, assetId, mint: intent.outputMint, quantity: fill.outputAmount, costBasisBaseUnits: fill.inputAmount, entryIntentId: intent.id, entryFillIds: [fill.id], exitFillIds: [], realizedPnlBaseUnits: '0' as never, protectionMode: 'MONITORED_EXIT', providerOrderId: null, reservedForProtection: '0' as Amount, status: 'OPEN', openedAt: fill.filledAt, closedAt: null };
    await openPosition(sql, position, lot);
    await setIntentState(sql, intent.id, 'COMPLETED');

    const book2 = await paperBook(sql, account.id, USDC, '10000000000' as Amount, NOW);
    expect(book2).toMatchObject({ settlementBalance: '9800000000', exposureAtCost: '200000000', markValue: '200000000', pendingExposure: '0', inFlightIncreasing: 0, feesLamports: '25000', realizedBySleeve: { [sleeve.id]: '0' } });
    expect(book2.openPositions).toEqual([{ id: positionId, assetId, mint: intent.outputMint, quantity: '1987000000', costBasis: '200000000' }]);
    expect(book2.sleeves[0]).toMatchObject({ committedBaseUnits: '200000000' });
  });
});
