import type { Token2022Extension } from '@sol-agent-trader/contracts';
import { base58Encode } from '../base58.js';

/**
 * Decoders for SPL Token and Token-2022 mint accounts from raw bytes (blueprint §7.1A, D45).
 * Layouts follow the on-chain programs:
 *   Mint (82 bytes): mint_authority COption<Pubkey> (4+32) | supply u64 | decimals u8 |
 *                    is_initialized u8 | freeze_authority COption<Pubkey> (4+32)
 *   Token-2022 appends padding to 165 bytes, an account-type byte (1 = Mint) at 165, then TLV
 *   extensions from 166: type u16 LE | length u16 LE | value.
 */

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const MINT_BASE_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;

/** Token-2022 ExtensionType discriminants. */
const EXTENSION_TYPES: Readonly<Record<number, Token2022Extension>> = {
  1: 'TRANSFER_FEE_CONFIG',
  3: 'MINT_CLOSE_AUTHORITY',
  4: 'CONFIDENTIAL_TRANSFER_MINT',
  6: 'DEFAULT_ACCOUNT_STATE',
  9: 'NON_TRANSFERABLE',
  10: 'INTEREST_BEARING_CONFIG',
  12: 'PERMANENT_DELEGATE',
  14: 'TRANSFER_HOOK',
  16: 'CONFIDENTIAL_TRANSFER_FEE_CONFIG',
  18: 'METADATA_POINTER',
  19: 'TOKEN_METADATA',
  20: 'GROUP_POINTER',
  21: 'TOKEN_GROUP',
  22: 'GROUP_MEMBER_POINTER',
  23: 'TOKEN_GROUP_MEMBER',
  24: 'CONFIDENTIAL_MINT_BURN',
  25: 'SCALED_UI_AMOUNT',
  26: 'PAUSABLE',
};

export interface DecodedMint {
  isInitialized: boolean;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: Token2022Extension[];
  unknownExtensionTypes: number[];
  transferFeeBps: number | null;
  maxTransferFee: bigint | null;
  transferHookProgram: string | null;
  permanentDelegate: string | null;
  defaultAccountFrozen: boolean;
  nonTransferable: boolean;
  mintCloseAuthority: boolean;
  paused: boolean;
}

export class MintDecodeError extends Error {
  constructor(message: string) {
    super(`mint decode: ${message}`);
    this.name = 'MintDecodeError';
  }
}

const ZERO_PUBKEY = new Uint8Array(32);
function pubkey(bytes: Uint8Array, offset: number): string {
  return base58Encode(bytes.subarray(offset, offset + 32));
}
function isZero(bytes: Uint8Array, offset: number): boolean {
  return bytes.subarray(offset, offset + 32).every((b, i) => b === ZERO_PUBKEY[i]);
}
function u16(v: DataView, o: number): number {
  return v.getUint16(o, true);
}
function u64(v: DataView, o: number): bigint {
  return v.getBigUint64(o, true);
}

export function decodeMint(data: Uint8Array): DecodedMint {
  if (data.length < MINT_BASE_LEN) throw new MintDecodeError(`account data too short (${data.length} bytes)`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mintAuthOpt = view.getUint32(0, true);
  const freezeAuthOpt = view.getUint32(46, true);
  if (mintAuthOpt > 1 || freezeAuthOpt > 1) throw new MintDecodeError('invalid COption tag');
  const out: DecodedMint = {
    isInitialized: data[45] === 1,
    decimals: data[44] as number,
    supply: u64(view, 36),
    mintAuthority: mintAuthOpt === 1 ? pubkey(data, 4) : null,
    freezeAuthority: freezeAuthOpt === 1 ? pubkey(data, 50) : null,
    extensions: [],
    unknownExtensionTypes: [],
    transferFeeBps: null,
    maxTransferFee: null,
    transferHookProgram: null,
    permanentDelegate: null,
    defaultAccountFrozen: false,
    nonTransferable: false,
    mintCloseAuthority: false,
    paused: false,
  };
  if (data.length === MINT_BASE_LEN) return out;
  if (data.length <= ACCOUNT_TYPE_OFFSET) throw new MintDecodeError(`unexpected length ${data.length}`);
  if (data[ACCOUNT_TYPE_OFFSET] !== 1) throw new MintDecodeError(`account type ${data[ACCOUNT_TYPE_OFFSET]} is not Mint`);

  let o = TLV_START;
  while (o + 4 <= data.length) {
    const type = u16(view, o);
    const len = u16(view, o + 2);
    const start = o + 4;
    const end = start + len;
    if (type === 0) break; // Uninitialized: padding
    if (end > data.length) throw new MintDecodeError(`extension ${type} overruns account data`);
    const name = EXTENSION_TYPES[type];
    if (!name) {
      out.unknownExtensionTypes.push(type);
      if (!out.extensions.includes('UNKNOWN')) out.extensions.push('UNKNOWN');
    } else {
      out.extensions.push(name);
      switch (name) {
        case 'TRANSFER_FEE_CONFIG': {
          // authority 32 | withdraw authority 32 | withheld u64 | older {epoch u64, maxFee u64, bps u16} | newer {...}
          if (len < 108) throw new MintDecodeError('TransferFeeConfig too short');
          const olderBps = u16(view, start + 72 + 16);
          const olderMax = u64(view, start + 72 + 8);
          const newerBps = u16(view, start + 90 + 16);
          const newerMax = u64(view, start + 90 + 8);
          out.transferFeeBps = Math.max(olderBps, newerBps);
          out.maxTransferFee = olderMax > newerMax ? olderMax : newerMax;
          break;
        }
        case 'TRANSFER_HOOK': {
          if (len < 64) throw new MintDecodeError('TransferHook too short');
          out.transferHookProgram = isZero(data, start + 32) ? null : pubkey(data, start + 32);
          break;
        }
        case 'PERMANENT_DELEGATE': {
          if (len < 32) throw new MintDecodeError('PermanentDelegate too short');
          out.permanentDelegate = isZero(data, start) ? null : pubkey(data, start);
          break;
        }
        case 'DEFAULT_ACCOUNT_STATE':
          out.defaultAccountFrozen = data[start] === 2;
          break;
        case 'NON_TRANSFERABLE':
          out.nonTransferable = true;
          break;
        case 'MINT_CLOSE_AUTHORITY':
          out.mintCloseAuthority = len >= 32 && !isZero(data, start);
          break;
        case 'PAUSABLE':
          out.paused = len >= 33 && data[start + 32] === 1;
          break;
        default:
          break;
      }
    }
    o = end;
  }
  return out;
}
