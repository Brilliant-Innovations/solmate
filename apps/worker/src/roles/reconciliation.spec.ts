import { DEFAULT_RECONCILIATION_POLICY, fixedClock, toInstant, type Amount, type CustodyReconciliation, type Instant, type SolanaAddress, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { HeliusClient, type HeliusTransport } from '@sol-agent-trader/onchain';
import { SolanaRpcClient, TOKEN_PROGRAM_ID, type RpcTransport } from '@sol-agent-trader/solana-hard-state';
import type { CustodyRow, TradingAccountRow } from '@sol-agent-trader/db/server';
import { runReconciliationCycle, type ReconciliationRepo } from './reconciliation.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const ACCOUNT = '22222222-2222-4222-8222-222222222222' as Uuid;
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as SolanaAddress;
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const ATA_USDC = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const ATA_JUP = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
const INTENT = '44444444-4444-4444-8444-444444444444' as Uuid;

interface ChainState {
  sol: number;
  tokens: { pubkey: string; mint: string; amount: string }[];
  signatures: { signature: string; slot: number }[];
  fail?: boolean;
  rpcCalls?: number;
}

function rpcFor(state: ChainState): SolanaRpcClient {
  const transport: RpcTransport = async (req) => {
    const { id, method, params } = JSON.parse(req.body) as { id: number; method: string; params: unknown[] };
    if (state.fail) return { status: 500, body: '' };
    let result: unknown;
    if (method === 'getBalance') result = { context: { slot: 500 }, value: state.sol };
    else if (method === 'getTokenAccountsByOwner') {
      const program = (params[1] as { programId: string }).programId;
      result = { context: { slot: 500 }, value: program === TOKEN_PROGRAM_ID ? state.tokens.map((t) => ({ pubkey: t.pubkey, account: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: { program: 'spl-token', parsed: { type: 'account', info: { mint: t.mint, owner: WALLET, tokenAmount: { amount: t.amount, decimals: 6, uiAmount: 0, uiAmountString: '0' }, state: 'initialized' } } } } })) : [] };
    } else if (method === 'getSignaturesForAddress') {
      const opts = params[1] as { until?: string; before?: string; limit?: number };
      state.rpcCalls = (state.rpcCalls ?? 0) + 1;
      let sigs = [...state.signatures].sort((a, b) => b.slot - a.slot);
      if (opts.until) sigs = sigs.filter((s) => s.signature !== opts.until && s.slot > (state.signatures.find((x) => x.signature === opts.until)?.slot ?? 0));
      if (opts.before) sigs = sigs.filter((s) => s.slot < (state.signatures.find((x) => x.signature === opts.before)?.slot ?? Infinity));
      result = sigs.slice(0, opts.limit ?? 100).map((s) => ({ ...s, blockTime: 1_788_000_000, err: null }));
    } else result = null;
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
  };
  return new SolanaRpcClient({ url: 'https://rpc.example.test', allowedOrigins: ['https://rpc.example.test'], transport, requestsPerSecond: 1000, maxAttempts: 1 });
}

function heliusFor(items: Record<string, unknown>): HeliusClient {
  const transport: HeliusTransport = async (req) => {
    const sigs = (JSON.parse(req.body) as { transactions: string[] }).transactions;
    return { status: 200, body: JSON.stringify(sigs.filter((s) => items[s]).map((s) => items[s])) };
  };
  return new HeliusClient({ apiKey: 'k', clock: fixedClock(NOW), transport, sleep: async () => undefined, requestsPerSecond: 1000 });
}

const parsedTransferIn = { signature: SIG, parserStatus: 'OK', parsed: { slot: 501, blockTime: 1_788_000_000, fee: 5000, feePayer: OTHER, transactionStatus: 'OK', error: null, nativeTransfers: [], tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, fromTokenAccount: OTHER, toTokenAccount: ATA_JUP, rawTokenAmount: '1', decimals: 6, mint: JUP }], accountData: [], summary: { type: 'transfer' } } };

class MemoryRepo implements ReconciliationRepo {
  reports: CustodyReconciliation[] = [];
  owned = new Set<string>();
  cursor: Awaited<ReturnType<ReconciliationRepo['reconciliationCursor']>> = null;
  constructor(
    private readonly custody: CustodyRow[],
    private readonly expectations: { mint: string; expected: string }[],
    private readonly lifecycles: Record<string, { lifecycleId: Uuid; movementType: 'SWAP_V2' }> = {},
  ) {}
  async listTradingAccounts(): Promise<TradingAccountRow[]> {
    return [{ id: ACCOUNT, name: 'paper', cluster: 'mainnet-beta', tradingWallet: WALLET, settlementMint: USDC as never }];
  }
  async listCustodyAccounts() {
    return this.custody;
  }
  async ledgerExpectations() {
    return this.expectations as never;
  }
  async reconciliationCursor() {
    return this.cursor;
  }
  async lifecycleForSignature(signature: TxSignature) {
    return this.lifecycles[signature] ?? null;
  }
  async recordReconciliation(report: CustodyReconciliation) {
    this.reports.push(report);
    if (report.status !== 'UNAVAILABLE') this.cursor = report.cursor;
  }
  async listOwnedAddresses() {
    return [...this.owned].map((address) => ({ address: address as SolanaAddress }));
  }
  async registerOwnedAddress(a: { address: SolanaAddress }) {
    this.owned.add(a.address);
  }
}

