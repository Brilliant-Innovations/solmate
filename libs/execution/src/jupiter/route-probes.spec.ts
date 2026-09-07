import { DEFAULT_ELIGIBILITY_POLICY, toInstant, type Bps, type JupiterQuoteClient, type MintAddress, type Quote, type QuoteOptions, type QuoteRequest, type QuoteRoutePlan, type Uuid } from '@sol-agent-trader/contracts';
import { NoRouteError } from './quote-client.js';
import { buildEmergencySnapshot, discoverEmergencyRoute, runRouteProbes, tokenAmountForUsd } from './route-probes.js';

const T0 = toInstant(Date.UTC(2026, 8, 7, 15, 0, 0));
const TOKEN = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress;
const USDC = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
const SOL = DEFAULT_ELIGIBILITY_POLICY.settlementMints[1] as MintAddress;
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const target = { mintAddress: TOKEN, decimals: 6, priceUsd: 0.5 };

type Handler = (req: QuoteRequest, options?: QuoteOptions) => { impactBps: number; hops?: { ammKey: string; label: string; programId: string | null }[] } | NoRouteError;

/** A scripted quote client: the handler decides route/impact per request. */
function fakeClient(handler: Handler): JupiterQuoteClient & { calls: { req: QuoteRequest; options?: QuoteOptions }[] } {
  const calls: { req: QuoteRequest; options?: QuoteOptions }[] = [];
  const quote = async (req: QuoteRequest, options?: QuoteOptions) => {
    calls.push({ req, options });
    const r = handler(req, options);
    if (r instanceof NoRouteError) throw r;
    const hops = (r.hops ?? [{ ammKey: 'aggregatorPool11111111111111111111111111111', label: 'Quantum', programId: null }]).map((h) => ({ ...h, inputMint: req.inputMint, outputMint: req.outputMint, inputAmount: req.inputAmount, outputAmount: req.inputAmount, percent: 100 }));
    const q: Quote = { provider: 'JUPITER', providerRequestId: null, routerLabel: hops.map((h) => h.label).join('>'), inputMint: req.inputMint, outputMint: req.outputMint, inputAmount: req.inputAmount, expectedOutputAmount: String(Math.floor(Number(req.inputAmount) * 0.99)) as never, minOutputAmount: req.inputAmount, priceImpactBps: r.impactBps as Bps, slippageBps: 50 as Bps, routeProgramIds: hops.map((h) => h.programId).filter((p): p is string => p !== null) as never, usesAddressLookupTables: false, quotedAt: T0, expiresAt: null, lastValidBlockHeight: null };
    const route: QuoteRoutePlan = { hops: hops as never, contextSlot: 445_000_000 as never, providerImpactPct: null };
    return { quote: q, route };
  };
  return { calls, quote, buildOrder: async (req) => ({ quote: (await quote(req)).quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] }) };
}

