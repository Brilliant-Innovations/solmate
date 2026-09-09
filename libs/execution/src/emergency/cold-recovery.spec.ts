import fc from 'fast-check';
import { coldRecoveryDigest, sweepSignerPolicy, type ColdRecoveryRecord, type MintAddress, type SolanaAddress, type VersionId } from '@sol-agent-trader/contracts';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { associatedTokenAddress } from '../direct-pool/bytes.js';
import { decodeTransaction, encodeTransaction, type DecodedMessage } from '../tx/codec.js';
import { COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { checkSweepTransaction, sweepDestinations, verifyColdRecoveryRecord } from './cold-recovery.js';

/**
 * INV-27 — "SWEEP_TO_COLD_RECOVERY cannot target anything except the pinned cold-recovery wallet
 * and its canonical token accounts."
 *
 * The provider's break-glass policy enforces this during an incident (D53: nothing in the
 * application signs). What is testable here is the artifact that generates those conditions and the
 * local mirror that makes the drill meaningful: the destination comes from the pinned record and
 * from nowhere else, and no function here takes a recipient argument for a caller to supply (D54).
 */

const addr = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TRADING = addr(1) as SolanaAddress;
const COLD = addr(2) as SolanaAddress;
const USDC = addr(3) as MintAddress;
const OTHER_WALLET = addr(4) as SolanaAddress;
const SRC_ATA = addr(5) as SolanaAddress;
const POLICY_VERSION = 'break-glass-sweep-v1' as VersionId;
const COLD_USDC_ATA = associatedTokenAddress(COLD, USDC, TOKEN_PROGRAM) as SolanaAddress;

const record: ColdRecoveryRecord = {
  version: 'cold-recovery-v1' as VersionId,
  cluster: 'mainnet-beta',
  coldRecoveryWallet: COLD,
  tokenAccounts: [{ mint: USDC, tokenAccount: COLD_USDC_ATA, tokenProgram: TOKEN_PROGRAM as SolanaAddress }],
  offlineRecordReference: 'sealed envelope, operator safe, reviewed 2026-09-09',
};
const ctx = { policyVersion: POLICY_VERSION, tradingWallet: TRADING, cluster: 'mainnet-beta' };

/** accounts: [source, mint, destination, authority]; data: byte 12, u64 amount, u8 decimals. */
const transferChecked = () => Uint8Array.from([12, 64, 66, 15, 0, 0, 0, 0, 0, 6]);
/** System `Transfer`: u32 discriminator 2, u64 lamports. */
const systemTransfer = () => Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);

/** keys: 0 trading wallet, 1 src ata, 2 mint, 3 destination, 4 compute budget, 5 token, 6 system. */
function sweep(destination: string, over: Partial<DecodedMessage> = {}, extraKeys: string[] = []) {
  const keys = [TRADING, SRC_ATA, USDC, destination, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM, ...extraKeys];
  const message: DecodedMessage = {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 3 },
    staticAccountKeys: keys,
    recentBlockhash: addr(9),
    instructions: [{ programIdIndex: 5, accountIndexes: [1, 2, 3, 0], data: transferChecked() }],
    addressTableLookups: [],
    ...over,
  };
  return decodeTransaction(encodeTransaction([null], message));
}

describe('cold-recovery record is provable, not merely asserted (D54)', () => {
  it('accepts a record whose token account is the canonical ATA of the pinned wallet', () => {
    expect(verifyColdRecoveryRecord(record)).toEqual({ ok: true });
  });

  it('rejects a lookalike token account that is not the canonical ATA', () => {
    const v = verifyColdRecoveryRecord({ ...record, tokenAccounts: [{ ...record.tokenAccounts[0]!, tokenAccount: addr(7) as SolanaAddress }] });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.findings[0]!.kind).toBe('TOKEN_ACCOUNT_NOT_CANONICAL');
      // The finding names the address it should have been, so the reviewer can correct the record.
      expect(v.findings[0]).toMatchObject({ canonical: COLD_USDC_ATA });
    }
  });

  it('names exactly the pinned destinations and nothing else', () => {
    expect(sweepDestinations(record)).toEqual([COLD, COLD_USDC_ATA]);
  });

  it('digests the record, and the digest moves when the destination does', async () => {
    const a = await coldRecoveryDigest(record);
    expect(await coldRecoveryDigest({ ...record })).toBe(a);
    expect(await coldRecoveryDigest({ ...record, coldRecoveryWallet: OTHER_WALLET })).not.toBe(a);
    expect(await coldRecoveryDigest({ ...record, tokenAccounts: [] })).not.toBe(a);
  });
});

