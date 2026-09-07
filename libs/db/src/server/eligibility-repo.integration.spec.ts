import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type AssetEligibility, type DiscoveredToken, type Uuid } from '@sol-agent-trader/contracts';
import { insertEmergencyRouteSnapshot, latestEligibility, listAssetsForEvaluation, recordEligibility } from './eligibility-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('eligibility repository (§6.2 append-only records, status pointer)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 9, 2, 12, 0, 0));
  const mint = () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < 44; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s as DiscoveredToken['mintAddress'];
  };
  const token = (m: DiscoveredToken['mintAddress']): DiscoveredToken => ({ mintAddress: m, symbol: 'T', name: 'T', decimals: 6, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW });
  const record = (assetId: Uuid, over: Partial<AssetEligibility> = {}): AssetEligibility => ({
    id: randomUUID() as Uuid, assetId, evaluatedAt: NOW, policyVersion: 'eligibility-v1' as never, eligible: false, hardReject: true, rejectionReasons: ['ROUTE_PROBE_UNAVAILABLE'], grade: 90,
    liquidityUsd: 1000, volume24hUsd: null, holderCount: null, concentration: { source: 'CHAIN', chainSlot: 5 as never, top1: 0.1, top5: 0.2, top10: 0.3, top20: 0.4, analyticsMismatch: false },
    mintAuthority: 'NONE', freezeAuthority: 'NONE', token2022: null, securityFlags: [], transferRestrictions: [], jupiterRouteAvailable: false, settlementRouteConfirmed: false, priceImpactProbes: [],
    insiderMetrics: null, emergencyExitRouteSnapshotId: null, freshness: { securityProviderAt: NOW, chainReadAt: NOW, chainSlot: 5 as never }, ...over,
  });

  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'eligibility-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('records are appended with the status pointer in one transaction, immutable afterwards, and the latest one is read back', async () => {
    const [a] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const first = record(a!.id);
    await recordEligibility(sql, first, 'EVALUATING');
    let [row] = await sql<{ status: string }[]>`select status from core.assets where id = ${a!.id}`;
    expect(row!.status).toBe('EVALUATING');
    const second = record(a!.id, { evaluatedAt: addMs(NOW, 60_000), eligible: true, hardReject: false, rejectionReasons: [], grade: 100, jupiterRouteAvailable: true, settlementRouteConfirmed: true });
    await recordEligibility(sql, second, 'ELIGIBLE');
    [row] = await sql<{ status: string }[]>`select status from core.assets where id = ${a!.id}`;
    expect(row!.status).toBe('ELIGIBLE');
    const latest = await latestEligibility(sql, a!.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.eligible).toBe(true);
    expect(latest?.concentration).toEqual(first.concentration);
    await expect(sql`update core.asset_eligibility set eligible = false where id = ${first.id}`).rejects.toThrow();
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from core.asset_eligibility where asset_id = ${a!.id}`;
    expect(count!.n).toBe(2);
  });

  it('an emergency route snapshot is persisted and an eligibility record can reference it', async () => {
    const [a] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const snapshotId = randomUUID() as Uuid;
    await insertEmergencyRouteSnapshot(sql, {
      id: snapshotId, assetId: a!.id,
      hops: [{ program: 'RAYDIUM_CLMM', programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as never, poolAddress: 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ' as never, inputMint: a!.mintAddress as never, outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never }],
      settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never, poolStateRef: 'CAMM:abc', lastRefreshedAt: NOW, lastRefreshSlot: 445_000_000 as never,
      capacity: [{ inputAmount: '1000000' as never, expectedOutputAmount: '990000' as never, impactBps: 20 as never }], token2022Compatible: true, lastDryRun: null,
    });
    await recordEligibility(sql, record(a!.id, { emergencyExitRouteSnapshotId: snapshotId }), 'EVALUATING');
    const latest = await latestEligibility(sql, a!.id);
    expect(latest?.emergencyExitRouteSnapshotId).toBe(snapshotId);
    const [row] = await sql<{ hops: unknown; capacity: unknown }[]>`select hops, capacity from core.emergency_exit_route_snapshots where id = ${snapshotId}`;
    expect((row!.hops as unknown[]).length).toBe(1);
    expect((row!.capacity as unknown[]).length).toBe(1);
  });

  it('evaluation queue: never-evaluated assets come first, recently evaluated ones wait, retired ones are skipped', async () => {
    const [fresh] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const [evaluated] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    const [retired] = await upsertDiscoveredAssets(sql, [token(mint())], NOW);
    await recordEligibility(sql, record(evaluated!.id, { evaluatedAt: addMs(NOW, 3_600_000 * 24 * 30) }), 'EVALUATING');
    await sql`update core.assets set status = 'RETIRED' where id = ${retired!.id}`;
    const due = await listAssetsForEvaluation(sql, { limit: 500, reevaluateAfter: addMs(NOW, 3_600_000 * 24 * 29) });
    const ids = due.map((d) => d.id);
    expect(ids).toContain(fresh!.id);
    expect(ids).not.toContain(evaluated!.id);
    expect(ids).not.toContain(retired!.id);
    expect(due.find((d) => d.id === fresh!.id)?.lastEvaluatedAt).toBeNull();
    const failed = record(retired!.id);
    await expect(recordEligibility(sql, failed, 'BLOCKED')).rejects.toThrow(/retired/);
  });
});
