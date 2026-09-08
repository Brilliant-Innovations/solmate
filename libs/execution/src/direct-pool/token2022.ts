import { ByteReader } from './bytes.js';
import type { RawAccount } from './types.js';

/**
 * Token-2022 mint extensions that change what a swap actually moves (§14.6 "Token-2022
 * compatibility"). A mint account is the 82-byte legacy layout, padding to 165, one account-type
 * byte (1 = mint) and then TLV entries (u16 type, u16 length, value). Only the transfer fee is
 * modelled: the program takes it from the input before the swap and from the output after it. A
 * transfer hook needs extra accounts the emergency path does not carry, so it is reported and
 * the route stays unsupported until the hook's accounts are part of the snapshot.
 */

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ACCOUNT_TYPE_OFFSET = 165;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;
const EXT_NON_TRANSFERABLE = 6;
const EXT_PAUSABLE = 22;

export interface TransferFee {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}

export interface MintExtensions {
  /** Present when the mint charges a transfer fee; `older` and `newer` are epoch-scheduled. */
  transferFee: { older: TransferFee; newer: TransferFee } | null;
  transferHook: boolean;
  nonTransferable: boolean;
  pausable: boolean;
  extensionTypes: number[];
}

const NONE: MintExtensions = { transferFee: null, transferHook: false, nonTransferable: false, pausable: false, extensionTypes: [] };

export function decodeMintExtensions(mint: RawAccount | null): MintExtensions {
  if (!mint || mint.owner !== TOKEN_2022_PROGRAM_ID || mint.data.length <= ACCOUNT_TYPE_OFFSET + 1) return NONE;
  if (mint.data[ACCOUNT_TYPE_OFFSET] !== 1) return NONE;
  const r = new ByteReader(mint.data).seek(ACCOUNT_TYPE_OFFSET + 1);
  const out: MintExtensions = { ...NONE, extensionTypes: [] };
  while (r.offset + 4 <= mint.data.length) {
    const type = r.u16();
    const length = r.u16();
    if (type === 0 && length === 0) break;
    const start = r.offset;
    out.extensionTypes.push(type);
    if (type === EXT_TRANSFER_FEE_CONFIG && length >= 108) {
      const f = new ByteReader(mint.data).seek(start + 32 + 32 + 8);
      const older: TransferFee = { epoch: f.u64(), maximumFee: f.u64(), basisPoints: f.u16() };
      const newer: TransferFee = { epoch: f.u64(), maximumFee: f.u64(), basisPoints: f.u16() };
      out.transferFee = { older, newer };
    }
    if (type === EXT_TRANSFER_HOOK) out.transferHook = true;
    if (type === EXT_NON_TRANSFERABLE) out.nonTransferable = true;
    if (type === EXT_PAUSABLE) out.pausable = true;
    r.seek(start + length);
  }
  return out;
}

/** The fee schedule in force: the newer one once its epoch has arrived; without an epoch, the higher of the two (conservative for a quote). */
export function activeTransferFee(ext: MintExtensions, epoch: bigint | null): TransferFee | null {
  if (!ext.transferFee) return null;
  const { older, newer } = ext.transferFee;
  if (epoch === null) return newer.basisPoints >= older.basisPoints ? newer : older;
  return epoch >= newer.epoch ? newer : older;
}

/** Fee the token program withholds when `amount` moves; zero without a fee. Rounds up as the program does and caps at maximumFee. */
export function transferFeeAmount(fee: TransferFee | null, amount: bigint): bigint {
  if (!fee || fee.basisPoints === 0 || amount <= 0n) return 0n;
  const raw = (amount * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  return raw > fee.maximumFee ? fee.maximumFee : raw;
}
