import { randomUUID } from 'node:crypto';
import { toInstant, type Amount, type SolanaAddress, type TxSignature, type Uuid, type WalletEvent } from '@sol-agent-trader/contracts';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';
import { ingestWalletEvents, listTrackedWallets, registerTrackedWallet, setWalletTracking, walletCursor } from './wallet-events-repo.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('wallet events repository (§6.7, D8, D26)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const rnd = (len: number) => Array.from({ length: len }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'wallet-events-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('registers a wallet, ingests events idempotently, moves the cursor and refuses owned wallets', async () => {
    const wallet = rnd(44) as SolanaAddress;
    const owned = rnd(44) as SolanaAddress;
    await registerTrackedWallet(sql, { address: wallet, discoverySource: 'MANUAL', labels: [{ label: 'SMART_MONEY', confidence: 0.6 as never, source: 'test', firstSeenAt: NOW }], isOwned: false, firstSeenAt: NOW });
    await registerTrackedWallet(sql, { address: owned, discoverySource: 'CUSTODY', labels: [], isOwned: true, firstSeenAt: NOW });
    const listed = await listTrackedWallets(sql);
    expect(listed.find((w) => w.address === wallet)).toEqual({ address: wallet, discoverySource: 'MANUAL', isOwned: false });
    expect(listed.find((w) => w.address === owned)?.isOwned).toBe(true);
    expect(await walletCursor(sql, wallet)).toBeNull();

    const sig = rnd(87) as TxSignature;
    const event: WalletEvent = {
      id: randomUUID() as Uuid, wallet, signature: sig, movementIndex: 1, slot: 501 as never, blockTime: NOW, kind: 'BUY', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as never,
      amount: '5000000' as Amount, decimals: 6, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as never, quoteAmount: '250000000' as Amount, counterparty: null, source: 'HELIUS_POLL', firstSeenAt: NOW,
      payloadHash: '0'.repeat(63) + '1' as never,
    };
    expect(await ingestWalletEvents(sql, wallet, [event], { lastSignature: sig, lastSlot: 501 as never })).toBe(1);
    expect(await ingestWalletEvents(sql, wallet, [{ ...event, id: randomUUID() as Uuid }], { lastSignature: sig, lastSlot: 501 as never })).toBe(0);
    expect(await walletCursor(sql, wallet)).toEqual({ lastSignature: sig, lastSlot: 501 });
    await expect(ingestWalletEvents(sql, owned, [], null)).rejects.toThrow(/owned/);
    await setWalletTracking(sql, wallet, false);
    expect((await listTrackedWallets(sql)).some((w) => w.address === wallet)).toBe(false);
    expect(await walletCursor(sql, wallet)).toEqual({ lastSignature: sig, lastSlot: 501 });
  });
});
