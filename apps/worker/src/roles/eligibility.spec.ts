import { DEFAULT_ELIGIBILITY_POLICY, fixedClock, toInstant, type AssetEligibility, type AssetStatus, type Bps, type EmergencyExitRouteSnapshot, type FeedHealth, type JupiterQuoteClient, type Quote, type QuoteOptions, type QuoteRequest, type QuoteRoutePlan, type Uuid } from '@sol-agent-trader/contracts';
import { NoRouteError } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { BIRDEYE_TIERS, BirdeyeClient, defaultFreshnessContracts, type HttpResponse, type HttpTransport } from '@sol-agent-trader/market';
import { base58Decode, SolanaRpcClient, TOKEN_PROGRAM_ID, type RpcTransport } from '@sol-agent-trader/solana-hard-state';
import { initialEligibilityHealthState, runEligibilityCycle, type EligibilityRepo } from './eligibility.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AUTH = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;

function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (8n * i)) & 0xffn));
  return out;
}
const mintB64 = (freeze: string | null) =>
  Buffer.from([...u32le(0), ...new Array(32).fill(0), ...u64le(1_000_000_000n), 6, 1, ...u32le(freeze ? 1 : 0), ...(freeze ? [...base58Decode(freeze)] : new Array(32).fill(0))]).toString('base64');

function rpcFor(freeze: string | null, poolOwner: string | null = CLMM): SolanaRpcClient {
  const transport: RpcTransport = async (req) => {
    const { id, method, params } = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
    let result: unknown;
    if (method === 'getAccountInfo' && params[0] === POOL) result = { context: { slot: 12 }, value: poolOwner ? { data: ['AAECAw==', 'base64'], owner: poolOwner, lamports: 1, executable: false } : null };
    else if (method === 'getAccountInfo') result = { context: { slot: 10 }, value: { data: [mintB64(freeze), 'base64'], owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false } };
    else if (method === 'getTokenSupply') result = { context: { slot: 10 }, value: { amount: '1000000000', decimals: 6 } };
    else result = { context: { slot: 10 }, value: [{ address: AUTH, amount: '100000000', decimals: 6 }] };
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
  };
  return new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport, requestsPerSecond: 1000 });
}

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(json) });
function birdeyeFor(routes: Record<string, () => HttpResponse>): BirdeyeClient {
  const transport: HttpTransport = async (req) => {
    const r = routes[new URL(req.url).pathname];
    if (!r) throw new Error('unscripted');
    return r();
  };
  return new BirdeyeClient({ apiKey: 'k', tier: BIRDEYE_TIERS.LITE, transport, clock: fixedClock(NOW), sleep: async () => undefined });
}

/** Jupiter fake: every pair routes; direct-route requests go through one Raydium CLMM pool. */
function jupiterFor(behaviour: 'routes' | 'no-sell-route' = 'routes'): JupiterQuoteClient {
  const quote = async (req: QuoteRequest, options?: QuoteOptions) => {
    if (behaviour === 'no-sell-route' && req.inputMint === MINT) throw new NoRouteError('COULD_NOT_FIND_ANY_ROUTE', 'x');
    const direct = options?.onlyDirectRoutes === true;
    const hop = direct ? { ammKey: POOL, label: 'Raydium CLMM', programId: CLMM } : { ammKey: 'aggregatorPool11111111111111111111111111111', label: 'Quantum', programId: null };
    const q: Quote = { provider: 'JUPITER', providerRequestId: null, routerLabel: hop.label, inputMint: req.inputMint, outputMint: req.outputMint, inputAmount: req.inputAmount, expectedOutputAmount: req.inputAmount, minOutputAmount: req.inputAmount, priceImpactBps: 12 as Bps, slippageBps: 50 as Bps, routeProgramIds: (hop.programId ? [hop.programId] : []) as never, usesAddressLookupTables: false, quotedAt: NOW, expiresAt: null, lastValidBlockHeight: null };
    const route: QuoteRoutePlan = { hops: [{ ...hop, inputMint: req.inputMint, outputMint: req.outputMint, inputAmount: req.inputAmount, outputAmount: req.inputAmount, percent: 100 }] as never, contextSlot: 11 as never, providerImpactPct: null };
    return { quote: q, route };
  };
  return { quote, buildOrder: async (req) => ({ quote: (await quote(req)).quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] }) };
}