describe('route probes (§7.2 impact at standard sizes, exit route back to settlement)', () => {
  it('sizes token amounts from price and decimals', () => {
    expect(tokenAmountForUsd(250, target)).toBe('500000000'); // 500 tokens at 6 decimals
    expect(tokenAmountForUsd(1, { ...target, priceUsd: 1e-9 })).toBe('1000000000000000');
  });

  it('buys at every size, then confirms the sell route at the largest routed size; impact rises with size', async () => {
    const client = fakeClient((req) => ({ impactBps: req.inputMint === USDC ? Math.round(Number(req.inputAmount) / 100_000_000) : 5 }));
    const out = await runRouteProbes(client, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(out.probes.map((p) => [p.sizeUsd, p.impactBps, p.routeFound])).toEqual([[250, 3, true], [1000, 10, true], [5000, 50, true]]);
    expect(out.settlementRouteConfirmed).toBe(true);
    expect(out.settlementMint).toBe(USDC);
    const sell = client.calls.at(-1)!.req;
    expect(sell.inputMint).toBe(TOKEN);
    expect(sell.inputAmount).toBe(tokenAmountForUsd(5000, target));
    expect(out.errors).toEqual([]);
  });

  it('a size with no route is recorded as routeFound=false; sell falls back to SOL; no sell route → not confirmed', async () => {
    const client = fakeClient((req) => (req.inputMint === USDC && Number(req.inputAmount) >= 5_000_000_000 ? new NoRouteError('COULD_NOT_FIND_ANY_ROUTE', 'x') : req.outputMint === USDC && req.inputMint === TOKEN ? new NoRouteError('COULD_NOT_FIND_ANY_ROUTE', 'x') : { impactBps: 1 }));
    const out = await runRouteProbes(client, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(out.probes.map((p) => p.routeFound)).toEqual([true, true, false]);
    expect(out.settlementRouteConfirmed).toBe(true);
    expect(out.settlementMint).toBe(SOL);
    const none = fakeClient((req) => (req.inputMint === TOKEN ? new NoRouteError('COULD_NOT_FIND_ANY_ROUTE', 'x') : { impactBps: 1 }));
    const out2 = await runRouteProbes(none, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(out2.settlementRouteConfirmed).toBe(false);
    expect(out2.settlementMint).toBeNull();
  });

  it('a transport/provider failure aborts with an error instead of pretending a route is absent', async () => {
    const client = fakeClient(() => {
      throw new Error('HTTP 503');
    });
    const out = await runRouteProbes(client, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(out.errors[0]).toMatch(/HTTP 503/);
    expect(out.settlementRouteConfirmed).toBe(false);
  });
});

describe('emergency exit route discovery (§14.6, D45)', () => {
  it('finds a single-hop direct-pool route, quotes capacity through the same pool, and assembles the snapshot', async () => {
    const client = fakeClient((req, options) => {
      expect(options?.onlyDirectRoutes).toBe(true);
      expect(options?.dexes).toContain('Raydium CLMM');
      return { impactBps: Number(req.inputAmount) > 5_000_000_000 ? 80 : 20, hops: [{ ammKey: POOL, label: 'Raydium CLMM', programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' }] };
    });
    const route = await discoverEmergencyRoute(client, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(route).toMatchObject({ program: 'RAYDIUM_CLMM', programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', poolAddress: POOL, settlementMint: USDC, contextSlot: 445_000_000 });
    expect(route?.capacity.map((c) => c.impactBps)).toEqual([20, 20, 80]);
    const snapshot = buildEmergencySnapshot({ id: '33333333-3333-4333-8333-333333333333' as Uuid, assetId: '22222222-2222-4222-8222-222222222222' as Uuid, mintAddress: TOKEN, route: route!, poolStateRef: 'CAMM…:abc', verifiedAtSlot: 445_000_010 as never, token2022Compatible: true, now: T0 });
    expect(snapshot.hops).toEqual([{ program: 'RAYDIUM_CLMM', programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', poolAddress: POOL, inputMint: TOKEN, outputMint: USDC }]);
    expect(snapshot.lastDryRun).toBeNull();
    expect(snapshot.capacity).toHaveLength(3);
  });

  it('a route through an unmodelled venue, a multi-hop route, or no direct route yields null; capacity ignores sizes that switch pools', async () => {
    const unknownVenue = fakeClient(() => ({ impactBps: 1, hops: [{ ammKey: POOL, label: 'Quantum', programId: null }] }));
    expect(await discoverEmergencyRoute(unknownVenue, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0)).toBeNull();
    const none = fakeClient(() => new NoRouteError('COULD_NOT_FIND_ANY_ROUTE', 'x'));
    expect(await discoverEmergencyRoute(none, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0)).toBeNull();
    const switching = fakeClient((req) => ({ impactBps: 1, hops: [{ ammKey: Number(req.inputAmount) > 5_000_000_000 ? 'otherPool1111111111111111111111111111111111' : POOL, label: 'Whirlpool', programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }] }));
    const r = await discoverEmergencyRoute(switching, target, DEFAULT_ELIGIBILITY_POLICY, 'mainnet-beta', T0);
    expect(r?.program).toBe('ORCA_WHIRLPOOL');
    expect(r?.capacity).toHaveLength(2);
  });
});
