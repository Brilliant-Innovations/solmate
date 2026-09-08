import { DEFAULT_FRESHNESS_REQUIREMENTS, DEFAULT_RISK_POLICY, SignedRiskStateProjection, addMs, fixedClock, fixtures, generateSigningKeyPair, verifySignedEnvelope, type Amount, type Instant, type MintAddress, type Release, type Sequence, type SignedRiskStateProjection as Signed, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { PaperBook } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runStateProjectorCycle, type StateProjectorDeps, type StateProjectorRepo } from './state-projector.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const USDC = fixtures.MINTS.USDC as MintAddress;
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;

const book: PaperBook = { settlementBalance: '9000000000' as Amount, exposureAtCost: '1000000000' as Amount, markValue: '1100000000' as Amount, realizedBySleeve: {}, openPositions: [{ id: IDS.position as Uuid, assetId: IDS.asset as Uuid, mint: fixtures.MINTS.RISK as MintAddress, quantity: '1000' as Amount, costBasis: '1000000000' as Amount }], pendingExposure: '200000000' as Amount, inFlightIncreasing: 1, sleeves: [], feesLamports: '0' as Amount, consecutiveLosses: 1, dayStartEquity: '10500000000' as Amount, rollingHighEquity: '11000000000' as Amount };
const release: Release = { id: uuid(7), digest: 'ab'.repeat(32) as Release['digest'], binding: {} as Release['binding'], status: 'DRAFT', createdAt: T0, promotedAt: null, retiredAt: null };

function fakeRepo(over: Partial<StateProjectorRepo> = {}) {
  const inserted: Signed[] = [];
  let seq = 3;
  const repo: StateProjectorRepo = {
    async book() { return book; },
    async sleeves() { return [{ id: uuid(5), accountId: IDS.account as Uuid, strategyVersionId: 'S0_SAFE@1.2.0' as VersionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '1000000000' as Amount, riskUsedBaseUnits: '100000000' as Amount, active: true, createdAt: T0 }]; },
    async openLots() { return [{ lotId: uuid(4), positionId: IDS.position as Uuid, assetId: IDS.asset as Uuid, mint: fixtures.MINTS.RISK as MintAddress, quantity: '1000' as Amount, costBasisBaseUnits: '1000000000' as Amount, protectionMode: 'MONITORED_EXIT' as const, providerProtectionActive: false }]; },
    async latestReconciliation() { return { evaluatedAt: addMs(T0, -30_000), chainSlot: 500 as never, status: 'CLEAN' as const, balances: [{ custodyAccountId: IDS.custody as Uuid, address: fixtures.WALLET as never, mint: USDC, expected: '9000000000' as Amount, observed: '9000000000' as Amount, delta: '0' as never, ok: true }, { custodyAccountId: null, address: fixtures.WALLET as never, mint: null, expected: null, observed: '1000000000' as Amount, delta: null, ok: true }] }; },
    async heldAssetEligibility() { return [{ assetId: IDS.asset as Uuid, evaluationId: uuid(2), eligible: true, evaluatedAt: addMs(T0, -60_000) }]; },
    async feedHealth() { return [{ provider: 'BIRDEYE', lastSuccessAt: addMs(T0, -20_000) }, { provider: 'JUPITER', lastSuccessAt: addMs(T0, -5_000) }]; },
    async cohorts() { return { memberships: [{ assetId: IDS.asset as Uuid, cohortId: uuid(9), cohortName: 'memes' }], clusterSet: { id: uuid(8), versionId: 'clusters-v1' as VersionId, windowStart: T0, windowEnd: T0, calculatedAt: T0, method: 'pearson', clusters: [{ clusterId: 'c1', assetIds: [IDS.asset as Uuid] }] } }; },
    async nextSequence() { return seq++ as Sequence; },
    async insert(envelope) { inserted.push(envelope); },
    async capitalCeilingUsd() { return null; },
    ...over,
  };
  return { repo, inserted };
}

async function deps(repo: StateProjectorRepo): Promise<StateProjectorDeps> {
  const key = await generateSigningKeyPair();
  return { repo, key, clock: fixedClock(T0), logger: createLogger({ service: 'worker', minLevel: 'error' }), account: { id: IDS.account as Uuid, settlementMint: USDC, settlementDecimals: 6, startingCapital: '10000000000' as Amount, virtualSolLamports: '1000000000' as Amount }, release, policy: DEFAULT_RISK_POLICY, freshness: DEFAULT_FRESHNESS_REQUIREMENTS, providerFor: (c) => (c === 'ACTIVE_POSITION_PRICE' || c === 'CANDIDATE_PRICE' ? 'JUPITER' : c === 'DISCOVERY_LIST' || c === 'CANDLES' || c === 'TOKEN_OVERVIEW' ? 'BIRDEYE' : null), config: { reconciliationMaxAgeMs: 300_000 } };
}

