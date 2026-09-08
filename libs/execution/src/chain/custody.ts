import type { MintAddress } from '@sol-agent-trader/contracts';
import type { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../validate/programs.js';

/**
 * Chain-confirmed custody of the trading wallet (D22 first bullet, §15.10A): what the wallet
 * actually holds right now, read from the node, never from a database row or a shadow. The
 * emergency path sells at most this.
 */

export interface Holding {
  mint: MintAddress;
  tokenAccount: string;
  amount: bigint;
  frozen: boolean;
  program: string;
}

export interface CustodyReader {
  holdings(owner: string): Promise<{ slot: number; holdings: Holding[] }>;
}

export class RpcCustodyReader implements CustodyReader {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async holdings(owner: string): Promise<{ slot: number; holdings: Holding[] }> {
    const out: Holding[] = [];
    let slot = 0;
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = await this.rpc.getTokenAccountsByOwner(owner, program);
      slot = Math.max(slot, r.context.slot);
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        if (info.owner !== owner) continue;
        out.push({ mint: info.mint as MintAddress, tokenAccount: a.pubkey, amount: BigInt(info.tokenAmount.amount), frozen: info.state === 'frozen', program });
      }
    }
    return { slot, holdings: out };
  }
}
