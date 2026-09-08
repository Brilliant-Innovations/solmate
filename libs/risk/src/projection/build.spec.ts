import fc from 'fast-check';
import { DEFAULT_RISK_POLICY, RiskStateProjection, addMs, fixtures, generateSigningKeyPair, verifySignedEnvelope, type Amount, type Instant, type MintAddress, type Sequence, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { buildRiskStateProjection, freshnessSummaryFrom, signProjection, type ProjectionFacts } from './build.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;

function facts(patch: Partial<ProjectionFacts> = {}): ProjectionFacts {
  return {
    sequence: 1 as Sequence, asOf: T0, chainSlot: 100 as never, release: { id: uuid(7), digest: 'ab'.repeat(32) as Sha256Hex }, policyVersion: 'risk-v1' as VersionId, sourceDigests: [{ source: 'b', digest: 'cd'.repeat(32) as Sha256Hex }, { source: 'a', digest: 'ef'.repeat(32) as Sha256Hex }],
    settlementMint: fixtures.MINTS.USDC as MintAddress, custody: [], settlementAvailableBaseUnits: '9000000000' as Amount, gasReserveLamports: '1000000000' as Amount, pendingExposureBaseUnits: '0' as Amount, sleeves: [], openLots: [], equityBaseUnits: '10000000000' as Amount, exposureUsd: null,
    dayStartEquity: null, rollingHighEquity: null, consecutiveLosses: 0, circuitBreakerTripped: false, memberships: [], clusterSet: null, policy: DEFAULT_RISK_POLICY, eligibility: [], freshness: [], capital: { ceilingUsd: 10_000, recognizedUsd: 10_000 }, ...patch,
  };
}
const lot = (n: number, cost: string, mode: 'MONITORED_EXIT' | 'JUPITER_TRIGGER', active: boolean, assetId: Uuid = IDS.asset as Uuid) => ({ lotId: uuid(n), positionId: IDS.position as Uuid, assetId, mint: fixtures.MINTS.RISK as MintAddress, quantity: '1' as Amount, costBasisBaseUnits: cost as Amount, protectionMode: mode, providerProtectionActive: active });

describe('risk state projection builder (§6.14A, D21; ADR-0009 P1, P5)', () => {
  it('is a valid, canonically ordered projection; pending exposure counts as spent; only ACTIVE provider protection is not signer-dependent', () => {
    const p = buildRiskStateProjection(facts({ pendingExposureBaseUnits: '250000000' as Amount, openLots: [lot(2, '1000000000', 'JUPITER_TRIGGER', true), lot(1, '500000000', 'MONITORED_EXIT', false), lot(3, '300000000', 'JUPITER_TRIGGER', false)], custody: [{ custodyAccountId: uuid(9), mint: fixtures.MINTS.USDC as MintAddress, amount: '1' as Amount }, { custodyAccountId: uuid(8), mint: fixtures.MINTS.USDC as MintAddress, amount: '2' as Amount }] }));
    expect(RiskStateProjection.safeParse(p).success).toBe(true);
    expect(p.aggregateNonSettlementExposureBaseUnits).toBe('2050000000');
    expect(p.signerDependentExposureBaseUnits).toBe('800000000'); // MONITORED_EXIT plus the trigger lot whose order is not ACTIVE
    expect(p.openLots.map((l) => l.lotId)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(p.sourceDigests.map((s) => s.source)).toEqual(['a', 'b']);
    expect(p.custody.map((c) => c.custodyAccountId)).toEqual([uuid(8), uuid(9)]);
    expect(p.capitalAttestation).toEqual({ ceilingUsd: 10_000, recognizedUsd: 10_000, reattestRequired: false });
  });

  it('drawdown, cohort and cluster capacity come from equity and open lots; an inactive sleeve is not projected', () => {
    const p = buildRiskStateProjection(facts({
      openLots: [lot(1, '2000000000', 'MONITORED_EXIT', false), lot(2, '1000000000', 'MONITORED_EXIT', false, uuid(20))],
      dayStartEquity: '12500000000' as Amount, rollingHighEquity: '20000000000' as Amount, consecutiveLosses: 3, circuitBreakerTripped: true,
      memberships: [{ assetId: IDS.asset as Uuid, cohortId: uuid(30), cohortName: 'memes' }, { assetId: uuid(20), cohortId: uuid(31), cohortName: 'dex' }, { assetId: uuid(20), cohortId: uuid(30), cohortName: 'memes' }],
      clusterSet: { id: uuid(40), versionId: 'clusters-v1' as VersionId, windowStart: T0, windowEnd: T0, calculatedAt: T0, method: 'pearson', clusters: [{ clusterId: 'k2', assetIds: [uuid(20)] }, { clusterId: 'k1', assetIds: [IDS.asset as Uuid, uuid(20)] }] },
      sleeves: [{ id: uuid(50), accountId: IDS.account as Uuid, strategyVersionId: 'S1@1.0.0' as VersionId, versionId: 'sleeve-v1' as VersionId, settlementMint: fixtures.MINTS.USDC as MintAddress, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '3000000000' as Amount, riskUsedBaseUnits: '600000000' as Amount, active: true, createdAt: T0 }, { id: uuid(51), accountId: IDS.account as Uuid, strategyVersionId: 'S9@1.0.0' as VersionId, versionId: 'sleeve-v1' as VersionId, settlementMint: fixtures.MINTS.USDC as MintAddress, capitalCapBaseUnits: '1' as Amount, riskBudgetBaseUnits: '1' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: false, createdAt: T0 }],
    }));
    expect(p.drawdown).toEqual({ dailyFraction: 0.2, rollingFraction: 0.5, circuitBreakerTripped: true, consecutiveLosses: 3 });
    expect(p.cohortCapacity).toEqual([{ id: 'dex', usedFraction: 0.1, capFraction: 0.3 }, { id: 'memes', usedFraction: 0.3, capFraction: 0.3 }]);
    expect(p.clusterCapacity).toEqual([{ id: 'k1', usedFraction: 0.3, capFraction: 0.3 }, { id: 'k2', usedFraction: 0.1, capFraction: 0.3 }]);
    expect(p.sleeves).toEqual([{ sleeveId: uuid(50), strategyVersionId: 'S1@1.0.0', committedBaseUnits: '3000000000', capBaseUnits: '4000000000', riskRemainingBaseUnits: '0' }]);
  });

  it('freshness summary reads provider health per data class; unknown provider or no success is not fresh', () => {
    const s = freshnessSummaryFrom([{ provider: 'BIRDEYE', lastSuccessAt: addMs(T0, -100_000) }], { version: 'f' as VersionId, speedTier: 'T1_STANDARD', requirements: [{ dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' }, { dataClass: 'TOKEN_OVERVIEW', freshMaxAgeMs: 120_000, degradedMaxAgeMs: 600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' }, { dataClass: 'CANDIDATE_PRICE', freshMaxAgeMs: 30_000, degradedMaxAgeMs: 90_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' }] }, (c) => (c === 'CANDIDATE_PRICE' ? 'JUPITER' : 'BIRDEYE'), T0);
    expect(s).toEqual([{ dataClass: 'CANDLES', ageMs: 100_000, fresh: false }, { dataClass: 'TOKEN_OVERVIEW', ageMs: 100_000, fresh: true }, { dataClass: 'CANDIDATE_PRICE', ageMs: null, fresh: false }]);
  });

  it('property: the projection is valid and deterministic for any lots, and the signed envelope verifies only with the signing key and only unmodified', async () => {
    const key = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ cost: fc.bigInt({ min: 0n, max: 10n ** 12n }), monitored: fc.boolean(), active: fc.boolean() }), { maxLength: 6 }), fc.bigInt({ min: 0n, max: 10n ** 12n }), async (lots, pending) => {
        const f = facts({ pendingExposureBaseUnits: pending.toString() as Amount, openLots: lots.map((l, i) => lot(i + 1, l.cost.toString(), l.monitored ? 'MONITORED_EXIT' : 'JUPITER_TRIGGER', l.active)) });
        const a = buildRiskStateProjection(f);
        const b = buildRiskStateProjection({ ...f, openLots: [...f.openLots].reverse() });
        expect(RiskStateProjection.safeParse(a).success).toBe(true);
        expect(a).toEqual(b);
        expect(BigInt(a.aggregateNonSettlementExposureBaseUnits)).toBe(lots.reduce((acc, l) => acc + l.cost, 0n) + pending);
        expect(BigInt(a.signerDependentExposureBaseUnits)).toBeLessThanOrEqual(BigInt(a.aggregateNonSettlementExposureBaseUnits));
        const env = await signProjection(a, key, T0);
        expect((await verifySignedEnvelope(env, [key])).ok).toBe(true);
        expect((await verifySignedEnvelope(env, [other])).ok).toBe(false);
      }),
      { numRuns: 25 },
    );
  });
});
