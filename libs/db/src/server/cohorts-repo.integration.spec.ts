import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type CohortTaxonomyPolicy, type CorrelationClusterSet, type DiscoveredToken, type MintAddress, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { upsertDiscoveredAssets } from './market-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { insertClusterSet, installTaxonomy, latestClusterSet, listActiveMemberships } from './cohorts-repo.js';

const url = databaseUrlFromEnv();
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

describe.skipIf(!url)('cohorts repository (§6.3, D23)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'cohorts-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('installs a taxonomy version idempotently for known mints only, lists ACTIVE memberships per version, refuses an LLM suggestion as active, and reads the newest fresh cluster set', async () => {
    const known = b58(44) as MintAddress;
    const unknown = b58(44) as MintAddress;
    const [asset] = await upsertDiscoveredAssets(sql, [{ mintAddress: known as DiscoveredToken['mintAddress'], symbol: 'COH', name: 'Cohort', decimals: 9, source: 'MANUAL', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW }], NOW);
    const version = `cohorts-test-${randomUUID().slice(0, 8)}` as VersionId;
    const taxonomy: CohortTaxonomyPolicy = { version, cohorts: [{ name: `memes-${version}`, description: 'test' }, { name: `dex-${version}`, description: 'test' }], memberships: [{ mint: known, cohort: `memes-${version}`, confidence: 0.9 }, { mint: unknown, cohort: `dex-${version}`, confidence: 0.9 }] };
    expect(await installTaxonomy(sql, taxonomy)).toEqual({ version, cohorts: 2, memberships: 1, unknownMints: 1 });
    expect(await installTaxonomy(sql, taxonomy)).toEqual({ version, cohorts: 2, memberships: 0, unknownMints: 1 });
    const active = await listActiveMemberships(sql, version);
    expect(active).toEqual([expect.objectContaining({ assetId: asset!.id, cohortName: `memes-${version}`, effectiveVersion: version })]);
    // D23: the table itself refuses an LLM suggestion as ACTIVE
    const [cohort] = await sql<{ id: Uuid }[]>`select id from core.risk_cohorts where name = ${`dex-${version}`} and version_id = ${version}`;
    await expect(sql`insert into core.asset_cohort_memberships (asset_id, cohort_id, source, effective_version, confidence, approval_state) values (${asset!.id}, ${cohort!.id}, 'LLM_SUGGESTION', ${version}, 0.5, 'ACTIVE')`).rejects.toThrow();
    await sql`insert into core.asset_cohort_memberships (asset_id, cohort_id, source, effective_version, confidence, approval_state) values (${asset!.id}, ${cohort!.id}, 'LLM_SUGGESTION', ${version}, 0.5, 'INACTIVE_SUGGESTION')`;
    expect((await listActiveMemberships(sql, version)).map((m) => m.cohortName)).toEqual([`memes-${version}`]);
    // cluster sets: one per window; the newest fresh one wins; stale ones read as none
    const windowEnd = addMs(NOW, -3_600_000);
    const set: CorrelationClusterSet = { id: randomUUID() as Uuid, versionId: `clusters-test@${windowEnd}-${randomUUID().slice(0, 6)}` as VersionId, windowStart: addMs(windowEnd, -86_400_000), windowEnd, calculatedAt: NOW, method: 'test', clusters: [{ clusterId: 'c1', assetIds: [asset!.id] }] };
    expect(await insertClusterSet(sql, set)).toBe('INSERTED');
    expect(await insertClusterSet(sql, set)).toBe('EXISTS');
    const fresh = await latestClusterSet(sql, NOW, 2 * 3_600_000);
    expect(fresh?.windowEnd).toBeDefined();
    expect(await latestClusterSet(sql, addMs(NOW, 365 * 86_400_000), 3_600_000)).toBeNull();
  });
});
