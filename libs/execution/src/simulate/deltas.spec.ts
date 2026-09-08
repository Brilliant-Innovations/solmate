import fc from 'fast-check';
import { fixtures, type Amount, type MintAddress } from '@sol-agent-trader/contracts';
import { base58Decode, base58Encode } from '@sol-agent-trader/solana-hard-state';
import type { AccountSnapshot } from './client.js';
import { assertSemanticDeltas, type DeltaExpectation } from './deltas.js';
import { decodeTokenAccount } from './token-account.js';
import { TOKEN_PROGRAM } from '../validate/programs.js';

const WALLET = base58Encode(new Uint8Array(32).fill(1));
const ATTACKER = base58Encode(new Uint8Array(32).fill(2));
const USDC = fixtures.MINTS.USDC as MintAddress;
const TOKEN = fixtures.MINTS.RISK as MintAddress;
const OTHER = base58Encode(new Uint8Array(32).fill(7)) as MintAddress;
const ata = (n: number) => base58Encode(new Uint8Array(32).fill(100 + n));

function tokenAccountData(mint: string, owner: string, amount: bigint, over: { delegate?: string; closeAuthority?: string; frozen?: boolean } = {}): string {
  const data = new Uint8Array(165);
  data.set(base58Decode(mint), 0);
  data.set(base58Decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  if (over.delegate) {
    new DataView(data.buffer).setUint32(72, 1, true);
    data.set(base58Decode(over.delegate), 76);
  }
  data[108] = over.frozen ? 2 : 1;
  if (over.closeAuthority) {
    new DataView(data.buffer).setUint32(129, 1, true);
    data.set(base58Decode(over.closeAuthority), 133);
  }
  return Buffer.from(data).toString('base64');
}
const snap = (address: string, mint: string, owner: string, amount: bigint, over = {}): AccountSnapshot => ({ address, lamports: 2_039_280, owner: TOKEN_PROGRAM, dataBase64: tokenAccountData(mint, owner, amount, over) });

function expectation(over: Partial<DeltaExpectation> = {}): DeltaExpectation {
  const pre = [snap(ata(1), USDC, WALLET, 1_000_000_000n), snap(ata(2), TOKEN, WALLET, 0n), snap(ata(3), OTHER, WALLET, 500n)];
  const post = [snap(ata(1), USDC, WALLET, 800_000_000n), snap(ata(2), TOKEN, WALLET, 1_990_000n), snap(ata(3), OTHER, WALLET, 500n)];
  return { tradingWallet: WALLET, inputMint: USDC, outputMint: TOKEN, maxInputDecrease: '200000000' as Amount, minOutputIncrease: '1980000' as Amount, maxSolDebitLamports: 50_000n, pre, preWalletLamports: 1_000_000_000, post, postWalletLamports: 999_970_000, simulationErr: null, logs: ['ok'], slot: 5000, rpcLabel: 'sim', ...over };
}

describe('semantic balance-delta assertions (§15.4 step 6, P7 landing-time bounds)', () => {
  it('decodes token accounts and passes a swap whose deltas stay inside the authorized bounds, reporting per-mint deltas', () => {
    const t = decodeTokenAccount(new Uint8Array(Buffer.from(tokenAccountData(USDC, WALLET, 42n, { delegate: ATTACKER }), 'base64')));
    expect(t).toMatchObject({ mint: USDC, owner: WALLET, amount: 42n, delegate: ATTACKER, state: 'INITIALIZED', closeAuthority: null });
    const v = assertSemanticDeltas(expectation());
    expect(v.reasons).toEqual([]);
    expect(v.report).toMatchObject({ passed: true, slot: 5000, rpcEndpointLabel: 'sim', unexpectedAccounts: [] });
    expect(Object.fromEntries(v.report.walletDeltas.map((d) => [d.mint, d.delta]))).toEqual({ [USDC]: '-200000000', [TOKEN]: '1990000', [OTHER]: '0' });
  });

  it('refuses every P7 violation: over-spend, under-receive, unrelated debit, SOL above modelled, owner change, delegate, close authority, freeze, closed account, failed simulation, missing wallet', () => {
    const base = expectation();
    const cases: [Partial<DeltaExpectation>, string][] = [
      [{ post: [snap(ata(1), USDC, WALLET, 799_999_999n), base.post[1]!, base.post[2]!] }, 'INPUT_DECREASE_ABOVE_AUTHORIZED'],
      [{ post: [base.post[0]!, snap(ata(2), TOKEN, WALLET, 1_970_000n), base.post[2]!] }, 'OUTPUT_INCREASE_BELOW_MINIMUM'],
      [{ post: [base.post[0]!, base.post[1]!, snap(ata(3), OTHER, WALLET, 499n)] }, 'UNRELATED_TOKEN_DECREASE'],
      [{ postWalletLamports: 999_900_000 }, 'SOL_DEBIT_ABOVE_MODELED'],
      [{ post: [snap(ata(1), USDC, ATTACKER, 800_000_000n), base.post[1]!, base.post[2]!] }, 'ACCOUNT_OWNER_CHANGED'],
      [{ post: [snap(ata(1), USDC, WALLET, 800_000_000n, { delegate: ATTACKER }), base.post[1]!, base.post[2]!] }, 'DELEGATE_INTRODUCED'],
      [{ post: [snap(ata(1), USDC, WALLET, 800_000_000n, { closeAuthority: ATTACKER }), base.post[1]!, base.post[2]!] }, 'CLOSE_AUTHORITY_INTRODUCED'],
      [{ post: [base.post[0]!, snap(ata(2), TOKEN, WALLET, 1_990_000n, { frozen: true }), base.post[2]!] }, 'ACCOUNT_FROZEN'],
      [{ post: [base.post[0]!, base.post[1]!] }, 'ACCOUNT_CLOSED'],
      [{ simulationErr: { InstructionError: [2, 'Custom'] } }, 'SIMULATION_FAILED'],
      [{ postWalletLamports: null }, 'WALLET_STATE_MISSING'],
    ];
    for (const [over, reason] of cases) {
      const v = assertSemanticDeltas(expectation(over));
      expect(v.report.passed, reason).toBe(false);
      expect(v.reasons, reason).toContain(reason);
    }
    // a brand-new wallet-owned account for a mint other than the output is reported as unexpected
    const extra = assertSemanticDeltas(expectation({ post: [...base.post, snap(ata(9), OTHER, WALLET, 1n)] }));
    expect(extra.report.unexpectedAccounts).toEqual([ata(9)]);
    // a new output ATA (first purchase) is expected
    const fresh = assertSemanticDeltas(expectation({ pre: [base.pre[0]!], post: [base.post[0]!, snap(ata(2), TOKEN, WALLET, 1_990_000n)] }));
    expect(fresh.reasons).toEqual([]);
  });

  it('property: the input decrease never exceeds the authorized maximum on a passing report, and the output increase is at least the minimum', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 300_000_000n }), fc.bigInt({ min: 0n, max: 3_000_000n }), (spent, received) => {
        const v = assertSemanticDeltas(expectation({ post: [snap(ata(1), USDC, WALLET, 1_000_000_000n - spent), snap(ata(2), TOKEN, WALLET, received), snap(ata(3), OTHER, WALLET, 500n)] }));
        expect(v.report.passed).toBe(spent <= 200_000_000n && received >= 1_980_000n);
      }),
    );
  });
});
