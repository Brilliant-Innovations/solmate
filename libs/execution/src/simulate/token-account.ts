import { base58Encode } from '@sol-agent-trader/solana-hard-state';

/**
 * SPL token account decoder (Token and Token-2022 share the first 165 bytes). Used to read
 * pre- and post-simulation balances of wallet-owned token accounts without a token SDK.
 */
export interface DecodedTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
  state: 'UNINITIALIZED' | 'INITIALIZED' | 'FROZEN';
  isNative: boolean;
  closeAuthority: string | null;
}

const MIN_LEN = 165;

export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount {
  if (data.length < MIN_LEN) throw new RangeError(`token account data too short: ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (o: number) => view.getUint32(o, true);
  const u64 = (o: number) => view.getBigUint64(o, true);
  const key = (o: number) => base58Encode(data.subarray(o, o + 32));
  const stateByte = data[108]!;
  return {
    mint: key(0),
    owner: key(32),
    amount: u64(64),
    delegate: u32(72) === 1 ? key(76) : null,
    state: stateByte === 0 ? 'UNINITIALIZED' : stateByte === 1 ? 'INITIALIZED' : 'FROZEN',
    isNative: u32(109) === 1,
    delegatedAmount: u64(121),
    closeAuthority: u32(129) === 1 ? key(133) : null,
  };
}
