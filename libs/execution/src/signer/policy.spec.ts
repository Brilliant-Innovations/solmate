import { profile2SignerPolicy, renderTurnkeyPolicy, signerPolicyDigest, type MintAddress, type SignerTransactionPolicy, type SolanaAddress, type VersionId } from '@sol-agent-trader/contracts';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { decodeTransaction, encodeTransaction, type DecodedMessage } from '../tx/codec.js';
import { ASSOCIATED_TOKEN_PROGRAM, BASE_PROGRAMS, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';
import { evaluateSignerPolicy } from './policy.js';

/**
 * ADR-0008 splits Probe A into four recorded results. Three of them are properties of the policy
 * artifact rather than of the provider account, and are therefore contract tests here:
 *
 *   (b) supported-shape acceptance — the Profile 2 swap signs;
 *   (c) malicious-shape rejection — foreign program, foreign recipient, extra signer, placeholder;
 *   (d) lookup-table compatibility — a legitimate v0 route with tables signs, and a value movement
 *       whose destination or mint arrives through a table does not.
 *
 * Only (a), the deny-export and policy-administration restrictions on both principals, needs the
 * live provider account and stays operator work.
 */

const addr = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const WALLET = addr(1) as SolanaAddress;
const SRC_ATA = addr(2) as SolanaAddress;
const MINT = addr(3) as MintAddress;
const DST_ATA = addr(4) as SolanaAddress;
const FOREIGN_ATA = addr(5) as SolanaAddress;
const FOREIGN_PROGRAM = addr(6) as SolanaAddress;
const OTHER_WALLET = addr(7) as SolanaAddress;
const OTHER_MINT = addr(8) as MintAddress;

const KEYS = [WALLET, SRC_ATA, MINT, DST_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM] as string[];
const I_CB = 4;
const I_ATA = 5;
const I_JUP = 6;
const I_TOKEN = 7;
const I_SYSTEM = 8;

const policy: SignerTransactionPolicy = profile2SignerPolicy({
  version: 'signer-policy-v1' as VersionId,
  cluster: 'mainnet-beta',
  tradingWallet: WALLET,
  routePrograms: [JUPITER_V6_PROGRAM as SolanaAddress],
  basePrograms: BASE_PROGRAMS as SolanaAddress[],
  settlementMint: MINT,
  heldMints: [],
  ownedTokenAccounts: [SRC_ATA, DST_ATA],
  allowLookupTables: true,
});
const ctx = { cluster: 'mainnet-beta' };

/** `TransferChecked`: byte 12, u64 amount, u8 decimals; accounts [source, mint, destination, authority]. */
const transferChecked = (amount = 1_000_000n, decimals = 6) => {
  const out = new Uint8Array(10);
  out[0] = 12;
  let v = amount;
  for (let i = 1; i <= 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[9] = decimals;
  return out;
};
/** Plain `Transfer`: byte 3, u64 amount; accounts [source, destination, authority] — no mint. */
const plainTransfer = () => Uint8Array.from([3, 64, 66, 15, 0, 0, 0, 0, 0]);
/** System `Transfer`: u32 discriminator 2, u64 lamports. */
const systemTransfer = () => Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);

function tx(over: Partial<DecodedMessage> = {}, keys: string[] = KEYS, signatures: (string | null)[] = [null]) {
  const message: DecodedMessage = {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 5 },
    staticAccountKeys: keys,
    recentBlockhash: addr(9),
    instructions: [
      { programIdIndex: I_CB, accountIndexes: [], data: Uint8Array.from([2, 64, 66, 15, 0]) },
      { programIdIndex: I_ATA, accountIndexes: [0, 3, 0, 2, I_SYSTEM, I_TOKEN], data: Uint8Array.from([1]) },
      { programIdIndex: I_JUP, accountIndexes: [0, 1, 3], data: new Uint8Array(40).fill(3) },
      { programIdIndex: I_TOKEN, accountIndexes: [1, 2, 3, 0], data: transferChecked() },
    ],
    addressTableLookups: [{ accountKey: addr(10), writableIndexes: [1, 2], readonlyIndexes: [3] }],
    ...over,
  };
  return decodeTransaction(encodeTransaction(signatures, message));
}

