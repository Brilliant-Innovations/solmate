import fc from 'fast-check';
import { DEFAULT_RECONCILIATION_POLICY, toInstant, type Amount, type ChainTransactionFacts, type ClassifiedMovement, type CustodyBalanceObservation, type MintAddress, type Slot, type SolanaAddress, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { reconcileCustody, walletLamportDelta, type ReconcileInput } from './engine.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as SolanaAddress;
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as SolanaAddress;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const ATA_USDC = 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ' as SolanaAddress;
const ATA_JUP = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as SolanaAddress;
const ATA_BONK = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as SolanaAddress;
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
const ID = '11111111-1111-4111-8111-111111111111' as Uuid;
const ACCOUNT = '22222222-2222-4222-8222-222222222222' as Uuid;

const obs = (address: SolanaAddress, mint: MintAddress | null, amount: string): CustodyBalanceObservation => ({ address, owner: WALLET, mint, amount: amount as Amount, decimals: mint ? 6 : 9, tokenProgram: mint ? 'TOKEN' : null, slot: 500 as Slot });

function base(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    id: ID, accountId: ACCOUNT, tradingWallet: WALLET, settlementMint: USDC,
    custody: [
      { id: 'a0000000-0000-4000-8000-000000000000' as Uuid, address: WALLET, kind: 'TRADING_WALLET', mint: null, active: true },
      { id: 'a0000000-0000-4000-8000-000000000001' as Uuid, address: ATA_USDC, kind: 'ASSOCIATED_TOKEN_ACCOUNT', mint: USDC, active: true },
      { id: 'a0000000-0000-4000-8000-000000000002' as Uuid, address: ATA_JUP, kind: 'ASSOCIATED_TOKEN_ACCOUNT', mint: JUP, active: true },
    ],
    expectations: [{ mint: JUP, expected: '5000000' as Amount }],
    observed: [obs(WALLET, null, '1000000000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')],
    chainSlot: 500 as Slot,
    previousCursor: { lastSignature: null, lastSlot: null, solLamports: '1000000000' as Amount },
    newSignatures: [],
    signatureBacklog: false,
    transactions: [],
    unparsedSignatures: [],
    movements: [],
    movementSource: 'HELIUS',
    now: NOW,
    policy: DEFAULT_RECONCILIATION_POLICY,
    ...over,
  };
}

const tx = (over: Partial<ChainTransactionFacts> = {}): ChainTransactionFacts => ({ signature: SIG, slot: 501 as Slot, blockTime: NOW, feeLamports: '5000' as Amount, feePayer: WALLET, failed: false, nativeBalanceChanges: [], movements: [], ...over });
const mv = (over: Partial<ClassifiedMovement> = {}): ClassifiedMovement => ({ signature: SIG, index: 0, slot: 501 as Slot, blockTime: NOW, kind: 'TOKEN', mint: JUP, fromOwner: OTHER, toOwner: WALLET, fromTokenAccount: OTHER, toTokenAccount: ATA_JUP, amount: '1' as Amount, decimals: 6, summaryType: 'transfer', failed: false, classification: 'UNKNOWN', reason: 'NO_LIFECYCLE', lifecycleId: null, ...over });

