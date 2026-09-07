import fc from 'fast-check';
import { toInstant, type Amount, type ChainMovement, type ChainTransactionFacts, type MintAddress, type Slot, type SolanaAddress, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { deriveWalletEvents } from './derive.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const BLOCK = toInstant(Date.UTC(2026, 8, 7, 17, 0, 0));
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as SolanaAddress;
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as SolanaAddress;
const POOL = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ' as SolanaAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress;
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
let n = 0;
const opts = (over: Partial<Parameters<typeof deriveWalletEvents>[1]> = {}) => ({ wallet: WALLET, isOwned: () => false, source: 'HELIUS_POLL' as const, now: NOW, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as Uuid, ...over });

const mv = (index: number, kind: 'SOL' | 'TOKEN', mint: MintAddress | null, from: SolanaAddress, to: SolanaAddress, amount: string): ChainMovement => ({ signature: SIG, index, slot: 501 as Slot, blockTime: BLOCK, kind, mint, fromOwner: from, toOwner: to, fromTokenAccount: null, toTokenAccount: null, amount: amount as Amount, decimals: kind === 'SOL' ? 9 : 6, summaryType: 'swap', failed: false });
const tx = (movements: ChainMovement[], failed = false): ChainTransactionFacts => ({ signature: SIG, slot: 501 as Slot, blockTime: BLOCK, feeLamports: '5000' as Amount, feePayer: WALLET, failed, nativeBalanceChanges: [], movements });

describe('tracked-wallet event derivation (§9.3, D8, D26, INV-11)', () => {
  it('USDC out and JUP in is a BUY of JUP quoted in USDC; the mirror is a SELL; times keep two clocks', async () => {
    const buy = await deriveWalletEvents(tx([mv(0, 'TOKEN', USDC, WALLET, POOL, '250000000'), mv(1, 'TOKEN', JUP, POOL, WALLET, '5000000')]), opts());
    expect(buy).toHaveLength(1);
    expect(buy[0]).toMatchObject({ kind: 'BUY', mint: JUP, amount: '5000000', quoteMint: USDC, quoteAmount: '250000000', counterparty: POOL, movementIndex: 1, blockTime: BLOCK, firstSeenAt: NOW, source: 'HELIUS_POLL' });
    const sell = await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, WALLET, POOL, '5000000'), mv(1, 'SOL', null, POOL, WALLET, '100000000')]), opts());
    expect(sell[0]).toMatchObject({ kind: 'SELL', mint: JUP, amount: '5000000', quoteMint: null, quoteAmount: '100000000' });
    // A routed swap splits the base leg across two pools: amounts aggregate.
    const split = await deriveWalletEvents(tx([mv(0, 'TOKEN', USDC, WALLET, POOL, '250000000'), mv(1, 'TOKEN', JUP, POOL, WALLET, '3000000'), mv(2, 'TOKEN', JUP, OTHER, WALLET, '2000000')]), opts());
    expect(split[0]).toMatchObject({ kind: 'BUY', amount: '5000000', quoteAmount: '250000000' });
  });

  it('plain transfers and SOL movements are typed by direction; failed transactions and untouched wallets yield nothing', async () => {
    const t = await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, OTHER, WALLET, '1'), mv(1, 'SOL', null, OTHER, WALLET, '2'), mv(2, 'TOKEN', USDC, OTHER, POOL, '3')]), opts());
    expect(t.map((e) => [e.kind, e.mint, e.amount, e.counterparty])).toEqual([
      ['TRANSFER_IN', JUP, '1', OTHER],
      ['SOL_IN', null, '2', OTHER],
    ]);
    // Receiving a base asset while paying SOL to the same counterparty is a BUY even off-pool.
    const otc = await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, OTHER, WALLET, '1'), mv(1, 'SOL', null, WALLET, OTHER, '2')]), opts());
    expect(otc.map((e) => e.kind)).toEqual(['BUY']);
    expect(await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, OTHER, WALLET, '1')], true), opts())).toEqual([]);
    expect(await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, OTHER, POOL, '1')]), opts())).toEqual([]);
    // Two base mints moving at once is not a swap we can attribute: transfers.
    const multi = await deriveWalletEvents(tx([mv(0, 'TOKEN', JUP, WALLET, POOL, '1'), mv(1, 'TOKEN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress, POOL, WALLET, '2')]), opts());
    expect(multi.map((e) => e.kind)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
  });

  it('property: an owned wallet never yields an event, and every event carries the ingestion instant as firstSeenAt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ dir: fc.constantFrom('IN', 'OUT'), quote: fc.boolean(), amount: fc.bigInt({ min: 1n, max: 10n ** 12n }) }), { minLength: 1, maxLength: 6 }), fc.boolean(), async (legs, owned) => {
        const movements = legs.map((l, i) => mv(i, l.quote && i % 2 === 0 ? 'SOL' : 'TOKEN', l.quote ? (i % 2 === 0 ? null : USDC) : JUP, l.dir === 'IN' ? POOL : WALLET, l.dir === 'IN' ? WALLET : POOL, l.amount.toString()));
        const events = await deriveWalletEvents(tx(movements), opts({ isOwned: () => owned }));
        if (owned) expect(events).toEqual([]);
        else {
          expect(events.length).toBeGreaterThan(0);
          expect(events.every((e) => e.firstSeenAt === NOW && e.blockTime === BLOCK && e.wallet === WALLET)).toBe(true);
        }
      }),
    );
  });
});
