import { DEFAULT_SAFETY_POLICY, fixedClock, toInstant, type Bps, type EmergencyExitRouteSnapshot, type HeldAssetSafety, type JupiterQuoteClient, type MintAddress, type PositionSafetyState, type Quote, type QuoteRequest, type SafetyBaseline, type Uuid } from '@sol-agent-trader/contracts';
import { NoRouteError } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { BIRDEYE_TIERS, BirdeyeClient, type HttpResponse, type HttpTransport } from '@sol-agent-trader/market';
import { base58Decode, SolanaRpcClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type RpcTransport } from '@sol-agent-trader/solana-hard-state';
import { runHeldAssetSafetyCycle, type SafetyRepo } from './held-asset-safety.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 16, 0, 0));
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const AUTH = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const POSITION = '44444444-4444-4444-8444-444444444444' as Uuid;
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;

function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (8n * i)) & 0xffn));
  return out;
}
/** SPL mint, optionally as a Token-2022 mint carrying a Pausable extension in the paused state. */
function mintB64(opts: { freeze?: string | null; paused?: boolean } = {}): string {
  const base = [...u32le(0), ...new Array(32).fill(0), ...u64le(1_000_000_000n), 6, 1, ...u32le(opts.freeze ? 1 : 0), ...(opts.freeze ? [...base58Decode(opts.freeze)] : new Array(32).fill(0))];
  if (!opts.paused) return Buffer.from(base).toString('base64');
  const padded = [...base, ...new Array(165 - base.length).fill(0), 1, 26, 0, 33, 0, ...base58Decode(AUTH), 1];
  return Buffer.from(padded).toString('base64');
}

function rpcFor(opts: { freeze?: string | null; paused?: boolean; poolOwner?: string | null } = {}): SolanaRpcClient {
  const transport: RpcTransport = async (req) => {
    const { id, method, params } = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
    let result: unknown;
    if (method === 'getAccountInfo' && params[0] === POOL) result = { context: { slot: 601 }, value: opts.poolOwner === null ? null : { data: ['AAECAw==', 'base64'], owner: opts.poolOwner ?? DLMM, lamports: 1, executable: false } };
    else if (method === 'getAccountInfo') result = { context: { slot: 600 }, value: { data: [mintB64(opts), 'base64'], owner: opts.paused ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, lamports: 1, executable: false } };
    else if (method === 'getTokenSupply') result = { context: { slot: 600 }, value: { amount: '1000000000', decimals: 6 } };
    else result = { context: { slot: 600 }, value: [{ address: AUTH, amount: '200000000', decimals: 6 }] };
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
  };
  return new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport, requestsPerSecond: 1000 });
}

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(json) });
function birdeyeFor(liquidity: number | null): BirdeyeClient {
  const transport: HttpTransport = async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/defi/token_security') return ok({ success: true, data: { freezeable: false, isToken2022: false, fakeToken: false } });
    if (path === '/defi/token_overview') return ok({ success: true, data: { address: MINT, price: 2, liquidity, lastTradeUnixTime: 1_788_000_000 } });
    throw new Error('unscripted');
  };
  return new BirdeyeClient({ apiKey: 'k', tier: BIRDEYE_TIERS.LITE, transport, clock: fixedClock(NOW), sleep: async () => undefined });
}

function jupiterFor(mode: 'routes' | 'no-route' | 'heavy-impact'): JupiterQuoteClient {
  const quote = async (req: QuoteRequest) => {
    if (mode === 'no-route') throw new NoRouteError('NO_ROUTES_FOUND', 'x');
    const q: Quote = { provider: 'JUPITER', providerRequestId: null, routerLabel: 'x', inputMint: req.inputMint, outputMint: req.outputMint, inputAmount: req.inputAmount, expectedOutputAmount: req.inputAmount, minOutputAmount: req.inputAmount, priceImpactBps: (mode === 'heavy-impact' ? 900 : 30) as Bps, slippageBps: 50 as Bps, routeProgramIds: [], usesAddressLookupTables: false, quotedAt: NOW, expiresAt: null, lastValidBlockHeight: null };
    return { quote: q, route: { hops: [], contextSlot: null, providerImpactPct: null } };
  };
  return { quote, buildOrder: async (req) => ({ quote: (await quote(req)).quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] }) };
}