describe('custody reconciliation engine (D9, §13.6)', () => {
  it('ledger and chain agree, nothing moved: CLEAN, no pause, cursor re-baselined to the observed SOL', () => {
    const r = reconcileCustody(base());
    expect(r.status).toBe('CLEAN');
    expect(r.pauseTriggered).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.balances.map((b) => [b.mint, b.expected, b.observed, b.ok])).toEqual([
      [null, '1000000000', '1000000000', true],
      [JUP, '5000000', '5000000', true],
      [USDC, null, '250000000', true],
    ]);
    expect(r.cursor).toEqual({ lastSignature: null, lastSlot: null, solLamports: '1000000000' });
  });

  it('a token balance that disagrees with the ledger by one base unit is a MISMATCH that pauses', () => {
    const r = reconcileCustody(base({ observed: [obs(WALLET, null, '1000000000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '4999999')] }));
    expect(r.status).toBe('MISMATCH');
    expect(r.reasons).toEqual(['BALANCE_MISMATCH']);
    expect(r.pauseTriggered).toBe(true);
    expect(r.balances[1]).toMatchObject({ mint: JUP, delta: '-1', ok: false });
  });

  it('an airdropped token account the ledger does not know is UNEXPECTED and, unregistered, also an unregistered custody location', () => {
    const r = reconcileCustody(base({ observed: [obs(WALLET, null, '1000000000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000'), obs(ATA_BONK, BONK, '1')] }));
    expect(r.reasons.sort()).toEqual(['UNEXPECTED_TOKEN_ACCOUNT', 'UNREGISTERED_CUSTODY_LOCATION']);
    expect(r.unexpectedTokenAccounts).toEqual([{ tokenAccount: ATA_BONK, mint: BONK, amount: '1', registered: false }]);
    // An empty leftover account is noise under the default policy.
    const empty = reconcileCustody(base({ observed: [obs(WALLET, null, '1000000000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000'), obs(ATA_BONK, BONK, '0')] }));
    expect(empty.status).toBe('CLEAN');
  });

  it('a movement no authorized lifecycle claims pauses even when balances happen to agree; failed transactions do not', () => {
    const r = reconcileCustody(base({ newSignatures: [{ signature: SIG, slot: 501 as Slot }], transactions: [tx()], movements: [mv()] }));
    expect(r.reasons).toContain('UNKNOWN_MOVEMENT');
    expect(r.pauseTriggered).toBe(true);
    expect(r.cursor.lastSignature).toBe(SIG);
    const failed = reconcileCustody(base({ newSignatures: [{ signature: SIG, slot: 501 as Slot }], transactions: [tx({ failed: true })], movements: [mv({ failed: true })], observed: [obs(WALLET, null, '999995000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')] }));
    expect(failed.status).toBe('CLEAN');
    const expected = reconcileCustody(base({ newSignatures: [{ signature: SIG, slot: 501 as Slot }], transactions: [tx()], movements: [mv({ classification: 'EXPECTED', reason: null, lifecycleId: ID })], observed: [obs(WALLET, null, '999995000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')] }));
    expect(expected.status).toBe('CLEAN');
  });

  it('signatures we could not parse, or a backlog we did not process, are never silently clean', () => {
    const r = reconcileCustody(base({ newSignatures: [{ signature: SIG, slot: 501 as Slot }], unparsedSignatures: [SIG], movementSource: 'NONE' }));
    expect(r.reasons).toEqual(['MOVEMENT_UNPARSEABLE']);
    expect(r.pauseTriggered).toBe(true);
    expect(r.balances[0]!.expected).toBeNull();
    const backlog = reconcileCustody(base({ signatureBacklog: true, previousCursor: { lastSignature: SIG, lastSlot: 400 as Slot, solLamports: '7' as Amount } }));
    expect(backlog.reasons).toEqual(['SIGNATURE_BACKLOG']);
    expect(backlog.cursor).toEqual({ lastSignature: SIG, lastSlot: 400, solLamports: '7' });
  });

  it('SOL is accounted from the previous baseline through fees and transfers; drift beyond tolerance is a mismatch; a chain read failure is UNAVAILABLE without a pause', () => {
    const facts = tx({ movements: [{ signature: SIG, index: 0, slot: 501 as Slot, blockTime: NOW, kind: 'SOL', mint: null, fromOwner: WALLET, toOwner: OTHER, fromTokenAccount: null, toTokenAccount: null, amount: '100000000' as Amount, decimals: 9, summaryType: null, failed: false }] });
    expect(walletLamportDelta(facts, WALLET)).toBe(-100_005_000n);
    expect(walletLamportDelta(tx({ nativeBalanceChanges: [{ account: WALLET, lamports: '-42' as never }] }), WALLET)).toBe(-42n);
    const withinRent = reconcileCustody(base({ newSignatures: [{ signature: SIG, slot: 501 as Slot }], transactions: [facts], movements: [], observed: [obs(WALLET, null, '897995000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')] }));
    expect(withinRent.status).toBe('CLEAN');
    expect(withinRent.balances[0]).toMatchObject({ expected: '899995000', observed: '897995000', delta: '-2000000', ok: true });
    const drift = reconcileCustody(base({ observed: [obs(WALLET, null, '900000000'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')] }));
    expect(drift.reasons).toEqual(['SOL_BALANCE_MISMATCH']);
    const first = reconcileCustody(base({ previousCursor: null, observed: [obs(WALLET, null, '123'), obs(ATA_USDC, USDC, '250000000'), obs(ATA_JUP, JUP, '5000000')] }));
    expect(first.status).toBe('CLEAN');
    expect(first.cursor.solLamports).toBe('123');
    const down = reconcileCustody(base({ observed: null }));
    expect(down).toMatchObject({ status: 'UNAVAILABLE', reasons: ['CHAIN_READ_FAILED'], pauseTriggered: false, cursor: { solLamports: '1000000000' } });
  });

  it('property: CLEAN implies every balance line is ok, no unknown movement and nothing unparsed; any reason implies a pause', () => {
    const amount = fc.bigInt({ min: 0n, max: 10_000_000n }).map((v) => v.toString() as Amount);
    fc.assert(
      fc.property(amount, amount, fc.boolean(), fc.boolean(), fc.boolean(), (expected, observed, unknown, unparsed, airdrop) => {
        const r = reconcileCustody(
          base({
            expectations: [{ mint: JUP, expected }],
            observed: [obs(WALLET, null, '1000000000'), obs(ATA_USDC, USDC, '1'), obs(ATA_JUP, JUP, observed), ...(airdrop ? [obs(ATA_BONK, BONK, '5')] : [])],
            newSignatures: unknown || unparsed ? [{ signature: SIG, slot: 501 as Slot }] : [],
            transactions: unknown ? [tx()] : [],
            movements: unknown ? [mv()] : [],
            unparsedSignatures: unparsed ? [SIG] : [],
          }),
        );
        if (r.status === 'CLEAN') {
          expect(r.balances.every((b) => b.ok)).toBe(true);
          expect(unknown || unparsed || airdrop).toBe(false);
          expect(expected).toBe(observed);
        }
        expect(r.pauseTriggered).toBe(r.reasons.length > 0);
      }),
    );
  });
});
