import type { RpcTransport } from '@sol-agent-trader/solana-hard-state';
import { RpcTransactionSubmitter, SubmitError } from './submit.js';

describe('direct RPC transaction submitter (§14.6 step 7, D33)', () => {
  it('refuses an endpoint off the allowlist, reads the blockhash at confirmed commitment and sends with preflight disabled', async () => {
    expect(() => new RpcTransactionSubmitter({ url: 'https://evil.example/rpc', allowedOrigins: ['https://rpc.example'], label: 'primary' })).toThrow(/allowlist/);
    const calls: { method: string; params: unknown[] }[] = [];
    const transport: RpcTransport = async (req) => {
      const body = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params });
      if (body.method === 'getLatestBlockhash') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 10 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1234 } } }) };
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' }) };
    };
    const s = new RpcTransactionSubmitter({ url: 'https://rpc.example/rpc', allowedOrigins: ['https://rpc.example'], label: 'primary', transport });
    expect(await s.latestBlockhash()).toEqual({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1234 });
    expect(await s.send('dHg=')).toBe('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW');
    expect(calls[0]).toMatchObject({ method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] });
    expect(calls[1]).toMatchObject({ method: 'sendTransaction', params: ['dHg=', { encoding: 'base64', skipPreflight: true }] });
    // a node error is surfaced with its code, never swallowed into a fake signature
    const failing = new RpcTransactionSubmitter({ url: 'https://rpc.example/rpc', allowedOrigins: ['https://rpc.example'], label: 'primary', transport: async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Blockhash not found' } }) }) });
    await expect(failing.send('dHg=')).rejects.toThrow(SubmitError);
    await expect(failing.send('dHg=')).rejects.toThrow(/Blockhash not found/);
  });
});
