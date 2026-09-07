import { fixedClock, toInstant, type MintAddress } from '@sol-agent-trader/contracts';
import { base58Decode } from '../base58.js';
import { RpcError, SolanaRpcClient, type RpcTransport } from '../rpc/client.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './decode.js';
import { MintNotFoundError, readMintChainState } from './read.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const AUTH = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const T0 = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const ALLOW = ['https://rpc.example.test'];

function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (8n * i)) & 0xffn));
  return out;
}
const splMintB64 = (freeze: string | null, supply: bigint) =>
  Buffer.from([...u32le(0), ...new Array(32).fill(0), ...u64le(supply), 6, 1, ...u32le(freeze ? 1 : 0), ...(freeze ? [...base58Decode(freeze)] : new Array(32).fill(0))]).toString('base64');

function rpc(handlers: Record<string, (params: unknown[]) => unknown>): { client: SolanaRpcClient; calls: string[] } {
  const calls: string[] = [];
  const transport: RpcTransport = async (req) => {
    const { id, method, params } = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
    calls.push(method);
    const h = handlers[method];
    if (!h) return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) };
    const result = h(params);
    return { status: 200, body: JSON.stringify(result instanceof Error ? { jsonrpc: '2.0', id, error: { code: -32000, message: result.message } } : { jsonrpc: '2.0', id, result }) };
  };
  return { client: new SolanaRpcClient({ url: 'https://rpc.example.test/', allowedOrigins: ALLOW, transport }), calls };
}

describe('SolanaRpcClient (read-only, allowlisted)', () => {
  it('refuses an endpoint outside the allowlist at construction', () => {
    expect(() => new SolanaRpcClient({ url: 'https://evil.example/rpc', allowedOrigins: ALLOW, transport: async () => ({ status: 200, body: '' }) })).toThrow(/allowlist/);
  });

  it('paces to the configured rate and retries 429/5xx with backoff before giving up', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new SolanaRpcClient({
      url: 'https://rpc.example.test',
      allowedOrigins: ALLOW,
      requestsPerSecond: 1,
      nowMs: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
      transport: async (req) => {
        calls++;
        const { id } = JSON.parse(req.body) as { id: number };
        return calls < 3 ? { status: 429, body: '' } : { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: 42 }) };
      },
    });
    await expect(client.getSlot()).resolves.toBe(42);
    expect(calls).toBe(3);
    // backoff 1s then 2s, plus one pacing wait per attempt after the first (1 rps, frozen clock)
    expect(sleeps).toEqual([1000, 1000, 2000, 1000]);

    const always429 = new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ALLOW, requestsPerSecond: 100, maxAttempts: 2, sleep: async () => undefined, transport: async () => ({ status: 429, body: '' }) });
    await expect(always429.getSlot()).rejects.toThrow(/HTTP 429/);
  });

  it('surfaces JSON-RPC errors, non-JSON bodies and malformed results as RpcError', async () => {
    const { client } = rpc({ getSlot: () => new Error('node is behind') });
    await expect(client.getSlot()).rejects.toThrow(RpcError);
    const bad = new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ALLOW, transport: async () => ({ status: 200, body: 'nope' }) });
    await expect(bad.getSlot()).rejects.toThrow(/not JSON/);
    const shape = new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ALLOW, transport: async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x' }) }) });
    await expect(shape.getSlot()).rejects.toThrow(/unexpected result shape/);
  });
});

describe('readMintChainState (D45 chain truth)', () => {
  it('reads program, authorities, supply and chain-derived concentration; slot is the minimum seen', async () => {
    const { client, calls } = rpc({
      getAccountInfo: () => ({ context: { slot: 105 }, value: { data: [splMintB64(AUTH, 1_000_000n), 'base64'], owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false } }),
      getTokenSupply: () => ({ context: { slot: 103 }, value: { amount: '1000000', decimals: 6 } }),
      getTokenLargestAccounts: () => ({
        context: { slot: 104 },
        value: [
          { address: AUTH, amount: '400000', decimals: 6 },
          { address: TOKEN_PROGRAM_ID, amount: '100000', decimals: 6 },
          { address: TOKEN_2022_PROGRAM_ID, amount: '50000', decimals: 6 },
        ],
      }),
    });
    const s = await readMintChainState(client, MINT, fixedClock(T0));
    expect(calls).toEqual(['getAccountInfo', 'getTokenSupply', 'getTokenLargestAccounts']);
    expect(s).toMatchObject({ mintAddress: MINT, readAt: T0, slot: 103, tokenProgram: 'TOKEN', mintAuthority: 'NONE', freezeAuthority: 'PRESENT', supply: '1000000', decimals: 6, extensions: [] });
    expect(s.concentration).toEqual({ source: 'CHAIN', chainSlot: 103, top1: 0.4, top5: 0.55, top10: 0.55, top20: 0.55, analyticsMismatch: false });
    expect(s.largestAccounts).toHaveLength(3);
  });

  it('an unknown owner program is reported as UNKNOWN, a missing account throws, zero supply gives zero fractions', async () => {
    const { client } = rpc({
      getAccountInfo: () => ({ context: { slot: 1 }, value: { data: [splMintB64(null, 0n), 'base64'], owner: AUTH, lamports: 1, executable: false } }),
      getTokenSupply: () => ({ context: { slot: 1 }, value: { amount: '0', decimals: 6 } }),
      getTokenLargestAccounts: () => ({ context: { slot: 1 }, value: [] }),
    });
    const s = await readMintChainState(client, MINT, fixedClock(T0));
    expect(s.tokenProgram).toBe('UNKNOWN');
    expect(s.concentration.top10).toBe(0);
    const missing = rpc({ getAccountInfo: () => ({ context: { slot: 1 }, value: null }) });
    await expect(readMintChainState(missing.client, MINT, fixedClock(T0))).rejects.toThrow(MintNotFoundError);
  });
});
