import { fixedClock, toInstant, type Slot, type SolanaAddress, type TxSignature, type WalletEvent } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { HeliusClient, type HeliusTransport } from '@sol-agent-trader/onchain';
import { runTrackedWalletsCycle, type TrackedWalletsRepo } from './tracked-wallets.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const TRADER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as SolanaAddress;
const OURS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as SolanaAddress;
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const SIG1 = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
const SIG2 = '4EWYrAvnHDA4ZgNGUgqdGsJ5DNKk4bT5hyGTLnRGT3GStpDDNXEWNq9vEaSZmiqPHJ5j6zDAZ3G1XFRa7wDbBqyz' as TxSignature;

const swap = (signature: string, slot: number, wallet: string) => ({ signature, parserStatus: 'OK', parsed: { slot, blockTime: 1_788_000_000, fee: 5000, feePayer: wallet, transactionStatus: 'OK', error: null, nativeTransfers: [], tokenTransfers: [{ fromUserAccount: wallet, toUserAccount: POOL, rawTokenAmount: '250000000', decimals: 6, mint: USDC }, { fromUserAccount: POOL, toUserAccount: wallet, rawTokenAmount: '5000000', decimals: 6, mint: JUP }], summary: { type: 'swap' } } });

class MemoryRepo implements TrackedWalletsRepo {
  events: WalletEvent[] = [];
  cursors = new Map<string, { lastSignature: TxSignature; lastSlot: Slot }>();
  constructor(
    private readonly wallets: { address: SolanaAddress; isOwned: boolean }[],
    private readonly owned: SolanaAddress[] = [],
  ) {}
  async listTrackedWallets() {
    return this.wallets;
  }
  async listOwnedAddresses() {
    return this.owned.map((address) => ({ address }));
  }
  async walletCursor(wallet: SolanaAddress) {
    return this.cursors.get(wallet) ?? null;
  }
  async ingestWalletEvents(wallet: SolanaAddress, events: readonly WalletEvent[], cursor: { lastSignature: TxSignature; lastSlot: Slot } | null) {
    let inserted = 0;
    for (const e of events) {
      if (this.events.some((x) => x.wallet === e.wallet && x.signature === e.signature && x.movementIndex === e.movementIndex && x.kind === e.kind)) continue;
      this.events.push(e);
      inserted++;
    }
    if (cursor) this.cursors.set(wallet, cursor);
    return inserted;
  }
}

function heliusFor(history: (body: Record<string, unknown>) => unknown, calls: Record<string, unknown>[] = []): HeliusClient {
  const transport: HeliusTransport = async (req) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    calls.push(body);
    return { status: 200, body: JSON.stringify(history(body)) };
  };
  return new HeliusClient({ apiKey: 'k', clock: fixedClock(NOW), transport, sleep: async () => undefined, requestsPerSecond: 1000 });
}
const deps = (repo: MemoryRepo, helius: HeliusClient) => ({ helius, repo, clock: fixedClock(NOW), logger: createLogger({ service: 'worker', sink: () => undefined }), config: { pageSize: 100, maxPagesPerWallet: 3 } });

describe('tracked-wallets role (§3.2, §6.7, D8, D26)', () => {
  it('first poll takes the newest page, derives BUY events, advances the cursor; the next poll asks after the cursor and re-ingests nothing', async () => {
    const calls: Record<string, unknown>[] = [];
    const repo = new MemoryRepo([{ address: TRADER, isOwned: false }]);
    const helius = heliusFor((body) => (body['afterSignature'] ? { data: [], paginationToken: null } : { data: [swap(SIG2, 502, TRADER), swap(SIG1, 501, TRADER)], paginationToken: null }), calls);
    const r1 = await runTrackedWalletsCycle(deps(repo, helius));
    expect(r1).toMatchObject({ wallets: 1, transactions: 2, events: 2, inserted: 2, errors: [] });
    expect(calls[0]).toMatchObject({ address: TRADER, sortOrder: 'desc', limit: 100 });
    expect(repo.events.map((e) => [e.signature, e.kind, e.mint, e.firstSeenAt])).toEqual([
      [SIG1, 'BUY', JUP, NOW],
      [SIG2, 'BUY', JUP, NOW],
    ]);
    expect(repo.cursors.get(TRADER)).toEqual({ lastSignature: SIG2, lastSlot: 502 });
    const r2 = await runTrackedWalletsCycle(deps(repo, helius));
    expect(r2).toMatchObject({ transactions: 0, inserted: 0 });
    expect(calls[1]).toMatchObject({ address: TRADER, afterSignature: SIG2, sortOrder: 'asc' });
  });

  it('owned wallets are skipped whether flagged on the row or present in the owned-address registry; a failing wallet does not stop the others', async () => {
    const repo = new MemoryRepo([{ address: OURS, isOwned: true }, { address: TRADER, isOwned: false }], [TRADER]);
    const r = await runTrackedWalletsCycle(deps(repo, heliusFor(() => { throw new Error('should not be called'); })));
    expect(r).toMatchObject({ wallets: 2, skippedOwned: 2, transactions: 0, errors: [] });
    const repo2 = new MemoryRepo([{ address: TRADER, isOwned: false }]);
    const r2 = await runTrackedWalletsCycle(deps(repo2, heliusFor(() => ({ not: 'a list' }))));
    expect(r2.errors[0]).toMatchObject({ wallet: TRADER });
    expect(r2.errors[0]!.error).toMatch(/history shape/);
  });

  it('parser failures are counted and skipped; pagination continues from the newest processed signature', async () => {
    const calls: Record<string, unknown>[] = [];
    const repo = new MemoryRepo([{ address: TRADER, isOwned: false }]);
    repo.cursors.set(TRADER, { lastSignature: SIG1, lastSlot: 501 as Slot });
    let page = 0;
    const helius = heliusFor(() => (page++ === 0 ? { data: [{ signature: SIG2, parserStatus: 'ERROR', parsed: null }, swap(SIG2.slice(0, -1) + 'A', 503, TRADER)], paginationToken: 'slot:1' } : { data: [], paginationToken: null }), calls);
    const r = await runTrackedWalletsCycle(deps(repo, helius));
    expect(r).toMatchObject({ transactions: 1, parseFailures: 1, events: 1, inserted: 1 });
    expect(calls[1]).toMatchObject({ afterSignature: SIG2.slice(0, -1) + 'A', paginationToken: 'slot:1' });
  });
});