class MemoryRepo implements EligibilityRepo {
  records: { record: AssetEligibility; status: AssetStatus }[] = [];
  snapshots: EmergencyExitRouteSnapshot[] = [];
  constructor(private readonly due: { id: Uuid; mintAddress: string; status: AssetStatus }[]) {}
  async listAssetsForEvaluation() {
    return this.due;
  }
  async recordEligibility(record: AssetEligibility, status: AssetStatus) {
    this.records.push({ record, status });
  }
  async insertEmergencyRouteSnapshot(s: EmergencyExitRouteSnapshot) {
    this.snapshots.push(s);
  }
}

const SECURITY_OK = () => ok({ success: true, data: { creatorAddress: AUTH, creatorPercentage: 0.01, top10HolderPercent: 0.1, mutableMetadata: false, freezeable: false, isToken2022: false, nonTransferable: false, fakeToken: false, jupStrictList: true, creationTime: 1_700_000_000 } });
const OVERVIEW_OK = () => ok({ success: true, data: { address: MINT, price: 1, liquidity: 1e6, holder: 10_000, v24hUSD: 5e6, lastTradeUnixTime: 1_788_000_000 } });

const deps = (repo: MemoryRepo, rpc: SolanaRpcClient, birdeye: BirdeyeClient, jupiter: JupiterQuoteClient | null) => ({
  rpc, birdeye, jupiter, repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), policy: DEFAULT_ELIGIBILITY_POLICY, cluster: 'mainnet-beta' as const, config: { batchSize: 10, reevaluateAfterMs: 3_600_000, blockedReevaluateAfterMs: 86_400_000 },
});

