import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Candidate, type DiscoveredToken, type FeatureSnapshot, type Uuid } from '@sol-agent-trader/contracts';
import { expireCandidates, insertCandidate, lastTerminalCandidateAt, listOpenCandidates, listScanInputs } from './candidates-repo.js';
import { insertFeatureSnapshot } from './features-repo.js';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('candidates repository (§6.9)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mint = () => Array.from({ length: 44 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('') as DiscoveredToken['mintAddress'];
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'candidates-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('scan inputs pair the latest feature snapshot with the latest eligibility record for ELIGIBLE assets; candidates dedupe, expire and cool down', async () => {
    const [a] = await upsertDiscoveredAssets(sql, [{ mintAddress: mint(), symbol: 'C', name: 'C', decimals: 6, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const assetId = a!.id;
    const eligibilityId = randomUUID() as Uuid;
    await sql`insert into core.asset_eligibility (id, asset_id, evaluated_at, policy_version, eligible, hard_reject, rejection_reasons, grade, mint_authority, freeze_authority, jupiter_route_available, settlement_route_confirmed, price_impact_probes, freshness)
      values (${eligibilityId}, ${assetId}, ${NOW}, 'eligibility-v1', true, false, '{}', 100, 'NONE', 'NONE', true, true, '[]'::jsonb, '{"securityProviderAt": null, "chainReadAt": "2026-09-08T14:00:00.000Z", "chainSlot": 1}'::jsonb)`;
    await sql`update core.assets set status = 'ELIGIBLE' where id = ${assetId}`;
    const snapshot: FeatureSnapshot = { id: randomUUID() as Uuid, assetId, asOf: NOW, featureEngineVersion: 'features-v1' as never, provenance: 'LIVE', marketSnapshotId: null, features: { ret_15m: 0.03 }, regime: null, marketSessions: ['US'], selfInfluenceSuppressed: false };
    await insertFeatureSnapshot(sql, snapshot);
    const inputs = await listScanInputs(sql, 10_000);
    const mine = inputs.find((i) => i.snapshot.assetId === assetId);
    expect(mine).toMatchObject({ eligibilityEvaluationId: eligibilityId });
    expect(mine?.snapshot.features).toEqual({ ret_15m: 0.03 });

    const candidate: Candidate = { id: randomUUID() as Uuid, assetId, discoveredAt: NOW, triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: { score: 70 }, scannerScore: 70, status: 'DETECTED', featureSnapshotId: snapshot.id, eligibilityEvaluationId: eligibilityId, expiresAt: addMs(NOW, 600_000), deterministicRejectionReason: null, dedupeKey: `${assetId}:MOMENTUM_CONTINUATION:1`, strategyVersionIds: [] };
    await insertCandidate(sql, candidate);
    expect(await listOpenCandidates(sql, assetId, 'MOMENTUM_CONTINUATION')).toHaveLength(1);
    expect(await lastTerminalCandidateAt(sql, assetId, 'MOMENTUM_CONTINUATION')).toBeNull();
    expect(await expireCandidates(sql, addMs(NOW, 599_000))).toBe(0);
    expect(await expireCandidates(sql, addMs(NOW, 600_000))).toBeGreaterThanOrEqual(1);
    expect(await listOpenCandidates(sql, assetId, 'MOMENTUM_CONTINUATION')).toHaveLength(0);
    expect(await lastTerminalCandidateAt(sql, assetId, 'MOMENTUM_CONTINUATION')).not.toBeNull();
    await insertCandidate(sql, { ...candidate, id: randomUUID() as Uuid, status: 'REJECTED', deterministicRejectionReason: 'ELIGIBILITY_STALE', dedupeKey: `${assetId}:MOMENTUM_CONTINUATION:2` });
    expect(await listOpenCandidates(sql, assetId, 'MOMENTUM_CONTINUATION')).toHaveLength(0);
  });
});
