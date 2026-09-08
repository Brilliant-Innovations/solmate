import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Amount, type Bps, type CohortTaxonomyPolicy, type DiscoveredToken, type MarketSnapshot, type MintAddress, type SolanaAddress, type TxSignature, type Uuid, type VersionId, type WalletEvent } from '@sol-agent-trader/contracts';
import { installTaxonomy } from './cohorts-repo.js';
import { cohortPeersOf, eligibilityAt, featureSnapshotAt, marketSnapshotAt, onchainFlowAt, positionContextAt, safetyAt } from './context-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { insertSnapshot, upsertDiscoveredAssets } from './market-repo.js';
import { ensurePaperAccount } from './paper-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ensureStrategyVersion } from './strategies-repo.js';
import { ingestWalletEvents, registerTrackedWallet } from './wallet-events-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;

describe.skipIf(!url)('point-in-time context reads (§11.3, §18.3; INV-13)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 18, 0, 0));
  const CUTOFF = addMs(NOW, -300_000);
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'context-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('every read is bounded by asOf: later snapshots, evaluations, marks, proposals and wallet events are invisible; own wallets never count', async () => {
    const mint = b58(44) as MintAddress;
    const peerMint = b58(44) as MintAddress;
    const [asset, peer] = await upsertDiscoveredAssets(sql, [
      { mintAddress: mint as DiscoveredToken['mintAddress'], symbol: 'CTX', name: 'Context', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW },
      { mintAddress: peerMint as DiscoveredToken['mintAddress'], symbol: 'PEER', name: 'Peer', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW },
    ], NOW);
    const assetId = asset!.id;
    // features and market snapshots before and after the cutoff
    const fBefore = randomUUID() as Uuid;
    await insertFeatureSnapshot(sql, { id: fBefore, assetId, asOf: addMs(CUTOFF, -60_000), featureEngineVersion: 'features-v2' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_15m: 0.02, atr_14_pct: null }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    await insertFeatureSnapshot(sql, { id: randomUUID() as Uuid, assetId, asOf: addMs(CUTOFF, 60_000), featureEngineVersion: 'features-v2' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_15m: 0.09 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false });
    const snap = (id: Uuid, at: ReturnType<typeof addMs>, price: number): MarketSnapshot => ({ id, assetId, asOf: at, observedAt: at, provenance: 'LIVE', priceUsd: price, liquidityUsd: 500_000, volumeUsd: { h1: 1000 }, buyVolumeUsd: {}, sellVolumeUsd: {}, buyCount: {}, sellCount: {}, relativeVolume: null, atr: null, realizedVolatility: null, returns: { s15: null, m1: null, m3: null, m5: null, m15: null, m30: null, h1: null, h4: null }, marketCapUsd: null, fdvUsd: null, solRelativeReturn: null, universeRelativeStrength: null, routeProbes: [] } as unknown as MarketSnapshot);
    const mBefore = randomUUID() as Uuid;
    await insertSnapshot(sql, snap(mBefore, addMs(CUTOFF, -30_000), 1.5));
    await insertSnapshot(sql, snap(randomUUID() as Uuid, addMs(CUTOFF, 30_000), 9.9));
    expect((await featureSnapshotAt(sql, assetId, CUTOFF))?.id).toBe(fBefore);
    expect((await featureSnapshotAt(sql, assetId, CUTOFF))?.features).toEqual({ ret_15m: 0.02, atr_14_pct: null });
    expect(await featureSnapshotAt(sql, assetId, addMs(CUTOFF, -120_000))).toBeNull();
    const m = await marketSnapshotAt(sql, assetId, CUTOFF);
    expect(m).toMatchObject({ id: mBefore, priceUsd: 1.5, liquidityUsd: 500_000, volumeUsd: { h1: 1000 }, routeProbes: [] });
    // eligibility before and after
    const eBefore = randomUUID() as Uuid;
    for (const [id, at, grade] of [[eBefore, addMs(CUTOFF, -10_000), 80], [randomUUID() as Uuid, addMs(CUTOFF, 10_000), 10]] as const) {
      await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, liquidity_usd, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
        values (${id}, ${assetId}, ${at}, 'eligibility-v1', true, false, '{}', ${grade}, 500000, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T17:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    }
    expect((await eligibilityAt(sql, assetId, CUTOFF))).toMatchObject({ id: eBefore, grade: 80, eligible: true });

    // a position opened before the cutoff, its entry proposal, and safety evaluations around the cutoff
    const versionId = `S1@ctx-${randomUUID().slice(0, 8)}` as VersionId;
    await ensureStrategyVersion(sql, {
      id: randomUUID() as Uuid, strategyId: 'S1', versionId, variant: 'test', gitSha: 'abcdef1' as never, featureVersion: 'features-v2' as never, promptVersions: {}, modelSelections: {}, thresholds: {}, riskPolicyVersion: 'risk-v1' as never,
      skillVersionId: null, guidelineVersionId: null, automationSetVersionId: null, speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 60_000, maxCandidateAgeMs: 600_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 75 as Bps, allowedActionTypes: ['ENTER'], reassessmentPolicy: {},
      adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: false }, sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] }, regimeConditions: {}, outsideWindowBehavior: 'WATCH', warmup: { minBarsByResolution: {}, baselineWindowMs: 0 },
      eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null }, offlineProtection: { permitted: false, maxOfflineMs: null }, attendedPresenceRequiredProfiles: [], humanReactionFloorMs: 30_000, liveIntentExpiryMs: 60_000, eligibleCapitalAuthorities: ['PAPER'], status: 'PAPER', activeFrom: NOW, activeTo: null,
    });
    const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `ctx-test-${randomUUID().slice(0, 8)}`, cluster: 'mainnet-beta', tradingWallet: b58(44) as SolanaAddress, settlementMint: USDC });
    const positionId = randomUUID() as Uuid;
    const openedAt = addMs(CUTOFF, -3_600_000);
    await sql`insert into trading.positions (id, account_id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, custody_split, status, review_state, review_state_reason, review_state_since, safety_state, opened_at)
      values (${positionId}, ${account.id}, ${assetId}, ${mint}, '1000', 1, '1000', '0', '250', '{"wallet":"1000","providerVault":"0"}'::jsonb, 'OPEN', 'REVIEWED', null, ${openedAt}, 'NORMAL', ${openedAt})`;
    const cycleId = randomUUID() as Uuid;
    await sql`insert into agents.action_cycles (id, trigger_id, position_id, strategy_version_id, speed_tier, decision_budget_ms, proposed_action, verdict, reason_codes, state, cutoffs, cleared_cutoff_version, started_at, terminal_at)
      values (${cycleId}, ${positionId}, ${positionId}, ${versionId}, 'T2_CONTEXTUAL', 60000, 'HOLD', 'CONFIRM', '{}', 'CLEARED', '[{"version":1,"at":"2026-09-08T17:00:00.000Z","consumedByRunIds":[]}]'::jsonb, 1, ${openedAt}, ${openedAt})`;
    const proposalAt = addMs(CUTOFF, -1_800_000);
    await sql`insert into trading.proposals (id, action_cycle_id, position_id, strategy_version_id, source, proposal, created_at, expires_at)
      values (${randomUUID()}, ${cycleId}, ${positionId}, ${versionId}, 'AI', ${sql.json({ actionType: 'HOLD', thesis: 'trend intact', invalidation: 'close below 1.2', expectedHorizonMinutes: 120 })}, ${proposalAt}, ${addMs(proposalAt, 600_000)})`;
    await sql`insert into trading.proposals (id, action_cycle_id, position_id, strategy_version_id, source, proposal, created_at, expires_at)
      values (${randomUUID()}, ${cycleId}, ${positionId}, ${versionId}, 'AI', ${sql.json({ actionType: 'EXIT', thesis: 'FUTURE thesis', invalidation: 'x', expectedHorizonMinutes: 5 })}, ${addMs(CUTOFF, 60_000)}, ${addMs(CUTOFF, 660_000)})`;
    const sBefore = randomUUID() as Uuid;
    for (const [id, at, state] of [[sBefore, addMs(CUTOFF, -5_000), 'NORMAL'], [randomUUID() as Uuid, addMs(CUTOFF, 5_000), 'CRITICAL_EXIT']] as const) {
      await sql`insert into trading.position_safety_evaluations (id, position_id, asset_id, evaluated_at, policy_version, state, previous_state, reasons, triggers, exit_compatibility, position_quantity, chain_slot, liquidity_usd, observed, baseline)
        values (${id}, ${positionId}, ${assetId}, ${at}, 'safety-v1', ${state}, null, '{}', '{PERIODIC}', '{"primaryRouteAvailable": true, "primaryImpactBps": 40}'::jsonb, '1000', 1, 500000, '{}'::jsonb, '{}'::jsonb)`;
    }
    expect(await safetyAt(sql, positionId, CUTOFF)).toMatchObject({ id: sBefore, state: 'NORMAL', positionQuantity: '1000', chainSlot: 1, liquidityUsd: 500_000 });
    const pc = await positionContextAt(sql, positionId, CUTOFF);
    expect(pc).toMatchObject({ id: positionId, assetId, symbol: 'CTX', quantity: '1000', averageEntryPrice: 1, unrealizedPnlBaseUnits: '250', reviewState: 'REVIEWED', thesis: 'trend intact', invalidation: 'close below 1.2', expectedHorizonEndsAt: addMs(proposalAt, 120 * 60_000), markPrice: 1.5, markAt: addMs(CUTOFF, -30_000) });
    expect(await positionContextAt(sql, positionId, addMs(openedAt, -1))).toBeNull();

    // tracked-wallet flow: one smart-money buy before, one after, one owned-wallet buy before (excluded), one sell before
    const smart = b58(44) as SolanaAddress;
    const owned = b58(44) as SolanaAddress;
    await registerTrackedWallet(sql, { address: smart, discoverySource: 'MANUAL', labels: [], isOwned: false, firstSeenAt: NOW });
    await registerTrackedWallet(sql, { address: owned, discoverySource: 'CUSTODY', labels: [], isOwned: true, firstSeenAt: NOW });
    const ev = (wallet: SolanaAddress, kind: 'BUY' | 'SELL', at: ReturnType<typeof addMs>, quote: string): WalletEvent => ({ id: randomUUID() as Uuid, wallet, signature: b58(87) as TxSignature, movementIndex: 0, slot: 700 as never, blockTime: at, kind, mint, amount: '1000000' as Amount, decimals: 9, quoteMint: USDC, quoteAmount: quote as Amount, counterparty: null, source: 'HELIUS_POLL', firstSeenAt: at, payloadHash: randomUUID().replace(/-/g, '').padEnd(64, '0') as never });
    await ingestWalletEvents(sql, smart, [ev(smart, 'BUY', addMs(CUTOFF, -600_000), '300000000'), ev(smart, 'SELL', addMs(CUTOFF, -120_000), '100000000'), ev(smart, 'BUY', addMs(CUTOFF, 120_000), '900000000')], null);
    await sql`insert into intelligence.wallet_events (id, wallet, signature, movement_index, slot, block_time, kind, mint, amount, decimals, quote_mint, quote_amount, source, first_seen_at, payload_hash)
      values (${randomUUID()}, ${owned}, ${b58(87)}, 0, 700, ${addMs(CUTOFF, -60_000)}, 'BUY', ${mint}, '1000000', 9, ${USDC}, '5000000000', 'HELIUS_POLL', ${addMs(CUTOFF, -60_000)}, ${'f'.repeat(64)})`;
    const flow = await onchainFlowAt(sql, assetId, mint, CUTOFF);
    expect(flow).toEqual({ assetId, asOf: CUTOFF, netQuoteFlow: { h1: '200000000', h4: '200000000', h24: '200000000' }, buyers: { h1: 1, h4: 1, h24: 1 }, sellers: { h1: 1, h4: 1, h24: 1 }, ownWalletActivityExcluded: true });
    expect((await onchainFlowAt(sql, assetId, mint, addMs(CUTOFF, -300_000))).netQuoteFlow.h1).toBe('300000000');

    // cohort peers under one taxonomy version
    const version = `cohorts-ctx-${randomUUID().slice(0, 8)}` as VersionId;
    const taxonomy: CohortTaxonomyPolicy = { version, cohorts: [{ name: `memes-${version}`, description: 'test' }], memberships: [{ mint, cohort: `memes-${version}`, confidence: 0.9 }, { mint: peerMint, cohort: `memes-${version}`, confidence: 0.9 }] };
    await installTaxonomy(sql, taxonomy);
    expect(await cohortPeersOf(sql, assetId, version)).toEqual([peer!.id]);
    expect(await cohortPeersOf(sql, assetId, 'cohorts-none')).toEqual([]);
  });
});
