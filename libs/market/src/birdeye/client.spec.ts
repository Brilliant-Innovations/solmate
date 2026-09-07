import { fixedClock, toInstant, type Instant, type ProviderTier, type Uuid } from '@sol-agent-trader/contracts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.js';
import { BirdeyeClient, BudgetExhaustedError, ProviderResponseError } from './client.js';
import { BIRDEYE_TIERS } from './tiers.js';

/**
 * Recorded-shape fixtures (data.birdeye.so docs, 2026-09-06) behind a scripted transport. Every
 * test proves a property of the adapter, not of Birdeye.
 */

const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT2 = 'So11111111111111111111111111111111111111112';
const T0 = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(json) });

function scripted(responses: (HttpResponse | Error)[]) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

function makeClient(transport: HttpTransport, tier: ProviderTier = BIRDEYE_TIERS.LITE) {
  const sleeps: number[] = [];
  const client = new BirdeyeClient({ apiKey: 'test-key', tier, transport, clock: fixedClock(T0), sleep: async (ms) => void sleeps.push(ms) });
  return { client, sleeps };
}

const candleItems = (startS: number, n: number, type = '1m') =>
  Array.from({ length: n }, (_, i) => ({ o: 1 + i, h: 1.5 + i, l: 0.9 + i, c: 1.2 + i, v: 10, v_usd: 100 + i, unix_time: startS + i * 60, address: MINT, type, currency: 'usd' }));