describe('worker role state-projector (§6.14A, D21, D52; ADR-0009 P1)', () => {
  it('signs a sequenced projection that verifies, counts pending exposure as spent, marks signer-dependent lots and carries custody from a fresh reconciliation', async () => {
    const { repo, inserted } = fakeRepo();
    const d = await deps(repo);
    const report = await runStateProjectorCycle(d);
    expect(report).toMatchObject({ sequence: 3, chainSlot: 500, lots: 1, sleeves: 1, custody: 1, reconciliationAgeMs: 30_000, reconciliationStatus: 'CLEAN', exposureBaseUnits: '1200000000', pendingBaseUnits: '200000000' });
    const env = inserted[0]!;
    expect(SignedRiskStateProjection.safeParse(env).success).toBe(true);
    expect((await verifySignedEnvelope(env, [d.key])).ok).toBe(true);
    expect(env.payload).toMatchObject({ sequence: 3, releaseId: release.id, releaseDigest: release.digest, policyVersion: 'risk-v1', settlementAvailableBaseUnits: '9000000000', gasReserveLamports: '1000000000', aggregateNonSettlementExposureBaseUnits: '1200000000', signerDependentExposureBaseUnits: '1000000000', custody: [{ custodyAccountId: IDS.custody, mint: USDC, amount: '9000000000' }] });
    expect(env.payload.sleeves).toEqual([{ sleeveId: uuid(5), strategyVersionId: 'S0_SAFE@1.2.0', committedBaseUnits: '1000000000', capBaseUnits: '4000000000', riskRemainingBaseUnits: '400000000' }]);
    expect(env.payload.drawdown).toMatchObject({ consecutiveLosses: 1, circuitBreakerTripped: false });
    expect(env.payload.drawdown.dailyFraction).toBeCloseTo((10_500 - 10_100) / 10_500, 5);
    expect(env.payload.cohortCapacity).toEqual([{ id: 'memes', usedFraction: expect.closeTo(1000 / 10_100, 5), capFraction: DEFAULT_RISK_POLICY.maxCohortExposureFraction }]);
    expect(env.payload.clusterCapacity).toEqual([{ id: 'c1', usedFraction: expect.closeTo(1000 / 10_100, 5), capFraction: DEFAULT_RISK_POLICY.maxClusterExposureFraction }]);
    expect(env.payload.capitalAttestation).toEqual({ ceilingUsd: 10_000, recognizedUsd: 10_100, reattestRequired: true });
    expect(env.payload.freshnessSummary.find((f) => f.dataClass === 'CANDLES')).toEqual({ dataClass: 'CANDLES', ageMs: 20_000, fresh: true });
    expect(env.payload.freshnessSummary.find((f) => f.dataClass === 'ACTIVE_POSITION_PRICE')?.fresh).toBe(true);
    expect(env.payload.eligibilitySummary).toEqual([{ assetId: IDS.asset, evaluationId: uuid(2), eligible: true, evaluatedAt: addMs(T0, -60_000) }]);
    // sequence advances on the next tick and a tampered payload no longer verifies
    expect((await runStateProjectorCycle(d)).sequence).toBe(4);
    const tampered = { ...env, payload: { ...env.payload, settlementAvailableBaseUnits: '99000000000' } } as Signed;
    expect((await verifySignedEnvelope(tampered, [d.key])).ok).toBe(false);
  });

  it('a stale or unavailable reconciliation projects no custody and slot 0, so a live entry cannot rest on it', async () => {
    const stale = fakeRepo({ async latestReconciliation() { return { evaluatedAt: addMs(T0, -3_600_000), chainSlot: 400 as never, status: 'CLEAN' as const, balances: [] }; } });
    const r1 = await runStateProjectorCycle(await deps(stale.repo));
    expect(r1).toMatchObject({ custody: 0, chainSlot: 0, reconciliationAgeMs: 3_600_000 });
    const none = fakeRepo({ async latestReconciliation() { return null; } });
    const r2 = await runStateProjectorCycle(await deps(none.repo));
    expect(r2).toMatchObject({ custody: 0, chainSlot: 0, reconciliationAgeMs: null, reconciliationStatus: null });
    const unavailable = fakeRepo({ async latestReconciliation() { return { evaluatedAt: T0, chainSlot: 600 as never, status: 'UNAVAILABLE' as const, balances: [] }; } });
    expect((await runStateProjectorCycle(await deps(unavailable.repo))).custody).toBe(0);
  });
});