const SNAPSHOT: EmergencyExitRouteSnapshot = {
  id: '55555555-5555-4555-8555-555555555555' as Uuid, assetId: ASSET, hops: [{ program: 'METEORA_DLMM', programId: DLMM as never, poolAddress: POOL as never, inputMint: MINT, outputMint: USDC }], settlementMint: USDC,
  poolStateRef: 'x', lastRefreshedAt: NOW, lastRefreshSlot: 599 as never, capacity: [], token2022Compatible: true, lastDryRun: null,
};

class MemoryRepo implements SafetyRepo {
  evaluations: HeldAssetSafety[] = [];
  constructor(
    private readonly snapshot: EmergencyExitRouteSnapshot | null,
    private readonly entry: { liquidityUsd: number | null; freezeAuthorityPresent: boolean; transferHook: boolean; permanentDelegate: boolean; transferFeeBps: Bps | null; top10: number | null } | null = { liquidityUsd: 100_000, freezeAuthorityPresent: false, transferHook: false, permanentDelegate: false, transferFeeBps: null, top10: 0.2 },
    private readonly initialState: PositionSafetyState = 'NORMAL',
  ) {}
  async listOpenPositions() {
    return [{ id: POSITION, assetId: ASSET, mint: MINT, quantity: '5000000' as never, safetyState: this.initialState }];
  }
  async previousSafetyBaseline(): Promise<{ baseline: SafetyBaseline; state: PositionSafetyState; evaluatedAt: typeof NOW } | null> {
    const last = this.evaluations.at(-1);
    return last ? { baseline: { source: 'PREVIOUS_SAFETY', ...last.observed }, state: last.state, evaluatedAt: last.evaluatedAt } : null;
  }
  async latestEligibilityBaseline() {
    return this.entry;
  }
  async latestEmergencySnapshot() {
    return this.snapshot;
  }
  async recordPositionSafety(e: HeldAssetSafety) {
    this.evaluations.push(e);
  }
}

const deps = (repo: MemoryRepo, rpc: SolanaRpcClient, birdeye: BirdeyeClient, jupiter: JupiterQuoteClient | null) => ({
  rpc, birdeye, jupiter, repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), policy: DEFAULT_SAFETY_POLICY, cluster: 'mainnet-beta' as const, settlementMint: USDC, config: { batchSize: 50 },
});

