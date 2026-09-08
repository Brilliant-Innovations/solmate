import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { fixedClock, sha256Hex, toInstant, type Uuid } from '@sol-agent-trader/contracts';
import { base58Decode } from '@sol-agent-trader/solana-hard-state';
import { SoftwareDevSigner, SoftwareDevSignerRefused } from './software-dev.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const ID = '11111111-1111-4111-8111-111111111111' as Uuid;

function throwawayKey(): { pkcs8Hex: string; publicRaw: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { pkcs8Hex: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'), publicRaw: new Uint8Array(spki.subarray(spki.length - 32)) };
}

describe('software development signer (D47, §15.4 deterministic signing)', () => {
  it('signs message bytes with the throwaway key, reports the matching public address, and returns the same signature for a retried identical request', async () => {
    const k = throwawayKey();
    const signer = new SoftwareDevSigner({ privateKeyPkcs8Hex: k.pkcs8Hex, cluster: 'devnet', liveCapabilityEnabled: false, clock: fixedClock(NOW) });
    expect(base58Decode(signer.publicKey)).toEqual(k.publicRaw);
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const request = { intentId: ID, attemptId: ID, messageHash: await sha256Hex(message) };
    const first = await signer.signTransactionMessage(message, request);
    expect(first.deduplicated).toBe(false);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.publicRaw)]), format: 'der', type: 'spki' });
    expect(verify(null, message, pub, Buffer.from(base58Decode(first.signature)))).toBe(true);
    const again = await signer.signTransactionMessage(message, request);
    expect(again).toEqual({ ...first, deduplicated: true });
    await expect(signer.signTransactionMessage(new Uint8Array([9]), request)).rejects.toThrow(SoftwareDevSignerRefused);
    expect(await signer.health()).toMatchObject({ backend: 'SOFTWARE_DEV', state: 'HEALTHY', policyDigest: null });
  });

  it('refuses to exist for live capability on mainnet, whatever the environment schema says', () => {
    const k = throwawayKey();
    expect(() => new SoftwareDevSigner({ privateKeyPkcs8Hex: k.pkcs8Hex, cluster: 'mainnet-beta', liveCapabilityEnabled: true, clock: fixedClock(NOW) })).toThrow(SoftwareDevSignerRefused);
    expect(() => new SoftwareDevSigner({ privateKeyPkcs8Hex: k.pkcs8Hex, cluster: 'mainnet-beta', liveCapabilityEnabled: false, clock: fixedClock(NOW) })).not.toThrow();
  });
});
