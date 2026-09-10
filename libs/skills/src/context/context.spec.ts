import fc from 'fast-check';
import { addMs, fixedClock, fixtures, type AssetEligibility, type Candidate, type EvidenceCutoff, type FeatureSnapshot, type HeldAssetSafety, type Instant, type IntelligenceEvent, type MarketSnapshot, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { createToolRegistry, memoryAuditSink } from '../tool-manifest/registry.js';
import { DEFAULT_CONTEXT_BUILD_POLICY, buildTradingSkillContext, type ContextBuildInput } from './builder.js';
import { createToolHandlers } from './handlers.js';
import type { ContextSources, PositionFacts } from './sources.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const CUTOFF: EvidenceCutoff = { version: 1, at: T0, consumedByRunIds: [] };
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;

const candidate: Candidate = { id: IDS.candidate as Uuid, assetId: IDS.asset as Uuid, discoveredAt: addMs(T0, -120_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: { ret_15m: 0.04 }, scannerScore: 72, status: 'QUALIFIED', featureSnapshotId: uuid(1), eligibilityEvaluationId: uuid(2), expiresAt: addMs(T0, 600_000), deterministicRejectionReason: null, dedupeKey: 'k', strategyVersionIds: [] };
const features = (asOf: Instant): FeatureSnapshot => ({ id: uuid(1), assetId: IDS.asset as Uuid, asOf, newestInputAt: null, featureEngineVersion: 'features-v2' as VersionId, provenance: 'LIVE', marketSnapshotId: null, features: { ret_15m: 0.04, rel_volume_60: 2.1, atr_14_pct: null }, regime: 'RISK_ON', marketSessions: ['US'], selfInfluenceSuppressed: false } as unknown as FeatureSnapshot);
const market = (observedAt: Instant): MarketSnapshot => ({ id: uuid(3), assetId: IDS.asset as Uuid, asOf: observedAt, observedAt, provenance: 'LIVE', priceUsd: 1.25, liquidityUsd: 800_000, volumeUsd: { '1h': 50_000, '24h': null }, buyVolumeUsd: {}, sellVolumeUsd: {}, buyCount: {}, sellCount: {}, relativeVolume: null, atr: 0.03 } as unknown as MarketSnapshot);
const eligibility: AssetEligibility = { id: uuid(2), assetId: IDS.asset as Uuid, evaluatedAt: addMs(T0, -60_000), policyVersion: 'eligibility-v1' as VersionId, eligible: true, hardReject: false, rejectionReasons: [], grade: 88, liquidityUsd: 800_000, volume24hUsd: null, holderCount: 4_200, concentration: null, mintAuthority: 'NONE' } as unknown as AssetEligibility;
const event = (n: number, firstSeenAt: Instant, title: string): IntelligenceEvent => ({ id: uuid(10 + n), kind: 'NEWS', sourceProvider: 'CRYPTOPANIC', sourceId: `s${n}`, sourceUrlHash: null, sourcePublishedAt: addMs(firstSeenAt, -600_000), sourceTimeConfidence: 'HIGH', firstSeenAt, lastSeenAt: firstSeenAt, assetIds: [IDS.asset as Uuid], title, summary: null, sourceQuality: 'REPUTABLE_PUBLICATION', noveltyScore: 1, sentiment: { score: 0.3, confidence: 0.6 }, classification: null, clusterId: null, corroboratesEventId: null, payloadHash: 'ab'.repeat(32) as IntelligenceEvent['payloadHash'], rawPayloadRef: null });
const position: PositionFacts = { id: IDS.position as Uuid, accountId: IDS.account as Uuid, assetId: IDS.asset as Uuid, symbol: 'AGT', quantity: '1000', averageEntryPrice: 1, costBasisBaseUnits: '1000', markPrice: 1.1, markAt: addMs(T0, -30_000), unrealizedPnlBaseUnits: '100', stop: { model: 'ATR', level: 0.9, distanceFraction: 0.1 }, target: null, unreviewedStop: null, protectionMode: 'MONITORED_EXIT', safetyState: 'NORMAL', reviewState: 'REVIEWED', reviewStateSince: T0, openedAt: addMs(T0, -3_600_000), lastReviewedCycleId: null, thesis: 'momentum', invalidation: 'loss of VWAP', expectedHorizonEndsAt: addMs(T0, 3_600_000) };
const safety: HeldAssetSafety = { id: uuid(4), positionId: IDS.position as Uuid, assetId: IDS.asset as Uuid, evaluatedAt: addMs(T0, -20_000), policyVersion: 'safety-v1' as VersionId, state: 'NORMAL', previousState: null, reasons: [], triggers: ['PERIODIC'], exitCompatibility: { primaryRouteAvailable: true, primaryImpactBps: 40 }, positionQuantity: '1000', chainSlot: 1, liquidityUsd: 800_000 } as unknown as HeldAssetSafety;

function fakeSources(events: IntelligenceEvent[], opts: { featuresAt?: Instant; marketAt?: Instant; peers?: Uuid[] } = {}): ContextSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async candidate(id, asOf) { calls.push(`candidate@${asOf}`); return id === candidate.id ? candidate : null; },
    async position(id, asOf) { calls.push(`position@${asOf}`); return id === position.id ? position : null; },
    async featureSnapshotAt(_a, asOf) { calls.push(`features@${asOf}`); return features(opts.featuresAt ?? addMs(T0, -60_000)); },
    async marketSnapshotAt(_a, asOf) { calls.push(`market@${asOf}`); return market(opts.marketAt ?? addMs(T0, -45_000)); },
    async eligibilityAt(_a, asOf) { calls.push(`eligibility@${asOf}`); return eligibility; },
    async safetyAt(_p, asOf) { calls.push(`safety@${asOf}`); return safety; },
    async eventsVisibleAt(_a, asOf, limit) { calls.push(`events@${asOf}:${limit}`); return events.slice(0, limit); },
    async onchainAt(assetId, asOf) { calls.push(`onchain@${asOf}`); return { assetId, asOf, smartMoneyNetFlowUsd: { '1h': 12_000, '24h': null }, trackedWalletsAccumulating: 3, trackedWalletsDistributing: 1, holderCount: 4_200, topHolderConcentration: 0.18, ownWalletActivityExcluded: true }; },
    async portfolioAt(accountId, asOf) { calls.push(`portfolio@${asOf}`); return { accountId, asOf, settlementMint: 'USDC', equityBaseUnits: '5000000000', exposureAtCostBaseUnits: '1000', openPositions: [], cohortUsage: {}, clusterUsage: {}, sleeves: [], dayDrawdownFraction: 0.01, entriesPaused: false, feedsBlockEntries: false }; },
    async executionPreview(assetId, side, asOf) { calls.push(`preview:${side}@${asOf}`); return { assetId, asOf, side, notionalBaseUnits: '200000000', quoteAt: asOf, expectedPriceImpactBps: 35, expectedSlippageBps: 50, routeHops: 2, routeLabels: ['Raydium', 'Orca'], quoteAgeMs: 0, stale: false }; },
    async cohortPeers() { return opts.peers ?? []; },
  };
}

