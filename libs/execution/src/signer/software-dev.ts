import { createPrivateKey, createPublicKey, sign as nodeSign, type KeyObject } from 'node:crypto';
import { sha256Hex, type Clock, type SignatureResult, type SignerHealth, type SigningRequest, type SolanaAddress, type SolanaCluster, type TradingWalletSigner, type TxSignature } from '@sol-agent-trader/contracts';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';

/**
 * Software development signer (blueprint D47; GUARDRAILS ground rule 5). Holds a throwaway Ed25519
 * key for devnet/localnet paper and harness work. It refuses to exist for live capability on
 * mainnet at construction time, in addition to the environment schema's refusal, so no code path
 * can pair it with real capital. Signatures are deterministic; a retry with the same message
 * bytes returns the same signature and is reported as deduplicated.
 */
export class SoftwareDevSignerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoftwareDevSignerRefused';
  }
}

export interface SoftwareDevSignerOptions {
  /** PKCS#8 DER of the Ed25519 private key, hex-encoded (the same shape the projection signing keys use). */
  privateKeyPkcs8Hex: string;
  cluster: SolanaCluster;
  liveCapabilityEnabled: boolean;
  clock: Clock;
}

export class SoftwareDevSigner implements TradingWalletSigner {
  readonly backend = 'SOFTWARE_DEV' as const;
  readonly publicKey: SolanaAddress;
  private readonly key: KeyObject;
  private readonly seen = new Map<string, TxSignature>();

  constructor(private readonly opts: SoftwareDevSignerOptions) {
    if (opts.cluster === 'mainnet-beta' && opts.liveCapabilityEnabled) throw new SoftwareDevSignerRefused('SOFTWARE_DEV signer cannot serve live capability on mainnet-beta (D47)');
    this.key = createPrivateKey({ key: Buffer.from(opts.privateKeyPkcs8Hex, 'hex'), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(this.key).export({ format: 'der', type: 'spki' });
    this.publicKey = base58Encode(new Uint8Array(spki.subarray(spki.length - 32))) as SolanaAddress;
  }

  async signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult> {
    const hash = await sha256Hex(messageBytes);
    if (hash !== request.messageHash) throw new SoftwareDevSignerRefused(`message hash ${hash} does not match the request ${request.messageHash}`);
    const known = this.seen.get(request.messageHash);
    const sig = known ?? (base58Encode(new Uint8Array(nodeSign(null, messageBytes, this.key))) as TxSignature);
    this.seen.set(request.messageHash, sig);
    return { signature: sig, signer: this.publicKey, signedAt: this.opts.clock.now(), deduplicated: known !== undefined };
  }

  async health(): Promise<SignerHealth> {
    return { backend: 'SOFTWARE_DEV', state: 'HEALTHY', checkedAt: this.opts.clock.now(), latencyMs: 0, policyDigest: null, detail: 'development signer: no external policy layer (D55 does not apply below live capability)' };
  }
}