const custody = (allowed: 'SWAP_V2'[] = ['SWAP_V2']): CustodyRow[] => [
  { id: 'a0000000-0000-4000-8000-000000000000' as Uuid, address: WALLET, kind: 'TRADING_WALLET', mint: null, allowedMovementTypes: allowed, active: true },
  { id: 'a0000000-0000-4000-8000-000000000001' as Uuid, address: ATA_USDC as SolanaAddress, kind: 'ASSOCIATED_TOKEN_ACCOUNT', mint: USDC as never, allowedMovementTypes: allowed, active: true },
  { id: 'a0000000-0000-4000-8000-000000000002' as Uuid, address: ATA_JUP as SolanaAddress, kind: 'ASSOCIATED_TOKEN_ACCOUNT', mint: JUP as never, allowedMovementTypes: allowed, active: true },
];
const deps = (repo: MemoryRepo, rpc: SolanaRpcClient, helius: HeliusClient | null) => ({ rpc, helius, repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), policy: DEFAULT_RECONCILIATION_POLICY });
const chain = (over: Partial<ChainState> = {}): ChainState => ({ sol: 1_000_000_000, tokens: [{ pubkey: ATA_USDC, mint: USDC, amount: '250000000' }, { pubkey: ATA_JUP, mint: JUP, amount: '5000000' }], signatures: [], ...over });

