import { randomUUID } from 'node:crypto';
import { addMs, quoteProbeOf, toInstant, type Amount, type Bps, type DiscoveredToken, type MintAddress, type Quote, type SolanaAddress, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { createIntent, ensurePaperAccount, ensureSleeve, recordRiskEvaluation } from './paper-repo.js';
import { ensureStrategyVersion } from './strategies-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { insertQuoteProbes } from './quotes-repo.js';
import { decisionQuoteForCycle, executorModeFacts, loadApprovalGrant, loadTradeIntent } from './executor-repo.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('executor repository (§15.3 step 1, §18.1)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'executor-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('loads the immutable intent row verbatim, the decision quote for its cycle, no approval when none exists, and mode facts that fail closed without an open session', async () => {
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `exec-test-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const versionId = `S0_SAFE@exec-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v1' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const sleeve = await ensureSleeve(sql, { id: randomUUID() as Uuid, accountId: account.id, strategyVersionId: versionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: true, createdAt: NOW });
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: b58(44) as DiscoveredToken['mintAddress'], symbol: 'EXE', name: 'Exec', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 90, 750000, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { atr_14_pct: 0.02 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const candidateId = randomUUID() as Uuid;
    await insertCandidate(sql, { id: candidateId, assetId, discoveredAt: addMs(NOW, -30_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'QUALIFIED', featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 30 * 86_400_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:exec:1`, strategyVersionIds: [versionId] });
    const cycleId = randomUUID() as Uuid;
    const proposalId = randomUUID() as Uuid;
    await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, verdict, reason_codes, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${cycleId}, ${candidateId}, ${candidateId}, ${versionId}, 'T0_FAST', 30000, 'ENTER', ${proposalId}, 'CONFIRM', '{}', 'CLEARED', '[{"version":1,"at":"2026-09-08T14:00:00.000Z","consumedByRunIds":[]}]'::jsonb, 1, ${NOW}, ${NOW})`;
    await sql`insert into trading.proposals (id, action_cycle_id, candidate_id, strategy_version_id, source, proposal, created_at, expires_at)
      values (${proposalId}, ${cycleId}, ${candidateId}, ${versionId}, 'DETERMINISTIC', '{"actionType":"ENTER"}'::jsonb, ${NOW}, ${addMs(NOW, 300_000)})`;
    const evaluationId = randomUUID() as Uuid;
    await recordRiskEvaluation(sql, { id: evaluationId, proposalId, actionCycleId: cycleId, policyVersion: 'risk-v1' as VersionId, allowed: true, reasonCodes: [], settlementMint: USDC, equityBaseUnits: '10000000000' as Amount, equityUsd: null, exposureBaseUnits: '0' as Amount, cohortExposure: {}, clusterExposure: {}, sleeveExposure: 0, assetEligibilityEvaluationId: eligibilityId, computedMaxLossBaseUnits: '8000000' as Amount, computedPositionAmount: '100000000' as Amount, maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, stopPolicy: { model: 'ATR', level: 96, distanceFraction: 0.04 }, targetPolicy: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: {} }, dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: NOW });
    const intent: TradeIntent = {
      id: randomUUID() as Uuid, idempotencyKey: `exec:${cycleId}` as TradeIntent['idempotencyKey'], accountId: account.id, strategyVersionId: versionId, sleeveId: sleeve.id, assetId, action: 'ENTER', side: 'BUY', exposureEffect: 'INCREASE',
      inputMint: USDC, outputMint: asset!.mintAddress as MintAddress, maxInputAmount: '100000000' as Amount, riskEvaluationId: evaluationId, actionCycleId: cycleId, clearedCutoffVersion: 1,
      constraints: { maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, chaseToleranceBps: 75 as Bps, maxQuoteAgeMs: 15_000 }, protectionPolicyRef: null, targetLotIds: [], approvalRequired: false, createdAt: NOW, expiresAt: addMs(NOW, 60_000),
    };
    await createIntent(sql, intent, 'AUTHORIZED');
    expect(await loadTradeIntent(sql, intent.id)).toEqual(intent);
    expect(await loadTradeIntent(sql, randomUUID() as Uuid)).toBeNull();
    expect(await loadApprovalGrant(sql, intent.id)).toBeNull();
    const quote: Quote = { provider: 'JUPITER', providerRequestId: null, routerLabel: 'test', inputMint: USDC, outputMint: intent.outputMint, inputAmount: '100000000' as Amount, expectedOutputAmount: '995000' as Amount, minOutputAmount: '985050' as Amount, priceImpactBps: 20 as Bps, slippageBps: 100 as Bps, routeProgramIds: [], usesAddressLookupTables: false, quotedAt: NOW, expiresAt: null, lastValidBlockHeight: null };
    await insertQuoteProbes(sql, [quoteProbeOf(randomUUID() as Uuid, quote, 'DECISION', addMs(NOW, 100), { actionCycleId: cycleId })]);
    expect(await decisionQuoteForCycle(sql, cycleId)).toEqual({ ...quote, routerLabel: 'test' });
    expect(await decisionQuoteForCycle(sql, randomUUID() as Uuid)).toBeNull();
    const facts = await executorModeFacts(sql);
    // whatever session state the shared database holds, the shape is the gate's and never widens on its own
    expect(['OFF', 'STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW', 'WIND_DOWN']).toContain(facts.activity);
    if (facts.sessionId === null) expect(facts).toEqual({ sessionId: null, activity: 'OFF', authority: 'OBSERVE', paused: true });
  });
});
