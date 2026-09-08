import { randomUUID } from 'node:crypto';
import { DEFAULT_AUTOMATION_SET, addMs, toInstant, type Bps, type DiscoveredToken, type MintAddress, type SkillVersion, type SolanaAddress, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { ensureSkillVersion } from './agents-repo.js';
import { automationHistory, installAutomationSet, listCandidateTargets, listPositionTargets, recordAutomationRun } from './automations-repo.js';
import { insertCandidate } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { insertSnapshot, upsertDiscoveredAssets } from './market-repo.js';
import { ensurePaperAccount } from './paper-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion } from './strategies-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;

describe.skipIf(!url)('automations repository (§6.10C, §11.7)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 19, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'automations-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('installs the automation set per binding idempotently, records runs, reads firing history, and lists candidate and position targets', async () => {
    const suffix = randomUUID().slice(0, 8);
    const strategyVersionId = `S1@auto-${suffix}` as VersionId;
    const skillVersionId = `skill@auto-${suffix}` as VersionId;
    const skill: SkillVersion = { id: randomUUID() as Uuid, skillId: 'trading-skill', versionId: skillVersionId, gitSha: 'abcdef1' as SkillVersion['gitSha'], toolManifestVersion: 'tools-v1' as VersionId, guidelineVersion: 'guide-v1' as VersionId, supportedActionTypes: ['ENTER', 'IGNORE'], workflowGraphVersion: 'wf-v1' as VersionId, contextBuilderVersion: 'ctx-v1' as VersionId, proposerModelPolicyVersion: 'model-v1' as VersionId, adversaryPolicyRequired: true, status: 'PAPER', effectiveFrom: NOW, effectiveTo: null };
    await ensureSkillVersion(sql, skill);
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S1', versionId: strategyVersionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v2' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId, guidelineVersionId: 'guide-v1' as VersionId, automationSetVersionId: DEFAULT_AUTOMATION_SET.version, speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 60_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: 'a', adversaryModel: 'b', deterministicGate: false }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const ids = await installAutomationSet(sql, DEFAULT_AUTOMATION_SET, { strategyVersionId, skillVersionId });
    expect(Object.keys(ids)).toHaveLength(DEFAULT_AUTOMATION_SET.rules.length);
    expect(await installAutomationSet(sql, DEFAULT_AUTOMATION_SET, { strategyVersionId, skillVersionId })).toEqual(ids);

    // candidate targets: within age, not expired, not yet cycled by this strategy, any status
    const mint = b58(44) as MintAddress;
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint as DiscoveredToken['mintAddress'], symbol: 'AUT', name: 'Auto', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = asset!.id;
    const snapshotId = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: snapshotId, assetId, asOf: addMs(NOW, -60_000), featureEngineVersion: 'features-v2' as never, provenance: 'LIVE', marketSnapshotId: null, features: {}, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 80, 500000, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T18:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    const mk = (status: 'DETECTED' | 'QUALIFIED' | 'REJECTED' | 'EXPIRED', discoveredAt: ReturnType<typeof addMs>) => insertCandidate(sql, { id: randomUUID() as Uuid, assetId, discoveredAt, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status, featureSnapshotId: snapshotId, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 600_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:${randomUUID()}`, strategyVersionIds: [] });
    await mk('QUALIFIED', addMs(NOW, -120_000));
    await mk('REJECTED', addMs(NOW, -90_000));
    await mk('DETECTED', addMs(NOW, -1_200_000)); // too old
    await mk('EXPIRED', addMs(NOW, -60_000));
    const targets = await listCandidateTargets(sql, strategyVersionId, NOW, 600_000, 10, ['MOMENTUM_CONTINUATION']);
    expect(targets.filter((c) => c.assetId === assetId).map((c) => c.status)).toEqual(['QUALIFIED', 'REJECTED']);
    // once this strategy has a cycle for a candidate it is no longer a target
    const cycled = targets.find((c) => c.assetId === assetId && c.status === 'QUALIFIED')!;
    await sql`insert into agents.action_cycles (id, trigger_id, candidate_id, strategy_version_id, speed_tier, decision_budget_ms, reason_codes, state, cutoffs, started_at, terminal_at)
      values (${randomUUID()}, ${cycled.id}, ${cycled.id}, ${strategyVersionId}, 'T2_CONTEXTUAL', 60000, '{}', 'EXPIRED', '[{"version":1,"at":"2026-09-08T19:00:00.000Z","consumedByRunIds":[]}]'::jsonb, ${NOW}, ${NOW})`;
    expect((await listCandidateTargets(sql, strategyVersionId, NOW, 600_000, 10, ['MOMENTUM_CONTINUATION'])).filter((c) => c.assetId === assetId).map((c) => c.status)).toEqual(['REJECTED']);

    // automation runs and history
    const targetId = cycled.id;
    const runId = randomUUID() as Uuid;
    await recordAutomationRun(sql, { id: runId, automationId: ids['SCANNER_THRESHOLD']!, automationVersionId: DEFAULT_AUTOMATION_SET.version, triggerEvent: { type: 'SCANNER_THRESHOLD', targetId, at: NOW, details: {} }, cutoffVersion: 1, cutoffAt: NOW, skillInvocationRunId: null, actionCycleId: null, disposition: 'INVOKED', createdAt: NOW });
    await recordAutomationRun(sql, { id: randomUUID() as Uuid, automationId: ids['NEW_EVIDENCE_BEFORE_EXPIRY']!, automationVersionId: DEFAULT_AUTOMATION_SET.version, triggerEvent: { type: 'NEW_EVIDENCE_BEFORE_EXPIRY', targetId, at: addMs(NOW, 60_000), details: {} }, cutoffVersion: null, cutoffAt: null, skillInvocationRunId: null, actionCycleId: null, disposition: 'SKIPPED_BUDGET', createdAt: addMs(NOW, 60_000) });
    expect(await automationHistory(sql, targetId)).toEqual({ lastFiredAt: NOW, lastFiredByType: { SCANNER_THRESHOLD: NOW } });
    expect(await automationHistory(sql, randomUUID() as Uuid)).toEqual({ lastFiredAt: null, lastFiredByType: {} });

    // position targets: only positions whose oldest open lot belongs to the strategy; consecutive failures counted
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `auto-test-${suffix}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const positionId = randomUUID() as Uuid;
    await sql`insert into trading.positions (id, account_id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, custody_split, status, review_state, review_state_reason, review_state_since, safety_state, opened_at)
      values (${positionId}, ${account.id}, ${assetId}, ${mint}, '1000', 1, '1000', '0', '0', '{"wallet":"1000","providerVault":"0"}'::jsonb, 'OPEN', 'REVIEWED', null, ${NOW}, 'NORMAL', ${NOW})`;
    expect(await listPositionTargets(sql, strategyVersionId, 10)).toEqual([]); // no lot yet
    const sleeveId = randomUUID() as Uuid;
    await sql`insert into trading.strategy_sleeves (id, account_id, strategy_version_id, version_id, settlement_mint, capital_cap_base_units, risk_budget_base_units, committed_base_units, risk_used_base_units, active, created_at)
      values (${sleeveId}, ${account.id}, ${strategyVersionId}, 'sleeve-v1', ${USDC}, '1000', '100', '0', '0', true, ${NOW})`;
    const intentId = randomUUID() as Uuid;
    await sql`insert into trading.intents (id, action_cycle_id, proposal_id, risk_evaluation_id, account_id, strategy_version_id, sleeve_id, asset_id, side, input_mint, output_mint, input_amount, constraints, exposure_effect, expires_at, lifecycle, capital_authority, created_at)
      values (${intentId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${account.id}, ${strategyVersionId}, ${sleeveId}, ${assetId}, 'BUY', ${USDC}, ${mint}, '1000', '{}'::jsonb, 'INCREASE', ${addMs(NOW, 60_000)}, 'FILLED', 'PAPER', ${NOW})`.catch(() => undefined);
    const [intent] = await sql<{ id: string }[]>`select id from trading.intents where id = ${intentId}`;
    if (intent) {
      await sql`insert into trading.position_lots (id, position_id, sleeve_id, strategy_version_id, asset_id, mint, quantity, cost_basis_base_units, entry_intent_id, entry_fill_ids, exit_fill_ids, realized_pnl_base_units, protection_mode, provider_order_id, reserved_for_protection, status, opened_at)
        values (${randomUUID()}, ${positionId}, ${sleeveId}, ${strategyVersionId}, ${assetId}, ${mint}, '1000', '1000', ${intentId}, '{}', '{}', '0', 'MONITORED_EXIT', null, '0', 'OPEN', ${NOW})`;
      await insertSnapshot(sql, { id: randomUUID() as Uuid, assetId, asOf: NOW, observedAt: NOW, provenance: 'LIVE', priceUsd: 1.3, liquidityUsd: 1, volumeUsd: {}, buyVolumeUsd: {}, sellVolumeUsd: {}, buyCount: {}, sellCount: {}, relativeVolume: null, atr: null, realizedVolatility: null, returns: { s15: null, m1: null, m3: null, m5: null, m15: null, m30: null, h1: null, h4: null }, marketCapUsd: null, fdvUsd: null, solRelativeReturn: null, universeRelativeStrength: null, routeProbes: [] } as never);
      for (const [state, reason, at] of [['UNRESOLVED', 'TIMEOUT', addMs(NOW, 60_000)], ['UNRESOLVED', 'BUDGET', addMs(NOW, 120_000)]] as const) {
        await sql`insert into agents.action_cycles (id, trigger_id, position_id, strategy_version_id, speed_tier, decision_budget_ms, reason_codes, state, unresolved_reason, cutoffs, started_at, terminal_at)
          values (${randomUUID()}, ${positionId}, ${positionId}, ${strategyVersionId}, 'T2_CONTEXTUAL', 60000, '{}', ${state}, ${reason}, '[{"version":1,"at":"2026-09-08T19:00:00.000Z","consumedByRunIds":[]}]'::jsonb, ${at}, ${at})`;
      }
      const [p] = await listPositionTargets(sql, strategyVersionId, 10);
      expect(p).toMatchObject({ id: positionId, assetId, symbol: 'AUT', strategyVersionId, markPrice: 1.3, reviewState: 'REVIEWED', consecutiveUnresolved: 2, lastCycleAt: addMs(NOW, 120_000) });
      expect(await listPositionTargets(sql, `S9@none-${suffix}` as VersionId, 10)).toEqual([]);
    }
  });
});
