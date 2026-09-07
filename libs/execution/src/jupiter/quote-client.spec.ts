import { fixedClock, toInstant, type Bps, type MintAddress, type QuoteRequest } from '@sol-agent-trader/contracts';
import type { JupiterHttpRequest, JupiterHttpResponse, JupiterHttpTransport } from './http.js';
import { JupiterHttpError, JupiterSwapClient, measureImpactBps, NoRouteError } from './quote-client.js';
import { PROBE_TAKER } from './route-probes.js';

/** Fixtures recorded from lite-api.jup.ag/swap/v1/quote on 2026-09-07 (slot 445098987). */
const SOL = 'So11111111111111111111111111111111111111112' as MintAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const T0 = toInstant(Date.UTC(2026, 8, 7, 15, 0, 0));

const recorded = (inAmount: string, outAmount: string, hops: { ammKey: string; label: string }[] = [{ ammKey: 'ugobDeUHRY34mq1yK94eYrepgj2KVmUkHiaV8vyUD42', label: 'Quantum' }]) => ({
  inputMint: SOL,
  inAmount,
  outputMint: USDC,
  outAmount,
  otherAmountThreshold: String(Math.floor(Number(outAmount) * 0.995)),
  swapMode: 'ExactIn',
  slippageBps: 50,
  platformFee: null,
  priceImpactPct: '0.0000166986550703706658091806',
  contextSlot: 445098987,
  timeTaken: 0.0015,
  routePlan: hops.map((h) => ({ swapInfo: { ammKey: h.ammKey, label: h.label, inputMint: SOL, outputMint: USDC, inAmount, outAmount, updateContextSlot: '445098987' }, percent: 100, bps: null })),
});

function scripted(handler: (url: URL) => JupiterHttpResponse | Error) {
  const calls: JupiterHttpRequest[] = [];
  const transport: JupiterHttpTransport = async (req) => {
    calls.push(req);
    const r = handler(new URL(req.url));
    if (r instanceof Error) throw r;
    return r;
  };
  return { transport, calls };
}
const ok = (json: unknown): JupiterHttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(json) });
const request = (inputAmount: string, over: Partial<QuoteRequest> = {}): QuoteRequest => ({ inputMint: SOL, outputMint: USDC, inputAmount: inputAmount as never, maxSlippageBps: 50 as Bps, taker: PROBE_TAKER, cluster: 'mainnet-beta', requestedAt: T0, ...over });