describe('INV-27: a sweep reaches the pinned destination and nothing else', () => {
  it('permits the pinned token account and the pinned wallet', () => {
    expect(checkSweepTransaction(sweep(COLD_USDC_ATA), record, ctx).ok).toBe(true);
    const sol = sweep(COLD, { instructions: [{ programIdIndex: 6, accountIndexes: [0, 3], data: systemTransfer() }] });
    expect(checkSweepTransaction(sol, record, ctx).ok).toBe(true);
  });

  it('refuses any other destination (property over arbitrary addresses)', () => {
    fc.assert(
      // A Solana address is exactly 32 bytes; generate the bytes so every case is a real address
      // that survives the codec round trip, rather than an arbitrary base58 string that may not.
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const destination = base58Encode(bytes);
        fc.pre(destination !== COLD_USDC_ATA && destination !== COLD);
        const v = checkSweepTransaction(sweep(destination), record, ctx);
        return !v.ok && v.reasons.includes('SPL_RECIPIENT_NOT_ALLOWED');
      }),
      { numRuns: 200 },
    );
  });

  it('refuses a SOL transfer to anywhere but the pinned wallet', () => {
    const v = checkSweepTransaction(sweep(OTHER_WALLET, { instructions: [{ programIdIndex: 6, accountIndexes: [0, 3], data: systemTransfer() }] }), record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('SOL_TRANSFER_RECIPIENT_NOT_ALLOWED');
  });

  it('refuses a destination that arrives through an address lookup table', () => {
    // Index past the static keys: the provider cannot resolve it, so neither can a reviewer.
    const viaTable = sweep(COLD_USDC_ATA, { instructions: [{ programIdIndex: 5, accountIndexes: [1, 2, 40, 0], data: transferChecked() }] });
    const v = checkSweepTransaction(viaTable, record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('TRANSFER_TARGET_VIA_LOOKUP_TABLE');
    // And a sweep carrying lookup tables at all is refused: it never needs them.
    const withTables = sweep(COLD_USDC_ATA, { addressTableLookups: [{ accountKey: addr(11), writableIndexes: [0], readonlyIndexes: [] }] });
    const w = checkSweepTransaction(withTables, record, ctx);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reasons).toContain('LOOKUP_TABLES_NOT_ALLOWED');
  });

  it('refuses a plain SPL Transfer, whose mint the provider cannot see', () => {
    const plain = sweep(COLD_USDC_ATA, { instructions: [{ programIdIndex: 5, accountIndexes: [1, 3, 0], data: Uint8Array.from([3, 64, 66, 15, 0, 0, 0, 0, 0]) }] });
    const v = checkSweepTransaction(plain, record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('SPL_MINT_NOT_POLICY_VISIBLE');
  });

  it('refuses a mint the record never pinned', () => {
    const otherMint = sweep(COLD_USDC_ATA, {}, []);
    const swapped = decodeTransaction(encodeTransaction([null], { ...otherMint.message, staticAccountKeys: [TRADING, SRC_ATA, addr(12), COLD_USDC_ATA, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM] }));
    const v = checkSweepTransaction(swapped, record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('SPL_MINT_NOT_ALLOWED');
  });

  it('refuses a route program: a sweep moves what is held, it never trades', () => {
    const withRouter = sweep(COLD_USDC_ATA, {
      instructions: [
        { programIdIndex: 5, accountIndexes: [1, 2, 3, 0], data: transferChecked() },
        { programIdIndex: 7, accountIndexes: [0, 1, 3], data: new Uint8Array(40).fill(3) },
      ],
    }, [JUPITER_V6_PROGRAM]);
    const v = checkSweepTransaction(withRouter, record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('PROGRAM_NOT_ALLOWED');
  });

  it('refuses a second signer and a fee payer that is not the compromised wallet', () => {
    const twoSigners = decodeTransaction(
      encodeTransaction([null, null], {
        ...sweep(COLD_USDC_ATA).message,
        header: { numRequiredSignatures: 2, numReadonlySigned: 0, numReadonlyUnsigned: 3 },
        staticAccountKeys: [TRADING, OTHER_WALLET, USDC, COLD_USDC_ATA, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM],
      }),
    );
    const v = checkSweepTransaction(twoSigners, record, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('UNEXPECTED_SIGNER');
  });

  it('the policy it builds carries no destination the record did not pin', () => {
    const policy = sweepSignerPolicy(record, { policyVersion: POLICY_VERSION, tradingWallet: TRADING });
    expect(policy.allowedTransferRecipients).toEqual([COLD]);
    expect(policy.allowedSplRecipients).toEqual([COLD_USDC_ATA]);
    expect(policy.allowLookupTables).toBe(false);
    // No router, no direct-pool venue: only transfers and the accounts they need.
    expect(policy.allowedPrograms).not.toContain(JUPITER_V6_PROGRAM);
  });
});