describe('BirdeyeClient', () => {
  it('sends the key in the header only, never in the URL, and normalises candles with provenance', async () => {
    const start = Date.UTC(2026, 8, 6, 11, 0, 0) / 1000;
    const { transport, calls } = scripted([ok({ success: true, data: { items: candleItems(start, 3) } })]);
    const { client } = makeClient(transport);
    const res = await client.candles({ assetId: ASSET, mintAddress: MINT, resolution: '1m', from: toInstant(start * 1000), to: toInstant((start + 180) * 1000), provenance: 'BACKFILL' });
    expect(calls[0]?.headers['X-API-KEY']).toBe('test-key');
    expect(calls[0]?.url).not.toContain('test-key');
    expect(calls[0]?.url).toContain('/defi/v3/ohlcv');
    expect(calls[0]?.url).toContain('type=1m');
    expect(res.candles).toHaveLength(3);
    expect(res.candles[0]).toMatchObject({ assetId: ASSET, provider: 'BIRDEYE', resolution: '1m', provenance: 'BACKFILL', open: 1, close: 1.2, volumeUsd: 100, observedAt: T0 });
    expect(res.meta.computeUnits).toBe(45);
    expect(client.ledger.snapshot().used).toBe(45);
  });

  it('drops zero, inconsistent, misaligned and wrong-interval candles with reasons instead of storing them', async () => {
    const start = Date.UTC(2026, 8, 6, 11, 0, 0) / 1000;
    const items = [
      ...candleItems(start, 1),
      { o: 0, h: 0, l: 0, c: 0, v: 0, v_usd: 0, unix_time: start + 60, address: MINT, type: '1m', currency: 'usd' },
      { o: 1, h: 0.5, l: 0.9, c: 1.2, v: 1, v_usd: 1, unix_time: start + 120, address: MINT, type: '1m', currency: 'usd' },
      { o: 1, h: 1.5, l: 0.9, c: 1.2, v: 1, v_usd: 1, unix_time: start + 190, address: MINT, type: '1m', currency: 'usd' },
      { o: 1, h: 1.5, l: 0.9, c: 1.2, v: 1, v_usd: 1, unix_time: start + 240, address: MINT, type: '5m', currency: 'usd' },
      { o: 1, h: 1.5, l: 0.9, c: 1.2, v: 1, v_usd: null, unix_time: start + 300, address: MINT, type: '1m', currency: 'usd' },
    ];
    const { transport } = scripted([ok({ success: true, data: { items } })]);
    const { client } = makeClient(transport);
    const res = await client.candles({ assetId: ASSET, mintAddress: MINT, resolution: '1m', from: toInstant(start * 1000), to: toInstant((start + 360) * 1000), provenance: 'LIVE' });
    expect(res.candles).toHaveLength(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(['NON_POSITIVE_CLOSE', 'INCONSISTENT_OHLC', 'MISALIGNED_BUCKET', 'WRONG_INTERVAL', 'MISSING_VOLUME']);
  });

  it('retries 429 and 5xx with backoff honouring Retry-After, then succeeds; a 4xx is not retried', async () => {
    const { transport, calls } = scripted([
      { status: 429, headers: { 'retry-after': '2' }, body: 'slow down' },
      { status: 503, headers: {}, body: 'busy' },
      ok({ success: true, data: { [MINT]: { value: 1.01, updateUnixTime: 1_788_000_000, liquidity: 5000 } } }),
    ]);
    const { client, sleeps } = makeClient(transport);
    const res = await client.prices([MINT]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 1000]);
    expect(res.quotes).toEqual([expect.objectContaining({ mintAddress: MINT, priceUsd: 1.01, liquidityUsd: 5000, provider: 'BIRDEYE' })]);
    expect(res.meta.attempts).toBe(3);

    const bad = scripted([{ status: 401, headers: {}, body: '{"success":false,"message":"unauthorized"}' }]);
    await expect(makeClient(bad.transport).client.prices([MINT])).rejects.toThrow(/HTTP 401/);
    expect(bad.calls).toHaveLength(1);
  });

  it('never returns a zero or null price as a quote', async () => {
    const { transport } = scripted([ok({ success: true, data: { [MINT]: { value: 0, updateUnixTime: 1 }, [MINT2]: null, notamint: { value: 3 } } })]);
    const { client } = makeClient(transport);
    const res = await client.prices([MINT, MINT2]);
    expect(res.quotes).toEqual([]);
  });

  it('refuses to exceed the purchased compute-unit allowance for NORMAL work but keeps the CRITICAL reserve', async () => {
    const { transport } = scripted(Array.from({ length: 10 }, () => ok({ success: true, data: { [MINT]: { value: 2 } } })));
    // multi_price(1) = 3 CU. Allowance 12 → NORMAL ceiling 10.8 (10% critical reserve).
    const tier: ProviderTier = { ...BIRDEYE_TIERS.STANDARD, computeUnitsPerMonth: 12 };
    const { client } = makeClient(transport, tier);
    await client.prices([MINT]); // 3
    await client.prices([MINT]); // 6
    await client.prices([MINT]); // 9
    await expect(client.prices([MINT])).rejects.toBeInstanceOf(BudgetExhaustedError); // 12 > 10.8 for NORMAL
    await expect(client.prices([MINT], 'CRITICAL')).resolves.toBeDefined(); // 12 <= 12 for CRITICAL
    await expect(client.prices([MINT], 'CRITICAL')).rejects.toBeInstanceOf(BudgetExhaustedError); // 15 > 12
    expect(client.ledger.snapshot()).toMatchObject({ used: 12, remaining: 0 });
  });

  it('paces requests to the tier rate through the injected sleep', async () => {
    const { transport } = scripted(Array.from({ length: 3 }, () => ok({ success: true, data: { [MINT]: { value: 2 } } })));
    const { client, sleeps } = makeClient(transport, BIRDEYE_TIERS.STANDARD); // 1 rps, burst 1, frozen clock
    await client.prices([MINT]);
    await client.prices([MINT]);
    await client.prices([MINT]);
    expect(sleeps.length).toBe(2);
    expect(sleeps.every((s) => s === 1000)).toBe(true);
  });

  it('rejects malformed provider payloads instead of guessing', async () => {
    const { transport } = scripted([ok({ success: true, data: { items: 'nope' } })]);
    const { client } = makeClient(transport);
    await expect(client.candles({ assetId: ASSET, mintAddress: MINT, resolution: '1m', from: T0, to: toInstant(Date.parse(T0) + 60_000), provenance: 'LIVE' })).rejects.toBeInstanceOf(ProviderResponseError);
    const notJson = scripted([{ status: 200, headers: {}, body: '<html>' }]);
    await expect(makeClient(notJson.transport).client.trending()).rejects.toThrow(/not JSON/);
  });

  it('normalises trending, new listings and token list into DiscoveredToken keyed by mint', async () => {
    const { transport } = scripted([
      ok({ success: true, data: { updateUnixTime: 1_788_000_000, total: 2, tokens: [{ address: MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, liquidity: 1e6, price: 1, volume24hUSD: 5e6, rank: 1, marketcap: 3e10 }, { address: 'bad', decimals: 6 }] } }),
      ok({ success: true, data: { items: [{ address: MINT2, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, source: 'raydium', liquidityAddedAt: '2026-09-06T10:00:00.000Z', liquidity: 1234 }] } }),
      ok({ success: true, data: { items: [{ address: MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, liquidity: 2e6, price: 1, volume_24h_usd: 6e6, market_cap: 3e10, last_trade_unix_time: 1_788_000_000 }], hasNext: false } }),
    ]);
    const { client } = makeClient(transport);
    const t = await client.trending({ limit: 50 });
    expect(t.tokens).toHaveLength(1);
    expect(t.tokens[0]).toMatchObject({ mintAddress: MINT, source: 'BIRDEYE_TRENDING', rank: 1, liquidityUsd: 1e6, providerUpdatedAt: toInstant(1_788_000_000_000) });
    const n = await client.newListings();
    expect(n.tokens[0]).toMatchObject({ mintAddress: MINT2, source: 'BIRDEYE_NEW_LISTING', listedAt: '2026-09-06T10:00:00.000Z' as Instant, priceUsd: null });
    const l = await client.tokenList({ minLiquidityUsd: 10_000 });
    expect(l.tokens[0]).toMatchObject({ mintAddress: MINT, source: 'BIRDEYE_TOKEN_LIST', liquidityUsd: 2e6 });
    expect(client.ledger.snapshot().used).toBe(25 + 20 + 50);
  });

  it('normalises token overview windows and never fabricates missing figures', async () => {
    const { transport } = scripted([
      ok({
        success: true,
        data: { address: MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, price: 1, liquidity: 1e6, marketCap: 3e10, fdv: 3e10, holder: 1000, numberMarkets: 50, lastTradeUnixTime: 1_788_000_000, v1hUSD: 1000, vBuy1hUSD: 600, vSell1hUSD: 400, trade1h: 10, buy1h: 6, sell1h: 4, uniqueWallet1h: 7, priceChange1hPercent: 0.5 },
      }),
    ]);
    const { client } = makeClient(transport);
    const { overview } = await client.overview(MINT);
    expect(overview?.windows.h1).toEqual({ volumeUsd: 1000, buyVolumeUsd: 600, sellVolumeUsd: 400, tradeCount: 10, buyCount: 6, sellCount: 4, uniqueWallets: 7, priceChangePct: 0.5 });
    expect(overview?.windows.h24).toEqual({ volumeUsd: null, buyVolumeUsd: null, sellVolumeUsd: null, tradeCount: null, buyCount: null, sellCount: null, uniqueWallets: null, priceChangePct: null });
    expect(overview?.holderCount).toBe(1000);
  });
});
