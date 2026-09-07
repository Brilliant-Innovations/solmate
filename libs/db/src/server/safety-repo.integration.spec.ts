import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type DiscoveredToken, type HeldAssetSafety, type Uuid } from '@sol-agent-trader/contracts';
import { insertEmergencyRouteSnapshot } from './eligibility-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { latestEmergencySnapshot, listOpenPositions, previousSafetyBaseline, recordPositionSafety } from './safety-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('safety repository (§7.5 append-only evaluations, position pointer)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 9, 3, 12, 0, 0));
  const mint = () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < 44; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s as DiscoveredToken['mintAddress'];
  };
  const token = (m: DiscoveredToken['mintAddress']): DiscoveredToken => ({ mintAddress: m, symbol: 'T', name: 'T', decimals: 6, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW });

  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'safety-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function openPosition(): Promise<{ positionId: Uuid; assetId: Uuid; mint: string }> {
    const m = mint();
    const [a] = await upsertDiscoveredAssets(sql, [token(m)], NOW);
    const accountId = randomUUID();
    await sql`insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint) values (${accountId}, ${'test-' + accountId.slice(0, 8)}, 'mainnet-beta', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')`;
    const positionId = randomUUID() as Uuid;
    await sql`insert into trading.positions (id, account_id, asset_id, mint, quantity, review_state_since, opened_at) values (${positionId}, ${accountId}, ${a!.id}, ${m}, '1000000', ${NOW}, ${NOW})`;
    return { positionId, assetId: a!.id, mint: m };
  }

  const evaluation = (positionId: Uuid, assetId: Uuid, over: Partial<HeldAssetSafety> = {}): HeldAssetSafety => ({
    id: randomUUID() as Uuid, positionId, assetId, evaluatedAt: NOW, policyVersion: 'safety-v1' as never, state: 'DEGRADED', previousState: 'NORMAL', reasons: ['EMERGENCY_ROUTE_MISSING'], triggers: ['PERIODIC'],
    exitCompatibility: { primaryRouteAvailable: true, primaryImpactBps: 40 as never, emergencyRouteAvailable: false, emergencySnapshotAgeMs: null, token2022Compatible: true, canReduceNow: true },
    positionQuantity: '1000000' as never, chainSlot: 445_000_000 as never, liquidityUsd: 100_000,
    observed: { freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: null, liquidityUsd: 100_000, top10: 0.2, emergencyPoolAddress: null },
    baseline: { source: 'ENTRY_ELIGIBILITY', freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: null, liquidityUsd: 120_000, top10: 0.18, emergencyPoolAddress: null },
    ...over,
  });

  it('lists open positions, records an evaluation with the pointer, and the observed facts become the next baseline', async () => {
    const { positionId, assetId, mint: m } = await openPosition();
    const open = await listOpenPositions(sql, 1000);
    expect(open.find((p) => p.id === positionId)).toMatchObject({ assetId, mint: m, quantity: '1000000', safetyState: 'NORMAL' });
    expect(await previousSafetyBaseline(sql, positionId)).toBeNull();

    await recordPositionSafety(sql, evaluation(positionId, assetId));
    const [row] = await sql<{ safety_state: string }[]>`select safety_state from trading.positions where id = ${positionId}`;
    expect(row!.safety_state).toBe('DEGRADED');
    const prev = await previousSafetyBaseline(sql, positionId);
    expect(prev?.state).toBe('DEGRADED');
    expect(prev?.baseline).toEqual({ source: 'PREVIOUS_SAFETY', freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: null, liquidityUsd: 100_000, top10: 0.2, emergencyPoolAddress: null });

    await recordPositionSafety(sql, evaluation(positionId, assetId, { evaluatedAt: addMs(NOW, 60_000), state: 'CRITICAL_EXIT', previousState: 'DEGRADED', reasons: ['MINT_PAUSED'] }));
    const [row2] = await sql<{ safety_state: string }[]>`select safety_state from trading.positions where id = ${positionId}`;
    expect(row2!.safety_state).toBe('CRITICAL_EXIT');
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from trading.position_safety_evaluations where position_id = ${positionId}`;
    expect(count!.n).toBe(2);
    await sql`update trading.positions set status = 'CLOSED', closed_at = now() where id = ${positionId}`;
    await expect(recordPositionSafety(sql, evaluation(positionId, assetId, { evaluatedAt: addMs(NOW, 120_000) }))).rejects.toThrow(/closed/);
  });

  it('the latest emergency snapshot for an asset is read back in contract shape', async () => {
    const { assetId, mint: m } = await openPosition();
    expect(await latestEmergencySnapshot(sql, assetId)).toBeNull();
    const older = randomUUID() as Uuid;
    const newer = randomUUID() as Uuid;
    for (const [id, at] of [[older, addMs(NOW, -3_600_000)], [newer, NOW]] as const) {
      await insertEmergencyRouteSnapshot(sql, {
        id, assetId, hops: [{ program: 'METEORA_DLMM', programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as never, poolAddress: 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ' as never, inputMint: m as never, outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never }],
        settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never, poolStateRef: 'ref', lastRefreshedAt: at, lastRefreshSlot: 1 as never, capacity: [], token2022Compatible: true, lastDryRun: null,
      });
    }
    const latest = await latestEmergencySnapshot(sql, assetId);
    expect(latest?.id).toBe(newer);
    expect(latest?.hops[0]?.program).toBe('METEORA_DLMM');
    expect(latest?.lastRefreshedAt).toBe(NOW);
  });
});
