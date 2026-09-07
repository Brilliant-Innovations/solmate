import type { Amount, Clock, MintAddress, MintChainState, SolanaAddress, TokenProgram } from '@sol-agent-trader/contracts';
import { RpcError, type SolanaRpcClient } from '../rpc/client.js';
import { decodeMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './decode.js';

/**
 * Reads the hard security state of a mint from chain (blueprint §7.1A, D45): program ownership,
 * authorities, Token-2022 extensions, supply and the largest token accounts. Three RPC reads at
 * the same commitment; the reported slot is the lowest of the three so downstream freshness never
 * overstates what was seen. No analytics input touches this function.
 */

export class MintNotFoundError extends Error {
  constructor(readonly mint: string) {
    super(`mint account ${mint} not found`);
    this.name = 'MintNotFoundError';
  }
}

function programOf(owner: string): TokenProgram {
  if (owner === TOKEN_PROGRAM_ID) return 'TOKEN';
  if (owner === TOKEN_2022_PROGRAM_ID) return 'TOKEN_2022';
  return 'UNKNOWN';
}

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

function parsedOwner(v: { data: unknown } | null): string | null {
  const info = (v?.data as { parsed?: { info?: { owner?: unknown } } } | undefined)?.parsed?.info;
  return typeof info?.owner === 'string' ? info.owner : null;
}

/**
 * Which of the largest token accounts are program-controlled (D45 "direct largest-token-account
 * balances" are raw; holder concentration must not count a DEX pool vault or a staking vault as a
 * holder). An account whose owner does not exist on chain (a PDA authority) or whose owner is not a
 * plain system account is program-controlled. Returns null when the classification reads fail, in
 * which case the caller reports raw figures and says so.
 */
async function programControlled(rpc: SolanaRpcClient, accounts: readonly { address: SolanaAddress }[]): Promise<Set<string> | null> {
  if (accounts.length === 0) return new Set();
  try {
    const parsed = await rpc.getMultipleAccountsParsed(accounts.map((a) => a.address));
    const owners = parsed.value.map(parsedOwner);
    const distinct = [...new Set(owners.filter((o): o is string => o !== null))];
    const ownerInfos = distinct.length > 0 ? await rpc.getMultipleAccountsParsed(distinct) : { value: [] };
    const wallet = new Set(distinct.filter((_, i) => {
      const v = ownerInfos.value[i];
      return v !== null && v !== undefined && !v.executable && v.owner === SYSTEM_PROGRAM_ID;
    }));
    const excluded = new Set<string>();
    accounts.forEach((a, i) => {
      const owner = owners[i] ?? null;
      if (owner === null || !wallet.has(owner)) excluded.add(a.address);
    });
    return excluded;
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    return null;
  }
}

function fraction(sum: bigint, supply: bigint): number {
  if (supply === 0n) return 0;
  // Two-decimal-place precision is plenty for policy and keeps the division in safe integer range.
  return Number((sum * 10_000n) / supply) / 10_000;
}

export async function readMintChainState(rpc: SolanaRpcClient, mintAddress: MintAddress, clock: Clock): Promise<MintChainState> {
  const info = await rpc.getAccountInfo(mintAddress);
  if (!info.value) throw new MintNotFoundError(mintAddress);
  const tokenProgram = programOf(info.value.owner);
  const decoded = decodeMint(new Uint8Array(Buffer.from(info.value.data[0], 'base64')));

  const supplyRes = await rpc.getTokenSupply(mintAddress);
  const supply = BigInt(supplyRes.value.amount);

  // Public endpoints restrict getTokenLargestAccounts; its absence must not hide the authoritative
  // facts already read. Concentration is then reported as unknown, never as zero.
  let largestRes: Awaited<ReturnType<SolanaRpcClient['getTokenLargestAccounts']>> | null = null;
  let concentrationUnavailableReason: string | null = null;
  try {
    largestRes = await rpc.getTokenLargestAccounts(mintAddress);
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    concentrationUnavailableReason = err.message.slice(0, 256);
  }
  const largest = (largestRes?.value ?? []).map((a) => ({ address: a.address as SolanaAddress, amount: a.amount as Amount }));
  const excluded = largestRes ? await programControlled(rpc, largest) : null;
  const holders = excluded ? largest.filter((a) => !excluded.has(a.address)) : largest;
  const sumTop = (n: number): bigint => holders.slice(0, n).reduce((acc, a) => acc + BigInt(a.amount), 0n);
  const excludedSum = excluded ? largest.filter((a) => excluded.has(a.address)).reduce((acc, a) => acc + BigInt(a.amount), 0n) : 0n;
  const slot = Math.min(info.context.slot, supplyRes.context.slot, largestRes?.context.slot ?? Number.MAX_SAFE_INTEGER);

  return {
    mintAddress,
    readAt: clock.now(),
    slot: slot as MintChainState['slot'],
    programId: info.value.owner as SolanaAddress,
    tokenProgram,
    isInitialized: decoded.isInitialized,
    decimals: decoded.decimals,
    supply: supply.toString() as Amount,
    mintAuthority: decoded.mintAuthority ? 'PRESENT' : 'NONE',
    freezeAuthority: decoded.freezeAuthority ? 'PRESENT' : 'NONE',
    extensions: decoded.extensions,
    transferFeeBps: decoded.transferFeeBps as MintChainState['transferFeeBps'],
    maxTransferFee: decoded.maxTransferFee === null ? null : (decoded.maxTransferFee.toString() as Amount),
    transferHookProgram: decoded.transferHookProgram as SolanaAddress | null,
    permanentDelegate: decoded.permanentDelegate as SolanaAddress | null,
    defaultAccountFrozen: decoded.defaultAccountFrozen,
    nonTransferable: decoded.nonTransferable,
    mintCloseAuthority: decoded.mintCloseAuthority,
    paused: decoded.paused,
    largestAccounts: largest,
    concentration: largestRes
      ? {
          source: 'CHAIN',
          chainSlot: slot as MintChainState['slot'],
          top1: fraction(sumTop(1), supply),
          top5: fraction(sumTop(5), supply),
          top10: fraction(sumTop(10), supply),
          top20: fraction(sumTop(20), supply),
          analyticsMismatch: false,
          programControlledFraction: excluded ? fraction(excludedSum, supply) : null,
          excludedAccounts: excluded ? excluded.size : null,
        }
      : null,
    concentrationUnavailableReason,
  };
}
