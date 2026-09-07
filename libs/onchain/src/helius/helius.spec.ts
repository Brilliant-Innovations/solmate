import { fixedClock, toInstant, type TxSignature } from '@sol-agent-trader/contracts';
import { HeliusClient, HeliusError, type HeliusTransport } from './client.js';
import { parseHeliusTransaction, parseHeliusWebhookPayload } from './parse.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
const SIG2 = '4EWYrAvnHDA4ZgNGUgqdGsJ5DNKk4bT5hyGTLnRGT3GStpDDNXEWNq9vEaSZmiqPHJ5j6zDAZ3G1XFRa7wDbBqyz' as TxSignature;
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ATA = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';

const parsedEventsItem = {
  signature: SIG,
  parserStatus: 'OK',
  parsed: {
    slot: 300_000_000,
    blockTime: 1_788_000_000,
    fee: 5000,
    feePayer: WALLET,
    transactionStatus: 'OK',
    error: null,
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 1_000_000 }],
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, fromTokenAccount: OTHER, toTokenAccount: ATA, rawTokenAmount: '2500000', decimals: 6, mint: USDC, tokenStandard: 'Fungible' }],
    accountData: [{ account: WALLET, nativeBalanceChange: -1_005_000, tokenBalanceChanges: [] }],
    summary: { type: 'swap', description: 'x swapped', parsedData: {} },
    instructions: [],
  },
};

describe('Helius Parsed Events adapter (§3.2, D9)', () => {
  it('turns a parsed-events item into provider-neutral facts with raw integer amounts', () => {
    const r = parseHeliusTransaction(parsedEventsItem);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toMatchObject({ signature: SIG, slot: 300_000_000, feeLamports: '5000', feePayer: WALLET, failed: false, blockTime: '2026-08-29T10:40:00.000Z' });
    expect(r.facts.nativeBalanceChanges).toEqual([{ account: WALLET, lamports: '-1005000' }]);
    expect(r.facts.movements).toHaveLength(2);
    expect(r.facts.movements[0]).toMatchObject({ kind: 'SOL', mint: null, fromOwner: WALLET, toOwner: OTHER, amount: '1000000', decimals: 9, index: 0, summaryType: 'swap' });
    expect(r.facts.movements[1]).toMatchObject({ kind: 'TOKEN', mint: USDC, toOwner: WALLET, toTokenAccount: ATA, amount: '2500000', decimals: 6, index: 1 });
  });

  it('accepts the legacy enhanced shape (decimal tokenAmount, timestamp, type) without floating-point drift', () => {
    const legacy = { signature: SIG2, slot: 1, timestamp: 1_788_000_000, fee: 5000, feePayer: WALLET, type: 'TRANSFER', transactionError: null, nativeTransfers: [], tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, fromTokenAccount: ATA, toTokenAccount: OTHER, tokenAmount: 0.1 + 0.2, mint: USDC, decimals: 6 }] };
    const r = parseHeliusTransaction(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.movements[0]).toMatchObject({ amount: '300000', decimals: 6, summaryType: 'TRANSFER' });
  });

  it('reports parser errors and malformed items instead of guessing; failed transactions are flagged', () => {
    expect(parseHeliusTransaction({ signature: SIG, parserStatus: 'ERROR', parsed: null })).toEqual({ ok: false, signature: SIG, reason: 'PARSER_ERROR' });
    expect(parseHeliusTransaction({ signature: SIG, parserStatus: 'OK', parsed: { slot: 1, tokenTransfers: [{ mint: USDC }] } })).toEqual({ ok: false, signature: SIG, reason: 'MALFORMED' });
    expect(parseHeliusTransaction('junk')).toMatchObject({ ok: false, reason: 'MALFORMED' });
    const failed = parseHeliusTransaction({ ...parsedEventsItem, parsed: { ...parsedEventsItem.parsed, transactionStatus: 'ERROR', error: 'InstructionError' } });
    expect(failed.ok && failed.facts.failed).toBe(true);
    expect(parseHeliusWebhookPayload([parsedEventsItem, 'x'])).toHaveLength(2);
    expect(parseHeliusWebhookPayload({ not: 'array' })).toEqual([]);
  });

  it('the client sends the key only as a query parameter, chunks requests, returns results in input order and never echoes the key in errors', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const transport: HeliusTransport = async (req) => {
      calls.push({ url: req.url, body: JSON.parse(req.body) });
      const sigs = (JSON.parse(req.body) as { transactions: string[] }).transactions;
      // Return out of order and drop the last one to prove alignment.
      return { status: 200, body: JSON.stringify(sigs.slice(0, -1).reverse().map((s) => ({ ...parsedEventsItem, signature: s }))) };
    };
    const client = new HeliusClient({ apiKey: 'secret-key-value', clock: fixedClock(NOW), transport, sleep: async () => undefined, requestsPerSecond: 1000 });
    const sigs = Array.from({ length: 101 }, (_, i) => `${SIG.slice(0, -3)}${String(i).padStart(3, '1')}` as TxSignature);
    const out = await client.parseTransactions(sigs);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://mainnet.helius-rpc.com/v1/parsed-events/transactions?api-key=secret-key-value');
    expect(calls[0]!.body).toEqual({ transactions: sigs.slice(0, 100), commitment: 'confirmed' });
    expect(out).toHaveLength(101);
    expect(out.map((o) => o.ok)).toEqual([...Array(99).fill(true), false, false]);
    expect(out[0]!.ok && out[0]!.facts.signature).toBe(sigs[0]);

    const failing: HeliusTransport = async () => {
      throw new Error('connect https://mainnet.helius-rpc.com/x?api-key=secret-key-value refused');
    };
    const c2 = new HeliusClient({ apiKey: 'secret-key-value', clock: fixedClock(NOW), transport: failing, sleep: async () => undefined, requestsPerSecond: 1000, maxAttempts: 1 });
    await expect(c2.parseTransactions([SIG])).rejects.toThrow(HeliusError);
    await expect(c2.parseTransactions([SIG])).rejects.not.toThrow(/secret-key-value/);
    const denied: HeliusTransport = async () => ({ status: 401, body: '' });
    const c3 = new HeliusClient({ apiKey: 'k', clock: fixedClock(NOW), transport: denied, sleep: async () => undefined, requestsPerSecond: 1000 });
    await expect(c3.parseTransactions([SIG])).rejects.toThrow(/authentication rejected/);
  });
});
