import type { RpcTransport } from '@sol-agent-trader/solana-hard-state';
import { SimulationRpcClient, SimulationRpcError } from './client.js';

describe('independent simulation rpc client (§15.4 step 5)', () => {
  it('refuses an endpoint off the allowlist, simulates with signature verification off and returns post-state for the requested accounts', async () => {
    expect(() => new SimulationRpcClient({ url: 'https://evil.example/rpc', allowedOrigins: ['https://sim.example'], label: 'sim' })).toThrow(/allowlist/);
    const calls: { method: string; params: unknown[] }[] = [];
    const transport: RpcTransport = async (req) => {
      const body = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params });
      if (body.method === 'simulateTransaction') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 77 }, value: { err: null, logs: ['Program log: ok'], unitsConsumed: 1234, accounts: [{ data: ['AAAA', 'base64'], owner: 'Tok', lamports: 5, executable: false }, null] } } }) };
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 76 }, value: [null, { data: ['BBBB', 'base64'], owner: 'Tok', lamports: 6, executable: false }] } }) };
    };
    const client = new SimulationRpcClient({ url: 'https://sim.example/rpc', allowedOrigins: ['https://sim.example'], label: 'sim', transport });
    const sim = await client.simulate('dHg=', ['A1', 'A2']);
    expect(sim).toEqual({ slot: 77, err: null, logs: ['Program log: ok'], unitsConsumed: 1234, accounts: [{ address: 'A1', lamports: 5, owner: 'Tok', dataBase64: 'AAAA' }, null] });
    expect(calls[0]).toMatchObject({ method: 'simulateTransaction', params: ['dHg=', { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', accounts: { encoding: 'base64', addresses: ['A1', 'A2'] } }] });
    const pre = await client.accounts(['A1', 'A2']);
    expect(pre.accounts).toEqual([null, { address: 'A2', lamports: 6, owner: 'Tok', dataBase64: 'BBBB' }]);
    const failing = new SimulationRpcClient({ url: 'https://sim.example/rpc', allowedOrigins: ['https://sim.example'], label: 'sim', transport: async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }) }) });
    await expect(failing.simulate('dHg=', [])).rejects.toThrow(SimulationRpcError);
  });
});
