import { randomUUID } from 'node:crypto';
import { DEFAULT_RISK_POLICY, addMs, generateSigningKeyPair, signPayload, toInstant, type Amount, type Bps, type DiscoveredToken, type Instant, type MintAddress, type Release, type RiskStateProjection, type Sequence, type SolanaAddress, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { loadLatestProjection } from './authorizer-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { ensurePaperAccount } from './paper-repo.js';
import { ensureRelease, heldAssetEligibility, insertProjection, latestReconciliation, listOpenLotSummaries, listProjections, nextProjectionSequence } from './projection-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion } from './strategies-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;

describe.skipIf(!url)('projection repository (§6.14A, D52; M7)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 20, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'projection-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('registers a release once by digest, sequences projections per account, refuses a duplicate sequence, and reads lots, reconciliation and held eligibility', async () => {
    const suffix = randomUUID().slice(0, 8);
    const versionId = `S0_SAFE@proj-${suffix}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S0_SAFE', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v2' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T0_FAST', maxDecisionLatencyMs: 30_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: true }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const digest = randomUUID().replace(/-/g, '').padEnd(64, '0') as Release['digest'];
    const release: Release = { id: randomUUID() as Uuid, digest, binding: { strategyVersionId: versionId, skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, proposerModelPolicyVersion: null, adversaryModelPolicyVersion: 'deterministic-gate-v1' as VersionId, riskPolicyVersion: 'risk-v1' as VersionId, cohortPolicyVersion: 'cohorts-v1' as VersionId, freshnessPolicyVersion: 'freshness-v1' as VersionId, executorPolicyRef: 'executor-policy-v1' as VersionId, contractSetDigest: 'ab'.repeat(32) as never }, status: 'DRAFT', createdAt: NOW, promotedAt: null, retiredAt: null };
    const first = await ensureRelease(sql, release);
    expect(first).toEqual({ id: release.id, outcome: 'INSERTED' });
    expect(await ensureRelease(sql, { ...release, id: randomUUID() as Uuid })).toEqual({ id: release.id, outcome: 'EXISTS' });

    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `proj-test-${suffix}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    expect(await nextProjectionSequence(sql, account.id)).toBe(0);
    expect(await latestReconciliation(sql, account.id)).toBeNull();
    expect(await listOpenLotSummaries(sql, account.id)).toEqual([]);
    expect(await heldAssetEligibility(sql, account.id)).toEqual([]);

    const key = await generateSigningKeyPair();
    const projection = (sequence: number, asOf: Instant): RiskStateProjection => ({ sequence: sequence as Sequence, asOf, chainSlot: 0 as never, releaseId: release.id, releaseDigest: digest, policyVersion: DEFAULT_RISK_POLICY.version, sourceDigests: [], settlementMint: USDC, custody: [], settlementAvailableBaseUnits: '1000' as Amount, gasReserveLamports: '1' as Amount, aggregateNonSettlementExposureBaseUnits: '0' as Amount, exposureUsd: null, signerDependentExposureBaseUnits: '0' as Amount, sleeves: [], openLots: [], drawdown: { dailyFraction: 0, rollingFraction: 0, circuitBreakerTripped: false, consecutiveLosses: 0 }, cohortCapacity: [], clusterCapacity: [], eligibilitySummary: [], freshnessSummary: [], capitalAttestation: { ceilingUsd: 1, recognizedUsd: 1, reattestRequired: false } });
    const p0 = await signPayload(projection(0, NOW), key, NOW);
    await insertProjection(sql, account.id, p0);
    expect(await nextProjectionSequence(sql, account.id)).toBe(1);
    const p1 = await signPayload(projection(1, addMs(NOW, 60_000)), key, addMs(NOW, 60_000));
    await insertProjection(sql, account.id, p1);
    await expect(insertProjection(sql, account.id, p1)).rejects.toThrow(); // unique (account_id, sequence)
    const latest = await loadLatestProjection(sql, account.id);
    expect(latest?.sequence).toBe(1);
    expect(latest?.envelope.payloadHash).toBe(p1.payloadHash);
    expect((await listProjections(sql, account.id, 10)).map((r) => r.sequence)).toEqual([1, 0]);
    // projections are append-only
    await expect(sql`update risk.state_projections set sequence = 5 where account_id = ${account.id} and sequence = 1`).rejects.toThrow();

    // held eligibility and lots appear once a position and its eligibility exist
    const mint = b58(44) as MintAddress;
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint as DiscoveredToken['mintAddress'], symbol: 'PRJ', name: 'Proj', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const positionId = randomUUID() as Uuid;
    await sql`insert into trading.positions (id, account_id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, custody_split, status, review_state, review_state_reason, review_state_since, safety_state, opened_at)
      values (${positionId}, ${account.id}, ${asset!.id}, ${mint}, '1000', 1, '1000', '0', '0', '{"wallet":"1000","providerVault":"0"}'::jsonb, 'OPEN', 'REVIEWED', null, ${NOW}, 'NORMAL', ${NOW})`;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${asset!.id}, ${NOW}, 'eligibility-v1', true, false, '{}', 80, 500000, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T19:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    expect(await heldAssetEligibility(sql, account.id)).toEqual([{ assetId: asset!.id, evaluationId: eligibilityId, eligible: true, evaluatedAt: NOW }]);
  });
});
