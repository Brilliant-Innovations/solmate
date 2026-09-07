import { base58Decode, base58Encode } from '../base58.js';
import { decodeMint, MintDecodeError } from './decode.js';

/**
 * Mint account fixtures are built byte-for-byte from the program layouts, so the decoder is
 * tested against the on-chain format, not against a library's opinion of it.
 */

const AUTH_A = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const AUTH_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const HOOK = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (8n * i)) & 0xffn));
  return out;
}
const pk = (s: string | null): number[] => (s ? [...base58Decode(s)] : new Array(32).fill(0));

function splMint(opts: { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: bigint; decimals?: number; initialized?: boolean } = {}): number[] {
  const ma = opts.mintAuthority ?? null;
  const fa = opts.freezeAuthority ?? null;
  return [...u32le(ma ? 1 : 0), ...pk(ma), ...u64le(opts.supply ?? 1_000_000n), opts.decimals ?? 6, opts.initialized === false ? 0 : 1, ...u32le(fa ? 1 : 0), ...pk(fa)];
}

function token2022Mint(base: number[], extensions: { type: number; value: number[] }[]): Uint8Array {
  const padded = [...base, ...new Array(165 - base.length).fill(0), 1];
  for (const e of extensions) padded.push(...u16le(e.type), ...u16le(e.value.length), ...e.value);
  return new Uint8Array(padded);
}

describe('base58', () => {
  it('round-trips public keys and preserves leading zeros', () => {
    for (const k of [AUTH_A, AUTH_B, HOOK, '11111111111111111111111111111111']) expect(base58Encode(base58Decode(k))).toBe(k);
    expect(base58Decode('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(() => base58Decode('0OIl')).toThrow(/invalid character/);
  });
});

describe('mint decoding (SPL Token and Token-2022 TLV)', () => {
  it('decodes a plain SPL mint with and without authorities', () => {
    const withAuth = decodeMint(new Uint8Array(splMint({ mintAuthority: AUTH_A, freezeAuthority: AUTH_B, supply: 42n, decimals: 9 })));
    expect(withAuth).toMatchObject({ isInitialized: true, decimals: 9, supply: 42n, mintAuthority: AUTH_A, freezeAuthority: AUTH_B, extensions: [], transferFeeBps: null, nonTransferable: false });
    const revoked = decodeMint(new Uint8Array(splMint({})));
    expect(revoked.mintAuthority).toBeNull();
    expect(revoked.freezeAuthority).toBeNull();
    expect(decodeMint(new Uint8Array(splMint({ initialized: false }))).isInitialized).toBe(false);
  });

  it('decodes Token-2022 extensions: transfer fee (conservative max), hook, permanent delegate, default frozen, non-transferable, pausable', () => {
    const transferFee = [
      ...pk(AUTH_A), ...pk(AUTH_B), ...u64le(0n),
      ...u64le(100n), ...u64le(5_000n), ...u16le(150), // older: epoch, maxFee, bps
      ...u64le(200n), ...u64le(7_000n), ...u16le(75), // newer
    ];
    const data = token2022Mint(splMint({}), [
      { type: 1, value: transferFee },
      { type: 14, value: [...pk(AUTH_A), ...pk(HOOK)] },
      { type: 12, value: pk(AUTH_B) },
      { type: 6, value: [2] },
      { type: 9, value: [] },
      { type: 3, value: pk(AUTH_A) },
      { type: 26, value: [...pk(AUTH_A), 1] },
      { type: 18, value: [...pk(AUTH_A), ...pk(AUTH_B)] },
    ]);
    const d = decodeMint(data);
    expect(d.extensions).toEqual(['TRANSFER_FEE_CONFIG', 'TRANSFER_HOOK', 'PERMANENT_DELEGATE', 'DEFAULT_ACCOUNT_STATE', 'NON_TRANSFERABLE', 'MINT_CLOSE_AUTHORITY', 'PAUSABLE', 'METADATA_POINTER']);
    expect(d.transferFeeBps).toBe(150);
    expect(d.maxTransferFee).toBe(7_000n);
    expect(d.transferHookProgram).toBe(HOOK);
    expect(d.permanentDelegate).toBe(AUTH_B);
    expect(d.defaultAccountFrozen).toBe(true);
    expect(d.nonTransferable).toBe(true);
    expect(d.mintCloseAuthority).toBe(true);
    expect(d.paused).toBe(true);
  });

  it('a hook extension whose program is the zero key means no hook; unknown extensions are reported, not ignored', () => {
    const d = decodeMint(token2022Mint(splMint({}), [{ type: 14, value: [...pk(AUTH_A), ...pk(null)] }, { type: 99, value: [1, 2, 3] }]));
    expect(d.transferHookProgram).toBeNull();
    expect(d.extensions).toEqual(['TRANSFER_HOOK', 'UNKNOWN']);
    expect(d.unknownExtensionTypes).toEqual([99]);
  });

  it('rejects truncated data, bad option tags, non-mint account types and overrunning extensions', () => {
    expect(() => decodeMint(new Uint8Array(10))).toThrow(MintDecodeError);
    const badTag = splMint({});
    badTag[0] = 7;
    expect(() => decodeMint(new Uint8Array(badTag))).toThrow(/COption/);
    const notMint = token2022Mint(splMint({}), []);
    notMint[165] = 2;
    expect(() => decodeMint(notMint)).toThrow(/not Mint/);
    const overrun = new Uint8Array([...token2022Mint(splMint({}), []), ...u16le(12), ...u16le(32), 1, 2, 3]);
    expect(() => decodeMint(overrun)).toThrow(/overruns/);
  });
});
