import { randomUUID } from 'node:crypto';
import { chargeProviderSpend, loadProviderSpend } from './provider-spend-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('provider spend repository (§21.1)', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'provider-spend-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('charges accumulate per provider and month and load back for a restart', async () => {
    const provider = `TEST-${randomUUID().slice(0, 8)}`;
    expect(await loadProviderSpend(sql, provider, '2026-09')).toBeNull();
    expect(await chargeProviderSpend(sql, provider, '2026-09', '/defi/ohlcv', 45)).toBe(45);
    expect(await chargeProviderSpend(sql, provider, '2026-09', '/defi/token_overview', 15)).toBe(60);
    expect(await chargeProviderSpend(sql, provider, '2026-09', '/defi/ohlcv', 45)).toBe(105);
    expect(await loadProviderSpend(sql, provider, '2026-09')).toEqual({ provider, month: '2026-09', usedCu: 105, byEndpoint: { '/defi/ohlcv': 90, '/defi/token_overview': 15 } });
    expect(await loadProviderSpend(sql, provider, '2026-10')).toBeNull();
  });
});