describe('eligibility role (P2: chain truth first, analytics corroborates, routes proven, fail closed)', () => {
  it('a clean, routable token with a chain-verified direct pool becomes ELIGIBLE with a persisted emergency snapshot', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const report = await runEligibilityCycle(deps(repo, rpcFor(null), birdeyeFor({ '/defi/token_security': SECURITY_OK, '/defi/token_overview': OVERVIEW_OK }), jupiterFor()));
    expect(report).toMatchObject({ considered: 1, evaluated: 1, outcomes: { ELIGIBLE: 1, BLOCKED: 0, EVALUATING: 0 }, snapshots: 1, errors: [] });
    const { record, status } = repo.records[0]!;
    expect(status).toBe('ELIGIBLE');
    expect(record).toMatchObject({ eligible: true, hardReject: false, jupiterRouteAvailable: true, settlementRouteConfirmed: true, grade: 100 });
    expect(record.priceImpactProbes.map((p) => p.sizeUsd)).toEqual(DEFAULT_ELIGIBILITY_POLICY.probeSizesUsd);
    expect(record.emergencyExitRouteSnapshotId).toBe(repo.snapshots[0]!.id);
    expect(repo.snapshots[0]).toMatchObject({ assetId: ASSET, settlementMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0], lastRefreshSlot: 12, token2022Compatible: true });
    expect(repo.snapshots[0]!.hops[0]).toMatchObject({ program: 'RAYDIUM_CLMM', programId: CLMM, poolAddress: POOL });
    expect(repo.snapshots[0]!.poolStateRef.startsWith(`${CLMM}:`)).toBe(true);
  });

  it('without a quote client nothing can be proven: EVALUATING with the route reason, never ELIGIBLE', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    await runEligibilityCycle(deps(repo, rpcFor(null), birdeyeFor({ '/defi/token_security': SECURITY_OK, '/defi/token_overview': OVERVIEW_OK }), null));
    const { record, status } = repo.records[0]!;
    expect(status).toBe('EVALUATING');
    expect(record.rejectionReasons).toEqual(['ROUTE_PROBE_UNAVAILABLE']);
    expect(repo.snapshots).toHaveLength(0);
  });

  it('a token that can be bought but not sold back is BLOCKED on NO_EXIT_ROUTE; a pool whose owner is not the claimed program yields no snapshot', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    await runEligibilityCycle(deps(repo, rpcFor(null), birdeyeFor({ '/defi/token_security': SECURITY_OK, '/defi/token_overview': OVERVIEW_OK }), jupiterFor('no-sell-route')));
    expect(repo.records[0]!.status).toBe('BLOCKED');
    expect(repo.records[0]!.record.rejectionReasons).toContain('NO_EXIT_ROUTE');

    const repo2 = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const report = await runEligibilityCycle(deps(repo2, rpcFor(null, AUTH), birdeyeFor({ '/defi/token_security': SECURITY_OK, '/defi/token_overview': OVERVIEW_OK }), jupiterFor()));
    expect(report.errors.map((e) => e.step)).toEqual(['EMERGENCY_ROUTE']);
    expect(repo2.snapshots).toHaveLength(0);
    expect(repo2.records[0]!.record.emergencyExitRouteSnapshotId).toBeNull();
    expect(repo2.records[0]!.status).toBe('ELIGIBLE'); // the snapshot is a LIVE_AUTO requirement (§14.6), not an entry gate in M4
  });

  it('chain truth blocks regardless of a reassuring analytics report', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    await runEligibilityCycle(deps(repo, rpcFor(AUTH), birdeyeFor({ '/defi/token_security': SECURITY_OK, '/defi/token_overview': OVERVIEW_OK }), jupiterFor()));
    const { record, status } = repo.records[0]!;
    expect(status).toBe('BLOCKED');
    expect(record.rejectionReasons).toContain('FREEZE_AUTHORITY_PRESENT');
    expect(record.freezeAuthority).toBe('PRESENT');
  });

  it('a failing analytics call is recorded and the asset still gets a fail-closed record; a missing mint is a BLOCKED hard reject, never a retried error', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const birdeye = birdeyeFor({ '/defi/token_security': () => ({ status: 500, headers: {}, body: 'boom' }), '/defi/token_overview': OVERVIEW_OK });
    const report = await runEligibilityCycle(deps(repo, rpcFor(null), birdeye, jupiterFor()));
    expect(report.errors.map((e) => e.step)).toEqual(['SECURITY']);
    expect(repo.records[0]?.status).toBe('EVALUATING');
    expect(repo.records[0]?.record.rejectionReasons).toContain('SECURITY_DATA_UNAVAILABLE');

    const missing = new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport: async (req) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(req.body).id, result: { context: { slot: 1 }, value: null } }) }) });
    const repo2 = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const r2 = await runEligibilityCycle(deps(repo2, missing, birdeye, jupiterFor()));
    expect(r2.errors).toEqual([]);
    expect(r2.outcomes.BLOCKED).toBe(1);
    expect(repo2.records).toHaveLength(1);
    expect(repo2.records[0]).toMatchObject({ status: 'BLOCKED', record: { hardReject: true, eligible: false, rejectionReasons: ['MINT_NOT_INITIALIZED'], mintAuthority: 'UNKNOWN', jupiterRouteAvailable: false } });
  });

  it('publishes feed health for security and overview from its own calls: a 401 on security is FAILED and blocks entries, overview stays HEALTHY', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const published = new Map<string, FeedHealth>();
    const health = { contracts: defaultFreshnessContracts().filter((c) => c.dataClass === 'TOKEN_SECURITY' || c.dataClass === 'TOKEN_OVERVIEW'), state: initialEligibilityHealthState(), upsert: async (h: FeedHealth) => void published.set(h.provider, h) };
    const denied = (): HttpResponse => ({ status: 401, headers: {}, body: JSON.stringify({ success: false, message: 'API key lacks sufficient permissions' }) });
    await runEligibilityCycle({ ...deps(repo, rpcFor(null), birdeyeFor({ '/defi/token_security': denied, '/defi/token_overview': OVERVIEW_OK }), null), health });
    expect(published.get('BIRDEYE:TOKEN_SECURITY')).toMatchObject({ state: 'FAILED', effectOnEntries: 'BLOCK', lastError: expect.stringContaining('401') });
    expect(published.get('BIRDEYE:TOKEN_OVERVIEW')).toMatchObject({ state: 'HEALTHY', effectOnEntries: 'NONE', lastSuccessAt: NOW });
    expect(published.size).toBe(2);
  });
});