describe('signer-side transaction policy (D55, §15.7A, ADR-0008, INV-25)', () => {
  it('(b) accepts the Profile 2 swap shape and reports what it touched', () => {
    const v = evaluateSignerPolicy(tx(), policy, ctx);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.programs).toEqual([COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM]);
      expect(v).toMatchObject({ solTransfers: 0, splTransfers: 1 });
    }
  });

  it('(c) rejects every malicious shape the policy exists to stop', () => {
    const cases: [string, ReturnType<typeof tx>, string][] = [
      ['a program outside the allowlist', tx({}, [...KEYS.slice(0, I_JUP), FOREIGN_PROGRAM, ...KEYS.slice(I_JUP + 1)]), 'PROGRAM_NOT_ALLOWED'],
      ['someone else paying and signing', tx({}, [OTHER_WALLET, ...KEYS.slice(1)]), 'FEE_PAYER_NOT_TRADING_WALLET'],
      [
        'a second required signer',
        tx({ header: { numRequiredSignatures: 2, numReadonlySigned: 0, numReadonlyUnsigned: 5 } }, [WALLET, OTHER_WALLET, ...KEYS.slice(2)], [null, null]),
        'UNEXPECTED_SIGNER',
      ],
      ['tokens credited to an account we do not own', tx({}, [...KEYS.slice(0, 3), FOREIGN_ATA, ...KEYS.slice(4)]), 'SPL_RECIPIENT_NOT_ALLOWED'],
      ['a mint the Release never enabled', tx({}, [...KEYS.slice(0, 2), OTHER_MINT, ...KEYS.slice(3)]), 'SPL_MINT_NOT_ALLOWED'],
      [
        'a bare SOL transfer out of the wallet, which this shape set never needs',
        tx({ instructions: [{ programIdIndex: I_SYSTEM, accountIndexes: [0, 3], data: systemTransfer() }] }),
        'SOL_TRANSFER_NOT_PERMITTED',
      ],
      [
        'a plain SPL Transfer, whose mint the provider cannot see at all',
        tx({ instructions: [{ programIdIndex: I_TOKEN, accountIndexes: [1, 3, 0], data: plainTransfer() }] }),
        'SPL_MINT_NOT_POLICY_VISIBLE',
      ],
      ['a program reached through a lookup table', tx({ instructions: [{ programIdIndex: 40, accountIndexes: [0], data: Uint8Array.from([1]) }] }), 'PROGRAM_VIA_LOOKUP_TABLE'],
      [
        'more instructions than the shape set permits',
        tx({ instructions: Array.from({ length: policy.maxInstructions + 1 }, () => ({ programIdIndex: I_CB, accountIndexes: [], data: Uint8Array.from([2, 64, 66, 15, 0]) })) }),
        'TOO_MANY_INSTRUCTIONS',
      ],
    ];
    for (const [name, t, reason] of cases) {
      const v = evaluateSignerPolicy(t, policy, ctx);
      expect(v.ok, name).toBe(false);
      if (!v.ok) expect(v.reasons, name).toContain(reason);
    }
  });

  it('(c) refuses a transaction for a cluster the policy is not pinned to', () => {
    const v = evaluateSignerPolicy(tx(), policy, { cluster: 'devnet' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons).toContain('CLUSTER_MISMATCH');
  });

  it('(d) a legitimate v0 route may load accounts from lookup tables, but nothing of value may land in one', () => {
    // The accepted shape in (b) already carries an address table lookup.
    expect(evaluateSignerPolicy(tx(), policy, ctx).ok).toBe(true);
    // An index past the static keys is an address-table account: the provider substitutes
    // ADDRESS_TABLE_LOOKUP and neither of us can say where it points.
    const toTable = tx({ instructions: [{ programIdIndex: I_TOKEN, accountIndexes: [1, 2, 40, 0], data: transferChecked() }] });
    const mintFromTable = tx({ instructions: [{ programIdIndex: I_TOKEN, accountIndexes: [1, 41, 3, 0], data: transferChecked() }] });
    for (const [name, t] of [
      ['destination', toTable],
      ['mint', mintFromTable],
    ] as const) {
      const v = evaluateSignerPolicy(t, policy, ctx);
      expect(v.ok, name).toBe(false);
      if (!v.ok) expect(v.reasons, name).toContain('TRANSFER_TARGET_VIA_LOOKUP_TABLE');
    }
    // A deployment whose Release does not use lookup tables refuses them outright.
    const noTables = evaluateSignerPolicy(tx(), { ...policy, allowLookupTables: false }, ctx);
    expect(noTables.ok).toBe(false);
    if (!noTables.ok) expect(noTables.reasons).toContain('LOOKUP_TABLES_NOT_ALLOWED');
  });

  it('renders the pinned provider conditions from the same artifact the evaluator reads', () => {
    const rendered = renderTurnkeyPolicy(policy);
    const allow = rendered.find((r) => r.effect === 'EFFECT_ALLOW');
    expect(allow).toBeDefined();
    expect(allow!.condition).toContain(`solana.tx.fee_payer == '${WALLET}'`);
    expect(allow!.condition).toContain('solana.tx.program_keys.all(k, k in [');
    expect(allow!.condition).toContain(`solana.tx.instructions.count() <= ${policy.maxInstructions}`);
    // No bare SOL transfer is permitted, so the clause is a count, not an allowlist to get wrong.
    expect(allow!.condition).toContain('solana.tx.transfers.count() == 0');
    expect(allow!.condition).toContain(`t.owner == '${WALLET}'`);
    // The lookup-table denials are explicit rules a human reviewer can see in the provider console.
    const denies = rendered.filter((r) => r.effect === 'EFFECT_DENY').map((r) => r.condition);
    expect(denies.some((c) => c.includes("solana.tx.transfers.any(t, t.to == 'ADDRESS_TABLE_LOOKUP')"))).toBe(true);
    expect(denies.some((c) => c.includes('spl_transfers') && c.includes('ADDRESS_TABLE_LOOKUP'))).toBe(true);
  });

  it('the digest is stable for the same policy and moves for any change worth attesting', async () => {
    const a = await signerPolicyDigest(policy);
    expect(await signerPolicyDigest({ ...policy })).toBe(a);
    for (const changed of [
      { ...policy, allowedPrograms: [...policy.allowedPrograms, FOREIGN_PROGRAM] },
      { ...policy, allowedSplRecipients: [...policy.allowedSplRecipients, FOREIGN_ATA] },
      { ...policy, allowLookupTables: !policy.allowLookupTables },
      { ...policy, maxInstructions: policy.maxInstructions + 1 },
      { ...policy, tradingWallet: OTHER_WALLET },
    ]) {
      expect(await signerPolicyDigest(changed)).not.toBe(a);
    }
  });
});
