import { randomUUID } from 'node:crypto';
import { addMs, toInstant, type Amount, type CustodyReconciliation, type MintAddress, type SolanaAddress, type Uuid } from '@sol-agent-trader/contracts';
import { ledgerExpectations, lifecycleForSignature, listCustodyAccounts, listOwnedAddresses, listTradingAccounts, reconciliationCursor, recordReconciliation, registerOwnedAddress } from './reconciliation-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('reconciliation repository (D9, D26)', () => {
  let sql: Sql;
  const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  // A fresh wallet per run: owned-address rows persist across runs on the same database.
  const WALLET = Array.from({ length: 44 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('') as SolanaAddress;
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
  const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as never;

  beforeAll(() => {
    sql = createSql({ url: url as string, applicationName: 'reconciliation-repo-test' });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('accounts, custody, ledger expectations, cursor, reports and owned addresses round-trip', async () => {
    const accountId = randomUUID() as Uuid;
    await sql`insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint) values (${accountId}, ${'recon-' + accountId.slice(0, 8)}, 'mainnet-beta', ${WALLET}, ${USDC})`;
    expect((await listTradingAccounts(sql)).find((a) => a.id === accountId)).toMatchObject({ tradingWallet: WALLET, settlementMint: USDC, cluster: 'mainnet-beta' });

    await sql`insert into trading.custody_accounts (account_id, kind, address, owner_provider, mint, allowed_movement_types, active_from, verification_state)
      values (${accountId}, 'TRADING_WALLET', ${WALLET}, 'self', null, '{SWAP_V2}', ${addMs(NOW, -1000)}, 'VERIFIED'),
             (${accountId}, 'JUPITER_TRIGGER_VAULT', 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ', 'jupiter', ${USDC}, '{TRIGGER_DEPOSIT}', ${addMs(NOW, -1000)}, 'PENDING')`;
    const custody = await listCustodyAccounts(sql, accountId, NOW);
    expect(custody.map((c) => [c.kind, c.active])).toEqual([
      ['TRADING_WALLET', true],
      ['JUPITER_TRIGGER_VAULT', false],
    ]);

    expect(await ledgerExpectations(sql, accountId)).toEqual([]);
    expect(await reconciliationCursor(sql, accountId)).toBeNull();
    expect(await lifecycleForSignature(sql, SIG)).toBeNull();

    const report: CustodyReconciliation = {
      id: randomUUID() as Uuid, accountId, evaluatedAt: NOW, policyVersion: 'reconciliation-v1' as never, chainSlot: 500 as never, status: 'CLEAN', reasons: [],
      balances: [{ custodyAccountId: custody[0]!.id, address: WALLET, mint: null, expected: null, observed: '5' as Amount, delta: null, ok: true }],
      unexpectedTokenAccounts: [], movements: [], unparsedSignatures: [], movementSource: 'NONE',
      cursor: { lastSignature: SIG, lastSlot: 500 as never, solLamports: '5' as Amount }, pauseTriggered: false,
    };
    await recordReconciliation(sql, report);
    expect(await reconciliationCursor(sql, accountId)).toEqual({ lastSignature: SIG, lastSlot: 500, solLamports: '5' });

    await registerOwnedAddress(sql, { address: WALLET, purpose: 'TRADING_WALLET', cluster: 'mainnet-beta', accountId, registeredAt: NOW, retiredAt: null });
    await registerOwnedAddress(sql, { address: WALLET, purpose: 'OTHER', cluster: 'devnet', accountId: null, registeredAt: NOW, retiredAt: null });
    const owned = (await listOwnedAddresses(sql)).filter((o) => o.address === WALLET);
    expect(owned).toHaveLength(1);
    // The account insert trigger registered the wallet first (migration 001800); re-registration never re-purposes it.
    expect(owned[0]).toMatchObject({ purpose: 'TRADING_WALLET', cluster: 'mainnet-beta', accountId, retiredAt: null });
  });
});
