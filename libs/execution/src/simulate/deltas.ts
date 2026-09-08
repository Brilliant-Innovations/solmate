import type { Amount, MintAddress, SignedAmount, SimulationReport, Slot, SolanaAddress } from '@sol-agent-trader/contracts';
import { decodeTokenAccount } from './token-account.js';
import type { AccountSnapshot } from './client.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';

/**
 * Semantic balance-delta assertions over pre- and post-simulation state (blueprint §15.4 step 6;
 * ADR-0009 P7 landing-time half). Pure. The transaction may move only what the authorization
 * bounds: the input mint decreases by at most the authorized amount, the output mint increases by
 * at least the minimum the order promised, no other wallet-owned token balance decreases, SOL
 * leaves only for modelled fees and rent, and no wallet-owned account changes owner, gains a
 * delegate or close authority, or is frozen. Simulation is evidence, not a guarantee (§15.4):
 * chain reconciliation stays authoritative after landing.
 */

export interface DeltaExpectation {
  tradingWallet: string;
  inputMint: MintAddress;
  outputMint: MintAddress;
  maxInputDecrease: Amount;
  minOutputIncrease: Amount;
  /** Network fee, priority fee and any ATA rent the shape is allowed to spend from the wallet. */
  maxSolDebitLamports: bigint;
  /** Wallet-owned token accounts read before simulation, keyed by address. */
  pre: readonly AccountSnapshot[];
  preWalletLamports: number;
  post: readonly (AccountSnapshot | null)[];
  postWalletLamports: number | null;
  simulationErr: unknown | null;
  logs: readonly string[];
  slot: number;
  rpcLabel: string;
}

export type DeltaRejection =
  | 'SIMULATION_FAILED'
  | 'INPUT_DECREASE_ABOVE_AUTHORIZED'
  | 'OUTPUT_INCREASE_BELOW_MINIMUM'
  | 'UNRELATED_TOKEN_DECREASE'
  | 'SOL_DEBIT_ABOVE_MODELED'
  | 'ACCOUNT_OWNER_CHANGED'
  | 'DELEGATE_INTRODUCED'
  | 'CLOSE_AUTHORITY_INTRODUCED'
  | 'ACCOUNT_FROZEN'
  | 'ACCOUNT_CLOSED'
  | 'WALLET_STATE_MISSING';

export interface DeltaVerdict {
  report: SimulationReport;
  reasons: DeltaRejection[];
  detail: string[];
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

function balances(snapshots: readonly (AccountSnapshot | null)[], wallet: string): Map<string, { mint: string; amount: bigint; delegate: string | null; closeAuthority: string | null; frozen: boolean; owner: string }> {
  const out = new Map<string, { mint: string; amount: bigint; delegate: string | null; closeAuthority: string | null; frozen: boolean; owner: string }>();
  for (const s of snapshots) {
    if (!s || !TOKEN_PROGRAMS.has(s.owner)) continue;
    const data = new Uint8Array(Buffer.from(s.dataBase64, 'base64'));
    if (data.length < 165) continue;
    const t = decodeTokenAccount(data);
    if (t.owner !== wallet && !out.has(s.address)) {
      out.set(s.address, { mint: t.mint, amount: t.amount, delegate: t.delegate, closeAuthority: t.closeAuthority, frozen: t.state === 'FROZEN', owner: t.owner });
      continue;
    }
    out.set(s.address, { mint: t.mint, amount: t.amount, delegate: t.delegate, closeAuthority: t.closeAuthority, frozen: t.state === 'FROZEN', owner: t.owner });
  }
  return out;
}

export function assertSemanticDeltas(x: DeltaExpectation): DeltaVerdict {
  const reasons: DeltaRejection[] = [];
  const detail: string[] = [];
  const perMint = new Map<string, bigint>();
  const unexpected: string[] = [];
  if (x.simulationErr !== null) {
    reasons.push('SIMULATION_FAILED');
    detail.push(JSON.stringify(x.simulationErr).slice(0, 200));
  }
  const pre = balances(x.pre, x.tradingWallet);
  const post = balances(x.post, x.tradingWallet);
  for (const [address, before] of pre) {
    if (before.owner !== x.tradingWallet) continue;
    const after = post.get(address);
    if (!after) {
      const present = x.post.some((s) => s?.address === address);
      if (!present) {
        reasons.push('ACCOUNT_CLOSED');
        detail.push(address);
      }
      perMint.set(before.mint, (perMint.get(before.mint) ?? 0n) - before.amount);
      continue;
    }
    if (after.owner !== before.owner) {
      reasons.push('ACCOUNT_OWNER_CHANGED');
      detail.push(`${address} owner ${before.owner} → ${after.owner}`);
    }
    if (after.delegate !== null && after.delegate !== before.delegate) {
      reasons.push('DELEGATE_INTRODUCED');
      detail.push(`${address} delegate ${after.delegate}`);
    }
    if (after.closeAuthority !== null && after.closeAuthority !== before.closeAuthority) {
      reasons.push('CLOSE_AUTHORITY_INTRODUCED');
      detail.push(address);
    }
    if (after.frozen && !before.frozen) {
      reasons.push('ACCOUNT_FROZEN');
      detail.push(address);
    }
    perMint.set(before.mint, (perMint.get(before.mint) ?? 0n) + (after.amount - before.amount));
  }
  for (const [address, after] of post) {
    if (pre.has(address)) continue;
    if (after.owner === x.tradingWallet) {
      perMint.set(after.mint, (perMint.get(after.mint) ?? 0n) + after.amount);
      if (after.mint !== x.outputMint) unexpected.push(address);
    }
  }
  const inputDelta = perMint.get(x.inputMint) ?? 0n;
  const outputDelta = perMint.get(x.outputMint) ?? 0n;
  if (-inputDelta > BigInt(x.maxInputDecrease)) {
    reasons.push('INPUT_DECREASE_ABOVE_AUTHORIZED');
    detail.push(`input Δ ${inputDelta} vs max −${x.maxInputDecrease}`);
  }
  if (outputDelta < BigInt(x.minOutputIncrease)) {
    reasons.push('OUTPUT_INCREASE_BELOW_MINIMUM');
    detail.push(`output Δ ${outputDelta} < ${x.minOutputIncrease}`);
  }
  for (const [mint, d] of perMint) {
    if (mint !== x.inputMint && mint !== x.outputMint && d < 0n) {
      reasons.push('UNRELATED_TOKEN_DECREASE');
      detail.push(`${mint} Δ ${d}`);
    }
  }
  if (x.postWalletLamports === null) reasons.push('WALLET_STATE_MISSING');
  else {
    const solDebit = BigInt(x.preWalletLamports) - BigInt(x.postWalletLamports);
    if (solDebit > x.maxSolDebitLamports) {
      reasons.push('SOL_DEBIT_ABOVE_MODELED');
      detail.push(`SOL debit ${solDebit} > ${x.maxSolDebitLamports}`);
    }
  }
  const unique = [...new Set(reasons)];
  return {
    report: {
      rpcEndpointLabel: x.rpcLabel,
      slot: x.slot as Slot,
      passed: unique.length === 0,
      walletDeltas: [...perMint.entries()].map(([mint, delta]) => ({ mint: mint as MintAddress, delta: delta.toString() as SignedAmount })),
      unexpectedAccounts: unexpected as SolanaAddress[],
      logs: [...x.logs],
    },
    reasons: unique,
    detail,
  };
}
