import { fixedClock, toInstant } from '@sol-agent-trader/contracts';
import type { HttpRequest, HttpTransport } from '../http/transport.js';
import { JupiterPriceClient } from './price-v3.js';

const T0 = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT2 = 'So11111111111111111111111111111111111111112';

describe('Jupiter Price V3 client (§3.3 secondary price)', () => {
  it('uses the lite host without a key and api.jup.ag with x-api-key; omitted tokens stay omitted', async () => {
    const calls: HttpRequest[] = [];
    const transport: HttpTransport = async (req) => {
      calls.push(req);
      return { status: 200, headers: {}, body: JSON.stringify({ [MINT]: { usdPrice: 0.9998, blockId: 400_000_000, decimals: 6, priceChange24h: 0.01 } }) };
    };
    const lite = new JupiterPriceClient({ transport, clock: fixedClock(T0), sleep: async () => undefined });
    const r = await lite.prices([MINT, MINT2]);
    expect(calls[0]?.url.startsWith('https://lite-api.jup.ag/price/v3?ids=')).toBe(true);
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
    expect(r.quotes).toEqual([expect.objectContaining({ mintAddress: MINT, provider: 'JUPITER_PRICE_V3', priceUsd: 0.9998, blockId: 400_000_000, observedAt: T0 })]);

    const pro = new JupiterPriceClient({ transport, clock: fixedClock(T0), apiKey: 'k', sleep: async () => undefined });
    await pro.prices([MINT]);
    expect(calls[1]?.url.startsWith('https://api.jup.ag/price/v3')).toBe(true);
    expect(calls[1]?.headers['x-api-key']).toBe('k');
    expect(calls[1]?.url).not.toContain('k=');
  });

  it('enforces the 50-id limit, never emits zero prices, and retries 429 then gives up after maxAttempts', async () => {
    const transport: HttpTransport = async () => ({ status: 200, headers: {}, body: JSON.stringify({ [MINT]: { usdPrice: 0 }, [MINT2]: null }) });
    const c = new JupiterPriceClient({ transport, clock: fixedClock(T0), sleep: async () => undefined });
    await expect(c.prices(Array.from({ length: 51 }, () => MINT))).rejects.toThrow(/max 50/);
    expect((await c.prices([MINT, MINT2])).quotes).toEqual([]);

    const sleeps: number[] = [];
    const limited = new JupiterPriceClient({ transport: async () => ({ status: 429, headers: {}, body: '' }), clock: fixedClock(T0), sleep: async (ms) => void sleeps.push(ms), maxAttempts: 2, requestsPerSecond: 100 });
    await expect(limited.prices([MINT])).rejects.toThrow(/HTTP 429/);
    expect(sleeps).toEqual([500, 1000]);
  });
});