describe('JupiterSwapClient (ADR-0003 shared quote path; quote-only, never signs)', () => {
  it('normalises a recorded quote and measures impact from a 1/100 reference quote instead of trusting priceImpactPct', async () => {
    const { transport, calls } = scripted((url) => {
      const amount = url.searchParams.get('amount');
      return amount === '100000000000' ? ok(recorded('100000000000', '10429191883')) : ok(recorded('1000000000', '104338307'));
    });
    const client = new JupiterSwapClient({ transport, clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100 });
    const { quote, route } = await client.quote(request('100000000000'));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('lite-api.jup.ag/swap/v1/quote');
    expect(calls[0]?.url).toContain('swapMode=ExactIn');
    expect(calls[1]?.url).toContain('amount=1000000000');
    expect(quote).toMatchObject({ provider: 'JUPITER', inputAmount: '100000000000', expectedOutputAmount: '10429191883', minOutputAmount: '10377045923', priceImpactBps: 4, slippageBps: 50, routeProgramIds: [], quotedAt: T0, routerLabel: 'Quantum' });
    expect(route.hops[0]).toMatchObject({ ammKey: 'ugobDeUHRY34mq1yK94eYrepgj2KVmUkHiaV8vyUD42', label: 'Quantum', programId: null, percent: 100 });
    expect(route.contextSlot).toBe(445098987);
    expect(route.providerImpactPct).toBe('0.0000166986550703706658091806');
  });

  it('maps known direct-pool labels to program ids and passes route restrictions through', async () => {
    const { transport, calls } = scripted(() => ok(recorded('1000000000', '104000000', [{ ammKey: 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ', label: 'Raydium CLMM' }])));
    const client = new JupiterSwapClient({ transport, clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100, impactReferenceDivisor: 1 });
    const { quote, route } = await client.quote(request('1000000000'), { onlyDirectRoutes: true, dexes: ['Raydium CLMM', 'Whirlpool'] });
    expect(calls).toHaveLength(1); // divisor 1 → no reference quote
    expect(calls[0]?.url).toContain('onlyDirectRoutes=true');
    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain('dexes=Raydium CLMM,Whirlpool');
    expect(route.hops[0]?.programId).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(quote.routeProgramIds).toEqual(['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK']);
  });

  it('a 400 with a no-route code is NoRouteError; other statuses are JupiterHttpError; 429 is retried', async () => {
    const noRoute = new JupiterSwapClient({ transport: async () => ({ status: 400, headers: {}, body: JSON.stringify({ error: 'The token X is not tradable', errorCode: 'TOKEN_NOT_TRADABLE' }) }), clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100 });
    await expect(noRoute.quote(request('1000'))).rejects.toBeInstanceOf(NoRouteError);
    // Observed live on the restricted direct-route query, 2026-09-07.
    const noRoutes = new JupiterSwapClient({ transport: async () => ({ status: 400, headers: {}, body: JSON.stringify({ error: 'No routes found', errorCode: 'NO_ROUTES_FOUND' }) }), clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100 });
    await expect(noRoutes.quote(request('1000'))).rejects.toBeInstanceOf(NoRouteError);
    const unauthorized = new JupiterSwapClient({ transport: async () => ({ status: 401, headers: {}, body: '{"error":"bad key"}' }), clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100 });
    await expect(unauthorized.quote(request('1000'))).rejects.toBeInstanceOf(JupiterHttpError);
    const sleeps: number[] = [];
    let n = 0;
    const flaky = new JupiterSwapClient({
      transport: async () => (++n === 1 ? { status: 429, headers: {}, body: '' } : ok(recorded('1000', '104'))),
      clock: fixedClock(T0),
      sleep: async (ms) => void sleeps.push(ms),
      requestsPerSecond: 100,
      impactReferenceDivisor: 1,
    });
    await expect(flaky.quote(request('1000'))).resolves.toBeDefined();
    expect(sleeps).toEqual([500]);
  });

  it('sends the API key only as a header and uses the keyed host when present', async () => {
    const { transport, calls } = scripted(() => ok(recorded('1000', '104')));
    const client = new JupiterSwapClient({ transport, clock: fixedClock(T0), apiKey: 'secret-key', sleep: async () => undefined, requestsPerSecond: 100, impactReferenceDivisor: 1 });
    await client.quote(request('1000'));
    expect(calls[0]?.url.startsWith('https://api.jup.ag/')).toBe(true);
    expect(calls[0]?.url).not.toContain('secret-key');
    expect(calls[0]?.headers['x-api-key']).toBe('secret-key');
  });

  it('buildOrder is quote-only in M4: no transaction, no signers', async () => {
    const { transport } = scripted(() => ok(recorded('1000', '104')));
    const client = new JupiterSwapClient({ transport, clock: fixedClock(T0), sleep: async () => undefined, requestsPerSecond: 100, impactReferenceDivisor: 1 });
    const order = await client.buildOrder(request('1000'));
    expect(order).toMatchObject({ transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] });
  });

  it('measureImpactBps: shortfall against the reference rate, clamped to [0, 10000]', () => {
    expect(measureImpactBps({ inAmount: '100000000000', outAmount: '10429191883' }, { inAmount: '1000000000', outAmount: '104338307' })).toBe(4);
    expect(measureImpactBps({ inAmount: '100', outAmount: '50' }, { inAmount: '1', outAmount: '1' })).toBe(5000);
    expect(measureImpactBps({ inAmount: '100', outAmount: '200' }, { inAmount: '1', outAmount: '1' })).toBe(0);
    expect(measureImpactBps({ inAmount: '100', outAmount: '0' }, { inAmount: '1', outAmount: '0' })).toBe(10_000);
  });
});
