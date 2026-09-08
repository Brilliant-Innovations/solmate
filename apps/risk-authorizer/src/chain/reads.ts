import { type Amount, type Clock, type MintAddress, type Slot, type SolanaAddress, type Uuid } from '@sol-agent-trader/contracts';
import { MintNotFoundError, readMintChainState, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import type { IndependentChainReads } from '../projection/verify.js';
import type { MintHardState } from '../authorize/authorize.js';

/**
 * The authorizer's own chain reads (blueprint D45, D52, §15.3 step 7): wallet SOL, settlement
 * balance and per-custody-account token balances through the allowlisted read-only RPC, plus the
 * hard state of the mint about to be bought. Read-only by construction: `SolanaRpcClient` has a
 * closed method set and no signing surface.
 */

export interface CustodyRef {
  id: Uuid;
  address: SolanaAddress;
  mint: MintAddress | null;
}

export async function readIndependentChain(rpc: SolanaRpcClient, wallet: SolanaAddress, settlementMint: MintAddress, custody: readonly CustodyRef[]): Promise<IndependentChainReads> {
  const [slot, balance] = await Promise.all([rpc.getSlot(), rpc.getBalance(wallet)]);
  const byAddress = new Map<string, { mint: MintAddress; amount: bigint }>();
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await rpc.getTokenAccountsByOwner(wallet, program);
    for (const a of r.value) byAddress.set(a.pubkey, { mint: a.account.data.parsed.info.mint as MintAddress, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) });
  }
  let settlement = 0n;
  for (const v of byAddress.values()) if (v.mint === settlementMint) settlement += v.amount;
  const custodyReads: IndependentChainReads['custody'] = [];
  for (const c of custody) {
    const held = byAddress.get(c.address);
    if (held) custodyReads.push({ custodyAccountId: c.id, mint: held.mint, amount: held.amount.toString() as Amount });
    else if (c.mint) custodyReads.push({ custodyAccountId: c.id, mint: c.mint, amount: '0' as Amount });
  }
  return { slot: slot as Slot, settlementBaseUnits: settlement.toString() as Amount, gasLamports: String(balance.value) as Amount, custody: custodyReads };
}

export async function readMintHardState(rpc: SolanaRpcClient, mint: MintAddress, clock: Clock): Promise<MintHardState> {
  try {
    const s = await readMintChainState(rpc, mint, clock);
    return { isInitialized: s.isInitialized, mintAuthority: s.mintAuthority, freezeAuthority: s.freezeAuthority, readSlot: s.slot };
  } catch (err) {
    if (err instanceof MintNotFoundError) return { isInitialized: false, mintAuthority: 'UNKNOWN', freezeAuthority: 'UNKNOWN', readSlot: 0 };
    throw err;
  }
}
