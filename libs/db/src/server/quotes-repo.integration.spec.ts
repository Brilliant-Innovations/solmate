import { randomUUID } from 'node:crypto';
import { addMs, quoteProbeOf, toInstant, type Amount, type Bps, type MintAddress, type Quote, type Uuid } from '@sol-agent-trader/contracts';
import { insertQuoteProbes, listQuoteProbesForCycle } from './quotes-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;

describe.skipIf(!url)('quote probes (§18.1 Level B capture)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 8, 14, 0, 0));
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'quotes-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('writes probes once (idempotent on id), keeps them immutable and lists them per cycle in the order taken', async () => {
    const quote: Quote = { provider: 'JUPITER', providerRequestId: null, routerLabel: 'test', inputMint: USDC, outputMint: TOKEN, inputAmount: '100000000' as Amount, expectedOutputAmount: '995000' as Amount, minOutputAmount: '985050' as Amount, priceImpactBps: 20 as Bps, slippageBps: 100 as Bps, routeProgramIds: [], usesAddressLookupTables: false, quotedAt: NOW, expiresAt: null, lastValidBlockHeight: null };
    const a = quoteProbeOf(randomUUID() as Uuid, quote, 'DECISION', addMs(NOW, 100), {});
    const b = quoteProbeOf(randomUUID() as Uuid, { ...quote, quotedAt: addMs(NOW, 1_500), expectedOutputAmount: '990000' as Amount }, 'EXECUTABLE', addMs(NOW, 1_600), {});
    expect(await insertQuoteProbes(sql, [a, b])).toBe(2);
    expect(await insertQuoteProbes(sql, [a])).toBe(1); // conflict on id is ignored, never a duplicate row
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from market.quote_probes where id in (${a.id}, ${b.id})`;
    expect(n?.n).toBe(2);
    await expect(sql`update market.quote_probes set expected_output_amount = 1 where id = ${a.id}`).rejects.toThrow();
    expect(await listQuoteProbesForCycle(sql, randomUUID())).toEqual([]);
  });
});
