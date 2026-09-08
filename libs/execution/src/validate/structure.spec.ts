import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { decodeTransaction, encodeTransaction, type DecodedMessage } from '../tx/codec.js';
import { ASSOCIATED_TOKEN_PROGRAM, BASE_PROGRAMS, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './programs.js';
import { checkTransactionStructure, type StructureExpectation } from './structure.js';

const WALLET = base58Encode(new Uint8Array(32).fill(1));
const OTHER = base58Encode(new Uint8Array(32).fill(2));
const CUSTODY_ATA = base58Encode(new Uint8Array(32).fill(3));
const FOREIGN_PROGRAM = base58Encode(new Uint8Array(32).fill(4));
const expected: StructureExpectation = { tradingWallet: WALLET, allowedPrograms: [...BASE_PROGRAMS, JUPITER_V6_PROGRAM], allowLookupTables: true, allowedTransferRecipients: [CUSTODY_ATA] };

/** A plausible Jupiter swap: compute budget, ATA create, one router instruction, keys = [wallet, ata, ...programs]. */
function swap(over: Partial<DecodedMessage> = {}, keys?: string[]) {
  const staticAccountKeys = keys ?? [WALLET, CUSTODY_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM];
  const message: DecodedMessage = {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 5 },
    staticAccountKeys,
    recentBlockhash: base58Encode(new Uint8Array(32).fill(9)),
    instructions: [
      { programIdIndex: 2, accountIndexes: [], data: new Uint8Array([2, 64, 66, 15, 0]) },
      { programIdIndex: 3, accountIndexes: [0, 1, 0, 6, 5], data: new Uint8Array([1]) },
      { programIdIndex: 4, accountIndexes: [0, 1, 5, 7, 8], data: new Uint8Array(40).fill(3) },
    ],
    addressTableLookups: [{ accountKey: base58Encode(new Uint8Array(32).fill(8)), writableIndexes: [1, 2], readonlyIndexes: [3] }],
    ...over,
  };
  return decodeTransaction(encodeTransaction([null], message));
}

describe('structural transaction checks (§15.4 step 4, §15.7A, ADR-0008 shapes)', () => {
  it('a wallet-paid single-signer Jupiter swap over allowed programs passes and reports the programs it touches', () => {
    const v = checkTransactionStructure(swap(), expected);
    expect(v).toEqual({ ok: true, programs: [COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM] });
  });

  it('rejects the malicious shapes: foreign fee payer, extra signer, foreign program, program behind a lookup table, lookup tables where forbidden, a System transfer to an unapproved recipient, pre-signed by others, empty', () => {
    const keys = [WALLET, CUSTODY_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM];
    const cases: [ReturnType<typeof swap>, StructureExpectation, string][] = [
      [swap({}, [OTHER, ...keys.slice(1)]), expected, 'FEE_PAYER_MISMATCH'],
      [swap({ header: { numRequiredSignatures: 2, numReadonlySigned: 0, numReadonlyUnsigned: 5 } }, [WALLET, OTHER, ...keys.slice(2)]), expected, 'UNEXPECTED_SIGNER'],
      [swap({}, [WALLET, CUSTODY_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, FOREIGN_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM]), expected, 'PROGRAM_NOT_ALLOWED'],
      [swap({ instructions: [{ programIdIndex: 9, accountIndexes: [0], data: new Uint8Array([1]) }] }), expected, 'PROGRAM_VIA_LOOKUP_TABLE'],
      [swap(), { ...expected, allowLookupTables: false }, 'LOOKUP_TABLES_NOT_ALLOWED'],
      [swap({ instructions: [{ programIdIndex: 6, accountIndexes: [0, 1], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }] }, [WALLET, OTHER, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM]), expected, 'SYSTEM_TRANSFER_TO_UNAPPROVED_RECIPIENT'],
      [decodeTransaction(encodeTransaction([base58Encode(new Uint8Array(64).fill(5)), base58Encode(new Uint8Array(64).fill(6))], { ...swap().message, header: { numRequiredSignatures: 2, numReadonlySigned: 0, numReadonlyUnsigned: 5 }, staticAccountKeys: [WALLET, OTHER, ...keys.slice(2)] })), expected, 'ALREADY_SIGNED_BY_OTHERS'],
      [swap({ instructions: [] }), expected, 'NO_INSTRUCTIONS'],
    ];
    for (const [tx, exp, reason] of cases) {
      const v = checkTransactionStructure(tx, exp);
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
    // a System transfer to an approved custody account is fine
    const ok = checkTransactionStructure(swap({ instructions: [{ programIdIndex: 6, accountIndexes: [0, 1], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }] }), expected);
    expect(ok.ok).toBe(true);
  });
});
