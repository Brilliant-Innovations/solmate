import { DEFAULT_ELIGIBILITY_POLICY, fixedClock, toInstant, type AssetEligibility, type AssetStatus, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { BIRDEYE_TIERS, BirdeyeClient, type HttpResponse, type HttpTransport } from '@sol-agent-trader/market';
import { base58Decode, SolanaRpcClient, TOKEN_PROGRAM_ID, type RpcTransport } from '@sol-agent-trader/solana-hard-state';
import { runEligibilityCycle, type EligibilityRepo } from './eligibility.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AUTH = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
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

function rpcFor(freeze: string | null): SolanaRpcClient {
  const transport: RpcTransport = async (req) => {
    const { id, method } = JSON.parse(req.body) as { id: number; method: string };
    const result =
      method === 'getAccountInfo'
        ? { context: { slot: 10 }, value: { data: [mintB64(freeze), 'base64'], owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false } }
        : method === 'getTokenSupply'
          ? { context: { slot: 10 }, value: { amount: '1000000000', decimals: 6 } }
          : { context: { slot: 10 }, value: [{ address: AUTH, amount: '100000000', decimals: 6 }] };
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
  };
  return new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport });
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

class MemoryRepo implements EligibilityRepo {
  records: { record: AssetEligibility; status: AssetStatus }[] = [];
  constructor(private readonly due: { id: Uuid; mintAddress: string; status: AssetStatus }[]) {}
  async listAssetsForEvaluation() {
    return this.due;
  }
  async recordEligibility(record: AssetEligibility, status: AssetStatus) {
    this.records.push({ record, status });
  }
}

const deps = (repo: MemoryRepo, rpc: SolanaRpcClient, birdeye: BirdeyeClient) => ({
  rpc, birdeye, repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), policy: DEFAULT_ELIGIBILITY_POLICY, config: { batchSize: 10, reevaluateAfterMs: 3_600_000 },
});

describe('eligibility role (P2: chain truth first, analytics corroborates, fail closed)', () => {
  it('a clean token without route probes yet lands as EVALUATING with the unavailable reason, chain fields from the RPC read', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const birdeye = birdeyeFor({
      '/defi/token_security': () => ok({ success: true, data: { creatorAddress: AUTH, creatorPercentage: 1, top10HolderPercent: 10, mutableMetadata: false, freezeable: false, isToken2022: false, nonTransferable: false, fakeToken: false, jupStrictList: true, creationTime: 1_700_000_000 } }),
      '/defi/token_overview': () => ok({ success: true, data: { address: MINT, price: 1, liquidity: 1e6, holder: 10_000, v24hUSD: 5e6, lastTradeUnixTime: 1_788_000_000 } }),
    });
    const report = await runEligibilityCycle(deps(repo, rpcFor(null), birdeye));
    expect(report).toMatchObject({ considered: 1, evaluated: 1, outcomes: { ELIGIBLE: 0, BLOCKED: 0, EVALUATING: 1 }, errors: [] });
    const { record, status } = repo.records[0]!;
    expect(status).toBe('EVALUATING');
    expect(record.rejectionReasons).toEqual(['ROUTE_PROBE_UNAVAILABLE']);
    expect(record).toMatchObject({ mintAuthority: 'NONE', freezeAuthority: 'NONE', liquidityUsd: 1e6, holderCount: 10_000, jupiterRouteAvailable: false });
    expect(record.concentration?.top1).toBe(0.1);
    expect(birdeye.ledger.snapshot().used).toBe(25 + 15);
  });

  it('chain truth blocks regardless of a reassuring analytics report', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const birdeye = birdeyeFor({
      '/defi/token_security': () => ok({ success: true, data: { freezeable: false, isToken2022: false, top10HolderPercent: 10, fakeToken: false } }),
      '/defi/token_overview': () => ok({ success: true, data: { address: MINT, liquidity: 1e6 } }),
    });
    await runEligibilityCycle(deps(repo, rpcFor(AUTH), birdeye));
    const { record, status } = repo.records[0]!;
    expect(status).toBe('BLOCKED');
    expect(record.rejectionReasons).toContain('FREEZE_AUTHORITY_PRESENT');
    // analytics said "not freezeable" while chain shows a freeze authority: that is not a mismatch we punish
    // (analytics under-reporting risk is expected); chain truth already blocked.
    expect(record.freezeAuthority).toBe('PRESENT');
  });

  it('a failing analytics call is recorded and the asset still gets a fail-closed record; a missing mint is an error, not a record', async () => {
    const repo = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const birdeye = birdeyeFor({ '/defi/token_security': () => ({ status: 500, headers: {}, body: 'boom' }), '/defi/token_overview': () => ok({ success: true, data: { address: MINT, liquidity: 1e6 } }) });
    const report = await runEligibilityCycle(deps(repo, rpcFor(null), birdeye));
    expect(report.errors.map((e) => e.step)).toEqual(['SECURITY']);
    expect(repo.records[0]?.status).toBe('EVALUATING');
    expect(repo.records[0]?.record.rejectionReasons).toContain('SECURITY_DATA_UNAVAILABLE');

    const missing = new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport: async (req) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(req.body).id, result: { context: { slot: 1 }, value: null } }) }) });
    const repo2 = new MemoryRepo([{ id: ASSET, mintAddress: MINT, status: 'DISCOVERED' }]);
    const r2 = await runEligibilityCycle(deps(repo2, missing, birdeye));
    expect(r2.errors).toEqual([{ assetId: ASSET, step: 'CHAIN', error: 'mint account not found' }]);
    expect(repo2.records).toHaveLength(0);
  });
});
