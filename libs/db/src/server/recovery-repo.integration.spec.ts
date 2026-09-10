import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Amount, type Bps, type DiscoveredToken, type Fill, type MintAddress, type Order, type OrderAttempt, type Sha256Hex, type Slot, type SolanaAddress, type TradeIntent, type TxSignature, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { createIntent, ensurePaperAccount, ensureSleeve, finishAttempt, journalAttempt, openPosition, recordRiskEvaluation } from './paper-repo.js';
import { listOpenPositionsForAccount } from './positions-repo.js';
import { ensureStrategyVersion } from './strategies-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { advanceAttemptFinality } from './executor-repo.js';
import { expireStaleIntents, failOrphanedExecuting, recoveryFacts, settleIntentsFromAttempts, sleeveConflicts } from './recovery-repo.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('restart recovery and finality persistence (§21.3, §14.7, INV-22)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'recovery-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('settles EXECUTING intents from terminal attempts, expires stale authorizations, fails orphaned executions and promotes a confirmed fill on finality', async () => {
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-rec-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const versionId = `S0_SAFE@rec-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER', 'EXIT'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const sleeve = await ensureSleeve(sql, { id: randomUUID() as Uuid, accountId: account.id, strategyVersionId: versionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: true, createdAt: NOW });
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'REC', name: 'Rec', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const mint = asset!.mintAddress as MintAddress;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: NOW, newestInputAt: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: {}, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const candidateId = randomUUID() as Uuid;
    await insertCandidate(sql, { id: candidateId, assetId, discoveredAt: NOW, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'QUALIFIED', featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:rec:1`, strategyVersionIds: [versionId] });

    // one cleared cycle per intent (FK chain: cycle → proposal → evaluation → intent)
    const makeIntent = async (n: number, lifecycle: 'CREATED' | 'AUTHORIZED', expiresAt = addMs(NOW, 60_000)): Promise<TradeIntent> => {
      const cycle = randomUUID() as Uuid;
      const proposal = randomUUID() as Uuid;
      await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
        values (${cycle}, ${candidateId}, ${candidateId}, ${versionId}, 'T0_FAST', 30000, 'ENTER', ${proposal}, 'CONFIRM', 'CLEARED', '[{"version":1,"at":"2026-09-08T14:00:00.000Z","consumedByRunIds":[]}]'::jsonb, 1, ${NOW}, ${NOW})`;
      await sql`insert into trading.proposals (id, action_cycle_id, candidate_id, strategy_version_id, source, proposal, created_at, expires_at) values (${proposal}, ${cycle}, ${candidateId}, ${versionId}, 'DETERMINISTIC', '{}'::jsonb, ${NOW}, ${addMs(NOW, 60_000)})`;
      const evaluationId = randomUUID() as Uuid;
      await recordRiskEvaluation(sql, { id: evaluationId, proposalId: proposal, actionCycleId: cycle, policyVersion: 'risk-v1' as VersionId, allowed: true, reasonCodes: [], settlementMint: USDC, equityBaseUnits: '10000000000' as Amount, equityUsd: null, exposureBaseUnits: '0' as Amount, cohortExposure: {}, clusterExposure: {}, sleeveExposure: 0, assetEligibilityEvaluationId: null, computedMaxLossBaseUnits: null, computedPositionAmount: '200000000' as Amount, maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, stopPolicy: null, targetPolicy: null, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: NOW });
      const intent: TradeIntent = { id: randomUUID() as Uuid, idempotencyKey: `rec:${cycle}:${n}` as never, accountId: account.id, strategyVersionId: versionId, sleeveId: sleeve.id, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE', inputMint: USDC, outputMint: mint, maxInputAmount: '200000000' as Amount, riskEvaluationId: evaluationId, actionCycleId: cycle, clearedCutoffVersion: 1, constraints: { maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, chaseToleranceBps: 75 as Bps, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: NOW, expiresAt };
      await createIntent(sql, intent, lifecycle);
      return intent;
    };
    const attemptFor = (intent: TradeIntent, state: OrderAttempt['state'], signature: string): { order: Order; attempt: OrderAttempt } => {
      const order: Order = { id: randomUUID() as Uuid, intentId: intent.id, authorizationHash: null, executionPath: 'JUPITER_ORDER', transactionClass: 'SWAP_V2', createdAt: NOW };
      const attempt: OrderAttempt = { id: randomUUID() as Uuid, orderId: order.id, intentId: intent.id, authorizationHash: null, attemptNumber: 1, state, jupiterRequestId: null, router: null, signedTxHash: 'ab'.repeat(32) as Sha256Hex, walletSignature: null, expectedTxSignature: signature as TxSignature, blockhash: null, lastValidBlockHeight: 100, quoteExpiresAt: null, signedAt: NOW, submittedAt: NOW, submissions: [], confirmedAt: state === 'CONFIRMED_PROVISIONAL' ? NOW : null, confirmedSlot: state === 'CONFIRMED_PROVISIONAL' ? (10 as Slot) : null, finalizedAt: null, finalizedSlot: state === 'FINALIZED' ? (12 as Slot) : null, reorgDetectedAt: null, notLandedReason: state === 'NOT_LANDED' ? 'BLOCK_HEIGHT_EXPIRED' : null, reconciliationOutcome: null, createdAt: NOW };
      return { order, attempt };
    };
    const fillFor = (attempt: OrderAttempt, commitment: 'confirmed' | 'finalized'): Fill => ({ id: randomUUID() as Uuid, orderAttemptId: attempt.id, txSignature: attempt.expectedTxSignature!, commitment, slot: 10 as Slot, inputMint: USDC, outputMint: mint, inputAmount: '200000000' as Amount, outputAmount: '1000' as Amount, fees: { networkBaseUnits: '5000' as Amount, priorityBaseUnits: '0' as Amount, routerBaseUnits: '0' as Amount, transferFeeBaseUnits: '0' as Amount }, executionShortfallBps: null, executionPath: 'JUPITER_ORDER', lotAllocations: [], filledAt: NOW });

    const finalized = await makeIntent(1, 'AUTHORIZED');
    const notLanded = await makeIntent(2, 'AUTHORIZED');
    const inFlight = await makeIntent(3, 'AUTHORIZED');
    const stale = await makeIntent(4, 'AUTHORIZED', addMs(NOW, -1));
    const fresh = await makeIntent(5, 'CREATED', addMs(NOW, 60_000));
    const orphan = await makeIntent(6, 'AUTHORIZED', addMs(NOW, -1));
    const provisional = await makeIntent(7, 'AUTHORIZED');
    for (const i of [finalized, notLanded, inFlight, orphan, provisional]) await sql`update trading.intents set lifecycle_state = 'EXECUTING' where id = ${i.id}`;
    const a1 = attemptFor(finalized, 'FINALIZED', b58(88));
    await finishAttempt(sql, a1.order, a1.attempt, fillFor(a1.attempt, 'finalized'));
    const a2 = attemptFor(notLanded, 'NOT_LANDED', b58(88));
    await finishAttempt(sql, a2.order, a2.attempt, null);
    const a3 = attemptFor(inFlight, 'SUBMITTED', b58(88));
    await journalAttempt(sql, a3.order, a3.attempt);
    const a4 = attemptFor(provisional, 'CONFIRMED_PROVISIONAL', b58(88));
    await finishAttempt(sql, a4.order, a4.attempt, fillFor(a4.attempt, 'confirmed'));

    const before = await recoveryFacts(sql, account.id);
    expect(before).toMatchObject({ openPositions: 0, openLots: 0, intents: { EXECUTING: 5, AUTHORIZED: 1, CREATED: 1 }, inFlightAttempts: 2 });

    const settled = await settleIntentsFromAttempts(sql, account.id);
    expect(settled.sort((a, b) => a.state.localeCompare(b.state))).toEqual([{ intentId: finalized.id, state: 'COMPLETED' }, { intentId: notLanded.id, state: 'FAILED' }].sort((a, b) => a.state.localeCompare(b.state)));
    expect(await expireStaleIntents(sql, account.id, NOW)).toEqual([stale.id]);
    expect(await failOrphanedExecuting(sql, account.id, NOW)).toEqual([orphan.id]);
    const state = async (id: Uuid) => (await sql<{ s: string }[]>`select lifecycle_state as s from trading.intents where id = ${id}`)[0]?.s;
    expect(await state(inFlight.id)).toBe('EXECUTING'); // the executor journal owns it
    expect(await state(provisional.id)).toBe('EXECUTING'); // confirmed is not final accounting (INV-22)
    expect(await state(fresh.id)).toBe('CREATED');
    expect(await recoveryFacts(sql, account.id)).toMatchObject({ intents: { EXECUTING: 2, CREATED: 1 }, inFlightAttempts: 2 });

    // finality tracker persistence: CONFIRMED_PROVISIONAL → FINALIZED copies the confirmed fill into a finalized row and completes the intent
    const promoted = await advanceAttemptFinality(sql, { intentId: provisional.id, signature: a4.attempt.expectedTxSignature!, state: 'FINALIZED', slot: 14, at: addMs(NOW, 5_000), reason: null });
    expect(promoted).toEqual({ attemptId: a4.attempt.id, fillPromoted: true });
    const fills = await sql<{ commitment: string; slot: string | number }[]>`select commitment, slot from trading.fills where order_attempt_id = ${a4.attempt.id} order by commitment`;
    expect(fills.map((f) => [f.commitment, Number(f.slot)])).toEqual([['confirmed', 10], ['finalized', 14]]);
    const row = await sql<{ state: string; finalized_slot: string | number; reconciliation_outcome: string }[]>`select state, finalized_slot, reconciliation_outcome from trading.order_attempts where id = ${a4.attempt.id}`;
    expect(row[0]).toMatchObject({ state: 'FINALIZED', reconciliation_outcome: 'FINALITY_TRACKER:FINALIZED' });
    expect(Number(row[0]?.finalized_slot)).toBe(14);
    expect(await state(provisional.id)).toBe('COMPLETED');
    // idempotent: a second promotion finds no landable row and adds no fill
    expect(await advanceAttemptFinality(sql, { intentId: provisional.id, signature: a4.attempt.expectedTxSignature!, state: 'FINALIZED', slot: 14, at: addMs(NOW, 6_000), reason: null })).toEqual({ attemptId: null, fillPromoted: false });
    // REORG_PENDING on the in-flight one is recorded without touching the intent
    const reorg = await advanceAttemptFinality(sql, { intentId: inFlight.id, signature: a3.attempt.expectedTxSignature!, state: 'REORG_PENDING', slot: null, at: addMs(NOW, 7_000), reason: 'MISSING' });
    expect(reorg).toEqual({ attemptId: a3.attempt.id, fillPromoted: false });
    expect((await sql<{ state: string; reorg_detected_at: string | null }[]>`select state, reorg_detected_at from trading.order_attempts where id = ${a3.attempt.id}`)[0]).toMatchObject({ state: 'REORG_PENDING' });
    expect(await state(inFlight.id)).toBe('EXECUTING');
    // §21.3 "restart recovers open positions": an open position and its lot are untouched by recovery while stale intents settle
    const positionId = randomUUID() as Uuid;
    const lotId = randomUUID() as Uuid;
    await openPosition(sql,
      { id: positionId, accountId: account.id, assetId, mint, quantity: '1000' as Amount, averageEntryPrice: 1, costBasisBaseUnits: '1000' as Amount, realizedPnlBaseUnits: '0' as never, unrealizedPnlBaseUnits: null, stop: null, target: null, unreviewedStop: null, custodySplit: [], status: 'OPEN', reviewState: 'REVIEWED', reviewStateReason: null, reviewStateSince: NOW, lastReviewedCycleId: null, nextReassessmentAt: null, safetyState: 'NORMAL', lotIds: [], openedAt: NOW, closedAt: null },
      { id: lotId, positionId, sleeveId: sleeve.id, strategyVersionId: versionId, assetId, mint, quantity: '1000' as Amount, costBasisBaseUnits: '1000' as Amount, entryIntentId: finalized.id, entryFillIds: [], exitFillIds: [], realizedPnlBaseUnits: '0' as never, protectionMode: 'MONITORED_EXIT', providerOrderId: null, reservedForProtection: '0' as Amount, status: 'OPEN', openedAt: NOW, closedAt: null });
    expect(await recoveryFacts(sql, account.id)).toMatchObject({ openPositions: 1, openLots: 1 });
    await settleIntentsFromAttempts(sql, account.id);
    await expireStaleIntents(sql, account.id, NOW);
    await failOrphanedExecuting(sql, account.id, NOW);
    expect((await listOpenPositionsForAccount(sql, account.id, 10)).map((x) => [x.id, x.lots.length, x.quantity])).toEqual([[positionId, 1, '1000']]);
    expect(await recoveryFacts(sql, account.id)).toMatchObject({ openPositions: 1, openLots: 1 });
    expect(await sleeveConflicts(sql, account.id)).toEqual([]);
  });
});