const strategy: ContextBuildInput['strategy'] = { versionId: 'S1@1.0.0' as VersionId, speedTier: 'T2_CONTEXTUAL', chaseToleranceBps: 150 as never, maxCandidateAgeMs: 900_000, maxQuoteAgeMs: 15_000, allowedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT'], thresholds: { minScore: 60 }, guidelineVersionId: 'guide-v1' as VersionId };
const skill: ContextBuildInput['skill'] = { versionId: 'skill@1.0.0' as VersionId, supportedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'] };
const candidateCycle = { id: IDS.cycle as Uuid, candidateId: IDS.candidate as Uuid, positionId: null, strategyVersionId: strategy.versionId, triggerId: IDS.trigger as Uuid, speedTier: 'T2_CONTEXTUAL' as const, startedAt: T0, decisionBudgetMs: 60_000 };
const positionCycle = { ...candidateCycle, candidateId: null, positionId: IDS.position as Uuid };
const input = (cycle: ContextBuildInput['cycle'], machineAllowed: ContextBuildInput['machineAllowed']): ContextBuildInput => ({ cycle, cutoff: CUTOFF, accountId: IDS.account as Uuid, strategy, skill, machineAllowed, revision: { round: 0, objections: [] }, policy: DEFAULT_CONTEXT_BUILD_POLICY });

describe('point-in-time context builder and read tools (§11.3, §11.4, §11.13, §18.3; INV-13)', () => {
  it('builds a candidate packet at the cutoff: every read is as-of, evidence ids are the citable set, actions are the machine ∩ skill ∩ strategy', async () => {
    const visible = [event(1, addMs(T0, -300_000), 'Protocol ships upgrade'), event(2, addMs(T0, -100_000), 'Exchange listing announced')];
    const src = fakeSources(visible, { peers: [uuid(7)] });
    const built = await buildTradingSkillContext(src, input(candidateCycle, ['ENTER', 'IGNORE']));
    expect(src.calls.every((c) => c.includes(`@${T0}`))).toBe(true);
    expect(built.assetId).toBe(IDS.asset);
    expect(built.context.allowedActions).toEqual(['ENTER', 'IGNORE']);
    expect(built.context.evidence.map((e) => e.kind)).toEqual(['FEATURE_SNAPSHOT', 'FEATURE_SNAPSHOT', 'FEATURE_SNAPSHOT', 'SAFETY_STATE', 'ONCHAIN_CONTEXT', 'EVENT', 'EVENT']);
    expect(built.scope.evidenceIds).toEqual(built.context.evidence.map((e) => e.id));
    expect(built.scope.assetIds).toEqual([IDS.asset, uuid(7)]);
    expect(built.context.deadlineAt).toBe(addMs(T0, 60_000));
    const ev = built.context.evidence.find((e) => e.id === uuid(11));
    expect(ev).toMatchObject({ kind: 'EVENT', quality: 'REPUTABLE_PUBLICATION', quoted: 'Protocol ships upgrade', observedAt: addMs(T0, -300_000) });
    expect(ev?.facts).toMatchObject({ sourceAgeMs: 900_000, firstSeenAgeMs: 300_000, sourceTimeConfidence: 'HIGH' });
    // missing values are labelled, never zero
    const f = built.context.evidence.find((e) => e.id === uuid(1));
    expect(f?.facts['atr_14_pct']).toBe('missing');
    expect(f?.facts['stale']).toBe(false);
    const m = built.context.evidence.find((e) => e.id === uuid(3));
    expect(m?.facts['volumeUsd_24h']).toBe('missing');
    expect(m?.facts['relativeVolume']).toBe('missing');
  });

  it('labels stale snapshots instead of dropping or zeroing them, and a position packet carries position state and held-asset safety', async () => {
    const src = fakeSources([], { featuresAt: addMs(T0, -3_600_000), marketAt: addMs(T0, -3_600_000) });
    const built = await buildTradingSkillContext(src, input(positionCycle, ['HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION']));
    expect(built.context.allowedActions).toEqual(['HOLD', 'REDUCE', 'EXIT']);
    expect(built.context.evidence.map((e) => e.kind)).toEqual(['POSITION_STATE', 'SAFETY_STATE', 'FEATURE_SNAPSHOT', 'FEATURE_SNAPSHOT', 'SAFETY_STATE', 'ONCHAIN_CONTEXT']);
    expect(built.context.evidence.find((e) => e.id === uuid(1))?.facts).toMatchObject({ stale: true, ageMs: 3_600_000 });
    expect(built.context.evidence.find((e) => e.id === uuid(3))?.facts).toMatchObject({ stale: true });
    const pos = built.context.evidence.find((e) => e.kind === 'POSITION_STATE');
    expect(pos?.quoted).toBe('thesis: momentum | invalidation: loss of VWAP');
    expect(pos?.facts).toMatchObject({ excursion: 0.10000000000000009, heldMs: 3_600_000, reviewState: 'REVIEWED', stale: false });
  });

  it('INV-13 property: an event first seen after the cutoff never enters the packet or a tool response, whatever the source returns', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: -3_600_000, max: 3_600_000 }), { minLength: 1, maxLength: 12 }), async (offsets) => {
        const events = offsets.map((o, i) => event(i, addMs(T0, o), `story ${i}`));
        const src = fakeSources(events);
        const built = await buildTradingSkillContext(src, input(candidateCycle, ['ENTER', 'IGNORE']));
        const packetEvents = built.context.evidence.filter((e) => e.kind === 'EVENT');
        expect(packetEvents.every((e) => e.observedAt <= T0)).toBe(true);
        expect(packetEvents).toHaveLength(offsets.filter((o) => o <= 0).length);
        const handlers = createToolHandlers(src, { submit: async () => ({ proposalRef: 'p' }) });
        const r = await handlers.getNewsSocialEvidence({ args: { assetId: IDS.asset as Uuid, limit: null }, scope: built.scope, asOf: T0 });
        expect((r.evidenceIds ?? []).every((id) => events.find((e) => e.id === id)!.firstSeenAt <= T0)).toBe(true);
        expect(r.evidenceIds).toHaveLength(offsets.filter((o) => o <= 0).length);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a missing target or a candidate discovered after the cutoff', async () => {
    const src = fakeSources([]);
    await expect(buildTradingSkillContext(src, input({ ...candidateCycle, candidateId: uuid(9) }, ['ENTER']))).rejects.toThrow(/not found/);
    await expect(buildTradingSkillContext(src, { ...input(candidateCycle, ['ENTER']), cutoff: { version: 1, at: addMs(T0, -600_000), consumedByRunIds: [] } })).rejects.toThrow(/after the cutoff/);
    await expect(buildTradingSkillContext(src, input({ ...candidateCycle, candidateId: null }, ['ENTER']))).rejects.toThrow(/neither/);
  });

  it('read tools through the registry: reads at the cutoff, evidence becomes citable only after it was shown, preview side follows the target, proposal goes to the sink', async () => {
    const src = fakeSources([event(1, addMs(T0, -300_000), 'Protocol ships upgrade')]);
    const built = await buildTradingSkillContext(src, { ...input(candidateCycle, ['ENTER', 'IGNORE']), policy: { ...DEFAULT_CONTEXT_BUILD_POLICY, maxEvents: 0 } });
    expect(built.context.evidence.some((e) => e.kind === 'EVENT')).toBe(false);
    const submitted: string[] = [];
    const handlers = createToolHandlers(src, { submit: async (p) => { submitted.push(p.actionType); return { proposalRef: `proposal:${p.actionType}` }; } });
    const audit = memoryAuditSink();
    let n = 100;
    const reg = createToolRegistry({ handlers, audit, clock: fixedClock(T0), newId: () => uuid(n++) });
    const run = { agentRunId: uuid(99), scope: built.scope };
    src.calls.length = 0;
    const base = { ...fixtures.tradingActionProposal(), candidateId: IDS.candidate, strategyVersionId: strategy.versionId, skillVersionId: skill.versionId, triggerId: IDS.trigger, expiresAt: addMs(T0, 600_000), evidenceCutoffVersion: 1 };
    expect(await reg.invoke(run, { name: 'submitActionProposal', arguments: { proposal: { ...base, supportingEvidenceIds: [uuid(11)] } } })).toMatchObject({ ok: false, reason: 'UNKNOWN_EVIDENCE_ID' });
    const news = await reg.invoke(run, { name: 'getNewsSocialEvidence', arguments: { assetId: IDS.asset, limit: 5 } });
    expect(news.ok && news.response.evidenceIds).toEqual([uuid(11)]);
    expect(src.calls).toContain(`events@${T0}:5`);
    const market = await reg.invoke(run, { name: 'getAssetMarketState', arguments: { assetId: IDS.asset } });
    expect(market.ok && market.response.refs).toEqual([uuid(1), uuid(3)]);
    const preview = await reg.invoke(run, { name: 'getExecutionPreview', arguments: { assetId: IDS.asset } });
    expect(preview.ok && preview.response.payload).toMatchObject({ side: 'BUY', notionalBaseUnits: '200000000', note: 'preview only; size is deterministic risk output' });
    const portfolio = await reg.invoke(run, { name: 'getPortfolioContext', arguments: {} });
    expect(portfolio.ok && portfolio.response.payload).toMatchObject({ accountId: IDS.account, entriesPaused: false });
    const ok = await reg.invoke(run, { name: 'submitActionProposal', arguments: { proposal: { ...base, supportingEvidenceIds: [uuid(11), uuid(1)] } } });
    expect(ok).toMatchObject({ ok: true, response: { refs: ['proposal:ENTER'] } });
    expect(submitted).toEqual(['ENTER']);
    expect(audit.invocations.map((i) => i.toolName)).toEqual(['getNewsSocialEvidence', 'getAssetMarketState', 'getExecutionPreview', 'getPortfolioContext', 'submitActionProposal']);
    // a position-scoped run previews the SELL side and may not read another position
    const posBuilt = await buildTradingSkillContext(src, input(positionCycle, ['HOLD', 'REDUCE', 'EXIT']));
    const posRun = { agentRunId: uuid(98), scope: posBuilt.scope };
    const sell = await reg.invoke(posRun, { name: 'getExecutionPreview', arguments: { assetId: IDS.asset } });
    expect(sell.ok && sell.response.payload).toMatchObject({ side: 'SELL' });
    expect(await reg.invoke(posRun, { name: 'getPositionContext', arguments: { positionId: uuid(9) } })).toMatchObject({ ok: false, reason: 'OUT_OF_SCOPE_ID' });
    const pc = await reg.invoke(posRun, { name: 'getPositionContext', arguments: { positionId: IDS.position } });
    expect(pc.ok && pc.response.evidenceIds).toEqual([IDS.position]);
  });
});