describe('reconciliation role (D9, D26, §13.6)', () => {
  it('a wallet that matches the ledger with no new signatures is CLEAN; the wallet and custody rows become owned addresses', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }]);
    const r = await runReconciliationCycle(deps(repo, rpcFor(chain()), heliusFor({})));
    expect(r).toMatchObject({ accounts: 1, clean: 1, mismatch: 0, paused: 0, ownedAddresses: 3, errors: [] });
    expect(repo.reports[0]!.status).toBe('CLEAN');
    expect(repo.reports[0]!.cursor.solLamports).toBe('1000000000');
    expect([...repo.owned].sort()).toEqual([WALLET, ATA_USDC, ATA_JUP].sort());
    // Second cycle: nothing new to register.
    const r2 = await runReconciliationCycle(deps(repo, rpcFor(chain()), heliusFor({})));
    expect(r2.ownedAddresses).toBe(0);
  });

  it('an inbound token transfer no lifecycle claims is an UNKNOWN movement: MISMATCH, pause, the movement persisted with its reason', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000001' }]);
    const r = await runReconciliationCycle(deps(repo, rpcFor(chain({ signatures: [{ signature: SIG, slot: 501 }], tokens: [{ pubkey: ATA_USDC, mint: USDC, amount: '250000000' }, { pubkey: ATA_JUP, mint: JUP, amount: '5000001' }] })), heliusFor({ [SIG]: parsedTransferIn })));
    expect(r).toMatchObject({ mismatch: 1, paused: 1 });
    const rep = repo.reports[0]!;
    expect(rep.reasons).toEqual(['UNKNOWN_MOVEMENT']);
    expect(rep.movements[0]).toMatchObject({ signature: SIG, classification: 'UNKNOWN', reason: 'UNREGISTERED_ENDPOINT', mint: JUP, amount: '1' });
    expect(rep.cursor.lastSignature).toBe(SIG);
  });

  it('the same transfer inside an authorized lifecycle between registered custody is EXPECTED and clean', async () => {
    const swap = { ...parsedTransferIn, parsed: { ...parsedTransferIn.parsed, feePayer: WALLET, tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: WALLET, fromTokenAccount: ATA_USDC, toTokenAccount: ATA_JUP, rawTokenAmount: '1', decimals: 6, mint: JUP }] } };
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }], { [SIG]: { lifecycleId: INTENT, movementType: 'SWAP_V2' } });
    repo.cursor = { lastSignature: null, lastSlot: null, solLamports: '1000005000' as Amount };
    // Wait: the ATA_USDC custody row is bound to USDC but the movement is JUP → mint mismatch. Use the JUP ATA on both sides for the lifecycle test.
    const swapSameMint = { ...swap, parsed: { ...swap.parsed, tokenTransfers: [{ ...swap.parsed.tokenTransfers[0]!, fromTokenAccount: ATA_JUP }] } };
    const r = await runReconciliationCycle(deps(repo, rpcFor(chain({ signatures: [{ signature: SIG, slot: 501 }] })), heliusFor({ [SIG]: swapSameMint })));
    expect(r).toMatchObject({ clean: 1, mismatch: 0, paused: 0 });
    expect(repo.reports[0]!.movements[0]).toMatchObject({ classification: 'EXPECTED', lifecycleId: INTENT });
    expect(repo.reports[0]!.balances[0]).toMatchObject({ mint: null, expected: '1000000000', observed: '1000000000', ok: true });
  });

  it('without a Helius key, a new signature cannot be explained: MOVEMENT_UNPARSEABLE pauses; a chain read failure is UNAVAILABLE without a pause', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }]);
    const r = await runReconciliationCycle(deps(repo, rpcFor(chain({ signatures: [{ signature: SIG, slot: 501 }] })), null));
    expect(r).toMatchObject({ mismatch: 1, paused: 1 });
    expect(repo.reports[0]).toMatchObject({ reasons: ['MOVEMENT_UNPARSEABLE'], movementSource: 'NONE', unparsedSignatures: [SIG] });
    const repo2 = new MemoryRepo(custody(), []);
    const r2 = await runReconciliationCycle(deps(repo2, rpcFor(chain({ fail: true })), null));
    expect(r2).toMatchObject({ unavailable: 1, paused: 0 });
    expect(r2.errors[0]).toMatchObject({ step: 'CHAIN' });
    expect(repo2.reports[0]!.status).toBe('UNAVAILABLE');
  });

  it('a token the ledger does not know, sitting in an unregistered account, pauses', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }]);
    const airdrop = { pubkey: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', amount: '77' };
    const r = await runReconciliationCycle(deps(repo, rpcFor(chain({ tokens: [...chain().tokens, airdrop] })), heliusFor({})));
    expect(r.paused).toBe(1);
    expect(repo.reports[0]!.reasons.sort()).toEqual(['UNEXPECTED_TOKEN_ACCOUNT', 'UNREGISTERED_CUSTODY_LOCATION']);
    expect(repo.reports[0]!.unexpectedTokenAccounts[0]).toMatchObject({ mint: airdrop.mint, amount: '77', registered: false });
  });

  it('evaluatedAt comes from the injected clock', async () => {
    const repo = new MemoryRepo(custody(), []);
    await runReconciliationCycle(deps(repo, rpcFor(chain()), null));
    expect(repo.reports[0]!.evaluatedAt).toBe(NOW satisfies Instant);
  });

  it('more signatures than one page: pagination walks back with before until the cursor, every page distinct, and the cursor lands on the newest (review R4-01)', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }]);
    const many = Array.from({ length: 250 }, (_, i) => ({ signature: `${SIG.slice(0, -4)}${String(1000 + i).replace(/0/g, 'a')}`, slot: 600 + i }));
    const state = chain({ signatures: many });
    const items: Record<string, unknown> = {};
    for (const m of many) items[m.signature] = { ...parsedTransferIn, signature: m.signature, parsed: { ...parsedTransferIn.parsed, slot: m.slot, feePayer: WALLET, tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: WALLET, fromTokenAccount: ATA_JUP, toTokenAccount: ATA_JUP, rawTokenAmount: '1', decimals: 6, mint: JUP }] } };
    const r = await runReconciliationCycle(deps(repo, rpcFor(state), heliusFor(items)));
    expect(state.rpcCalls).toBe(3); // three signature pages: 100, 100, 50
    expect(r.errors).toEqual([]);
    const rep = repo.reports[0]!;
    expect(rep.reasons).not.toContain('SIGNATURE_BACKLOG');
    expect(rep.movements).toHaveLength(250);
    expect(new Set(rep.movements.map((m) => m.signature)).size).toBe(250);
    expect(rep.cursor.lastSignature).toBe(many[249]!.signature);
    expect(rep.cursor.lastSlot).toBe(849);
  });

  it('a signature Helius could not parse holds the cursor back and keeps the SOL baseline, so it is retried next cycle (review R4-08)', async () => {
    const repo = new MemoryRepo(custody(), [{ mint: JUP, expected: '5000000' }]);
    const bad = SIG.slice(0, -1) + 'B';
    const state = chain({ signatures: [{ signature: SIG, slot: 501 }, { signature: bad, slot: 502 }, { signature: SIG.slice(0, -1) + 'C', slot: 503 }] });
    const okItem = (sig: string, slot: number) => ({ ...parsedTransferIn, signature: sig, parsed: { ...parsedTransferIn.parsed, slot, feePayer: WALLET, tokenTransfers: [] } });
    repo.cursor = { lastSignature: null, lastSlot: null, solLamports: '1000000000' as Amount };
    const r = await runReconciliationCycle(deps(repo, rpcFor(state), heliusFor({ [SIG]: okItem(SIG, 501), [SIG.slice(0, -1) + 'C']: okItem(SIG.slice(0, -1) + 'C', 503) })));
    expect(r.paused).toBe(1);
    const rep = repo.reports[0]!;
    expect(rep.reasons).toEqual(['MOVEMENT_UNPARSEABLE']);
    expect(rep.unparsedSignatures).toEqual([bad]);
    expect(rep.cursor).toEqual({ lastSignature: SIG, lastSlot: 501, solLamports: '1000000000' });
  });
});