describe('held-asset-safety role (§7.5, D34)', () => {
  it('a healthy held asset with both exit paths stays NORMAL; the entry record seeds the baseline', async () => {
    const repo = new MemoryRepo(SNAPSHOT);
    const report = await runHeldAssetSafetyCycle(deps(repo, rpcFor(), birdeyeFor(100_000), jupiterFor('routes')));
    expect(report).toMatchObject({ positions: 1, evaluated: 1, states: { NORMAL: 1, DEGRADED: 0, EXIT_RECOMMENDED: 0, CRITICAL_EXIT: 0 }, errors: [] });
    const e = repo.evaluations[0]!;
    expect(e.baseline.source).toBe('ENTRY_ELIGIBILITY');
    expect(e.exitCompatibility).toMatchObject({ primaryRouteAvailable: true, primaryImpactBps: 30, emergencyRouteAvailable: true, canReduceNow: true });
    expect(e.reasons).toEqual([]);
    // The sell probe sized the whole position: 5 tokens at $2.
    expect(e.exitCompatibility.primaryImpactBps).toBe(30);
  });

  it('liquidity collapse since entry is EXIT_RECOMMENDED; the next cycle carries the new baseline forward', async () => {
    const repo = new MemoryRepo(SNAPSHOT);
    await runHeldAssetSafetyCycle(deps(repo, rpcFor(), birdeyeFor(10_000), jupiterFor('routes')));
    expect(repo.evaluations[0]!.state).toBe('EXIT_RECOMMENDED');
    expect(repo.evaluations[0]!.reasons).toContain('LIQUIDITY_COLLAPSE');
    await runHeldAssetSafetyCycle(deps(repo, rpcFor(), birdeyeFor(10_000), jupiterFor('routes')));
    expect(repo.evaluations[1]!.baseline).toMatchObject({ source: 'PREVIOUS_SAFETY', liquidityUsd: 10_000 });
    expect(repo.evaluations[1]!.state).toBe('NORMAL');
    expect(repo.evaluations[1]!.previousState).toBe('EXIT_RECOMMENDED');
  });

  it('a paused Token-2022 mint is CRITICAL_EXIT even though a sell route exists; no route anywhere is CRITICAL_EXIT too', async () => {
    const repo = new MemoryRepo(SNAPSHOT);
    await runHeldAssetSafetyCycle(deps(repo, rpcFor({ paused: true }), birdeyeFor(100_000), jupiterFor('routes')));
    expect(repo.evaluations[0]!.state).toBe('CRITICAL_EXIT');
    expect(repo.evaluations[0]!.reasons).toContain('MINT_PAUSED');
    const repo2 = new MemoryRepo(null);
    await runHeldAssetSafetyCycle(deps(repo2, rpcFor(), birdeyeFor(100_000), jupiterFor('no-route')));
    expect(repo2.evaluations[0]!.state).toBe('CRITICAL_EXIT');
    expect(repo2.evaluations[0]!.reasons).toEqual(expect.arrayContaining(['NO_EXIT_PATH', 'EMERGENCY_ROUTE_MISSING']));
    expect(repo2.evaluations[0]!.exitCompatibility.canReduceNow).toBe(false);
  });

  it('a heavy sell impact is EXIT_RECOMMENDED; an emergency pool whose owner changed is DEGRADED with the primary route still usable', async () => {
    const repo = new MemoryRepo(SNAPSHOT);
    await runHeldAssetSafetyCycle(deps(repo, rpcFor(), birdeyeFor(100_000), jupiterFor('heavy-impact')));
    expect(repo.evaluations[0]!.state).toBe('EXIT_RECOMMENDED');
    expect(repo.evaluations[0]!.reasons).toContain('SELL_IMPACT_ABOVE_MAX');
    const repo2 = new MemoryRepo(SNAPSHOT);
    await runHeldAssetSafetyCycle(deps(repo2, rpcFor({ poolOwner: AUTH }), birdeyeFor(100_000), jupiterFor('routes')));
    expect(repo2.evaluations[0]!.state).toBe('DEGRADED');
    expect(repo2.evaluations[0]!.reasons).toContain('EMERGENCY_POOL_CHANGED');
    expect(repo2.evaluations[0]!.exitCompatibility).toMatchObject({ primaryRouteAvailable: true, emergencyRouteAvailable: false, canReduceNow: true });
  });

  it('without a quote client the primary route is unknown: the emergency route alone still keeps canReduceNow true', async () => {
    const repo = new MemoryRepo(SNAPSHOT);
    await runHeldAssetSafetyCycle(deps(repo, rpcFor(), birdeyeFor(100_000), null));
    const e = repo.evaluations[0]!;
    expect(e.exitCompatibility).toMatchObject({ primaryRouteAvailable: false, emergencyRouteAvailable: true, canReduceNow: true });
    expect(e.state).toBe('EXIT_RECOMMENDED');
    expect(e.reasons).toContain('NO_PRIMARY_EXIT_ROUTE');
  });
});
