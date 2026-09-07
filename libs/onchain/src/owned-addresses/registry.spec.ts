import fc from 'fast-check';
import type { OwnedAddress } from '@sol-agent-trader/contracts';
import { OwnedAddressRegistry } from './registry.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = fc.string({ minLength: 32, maxLength: 44, unit: fc.constantFrom(...ALPHABET.split('')) });

describe('owned-address registry (D26, §8.6, INV-11)', () => {
  it('a flow touching an owned address on either side is never returned as external evidence', () => {
    fc.assert(
      fc.property(fc.uniqueArray(addr, { minLength: 1, maxLength: 5 }), fc.array(fc.record({ fromOwner: fc.option(addr, { nil: null }), toOwner: fc.option(addr, { nil: null }), amount: fc.nat() }), { maxLength: 30 }), addr, (owned, flows, extra) => {
        const registry = new OwnedAddressRegistry(owned);
        // Plant contaminated flows deterministically so the property has teeth.
        const planted = [...flows, { fromOwner: owned[0]!, toOwner: extra, amount: 1 }, { fromOwner: extra, toOwner: owned[owned.length - 1]!, amount: 2 }];
        const kept = registry.excludeFlows(planted);
        expect(kept.every((f) => !registry.isOwned(f.fromOwner) && !registry.isOwned(f.toOwner))).toBe(true);
        expect(kept.length).toBeLessThanOrEqual(planted.length - 2 + (owned.includes(extra) ? 0 : 0));
        expect(registry.touches(planted)).toBe(true);
      }),
    );
  });

  it('retired and active entries are both owned; unknown addresses are not', () => {
    const entries: OwnedAddress[] = [
      { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as never, purpose: 'TRADING_WALLET', cluster: 'mainnet-beta', accountId: null, registeredAt: '2026-09-07T00:00:00.000Z' as never, retiredAt: null },
      { address: 'DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ' as never, purpose: 'JUPITER_TRIGGER_VAULT', cluster: 'mainnet-beta', accountId: null, registeredAt: '2026-09-07T00:00:00.000Z' as never, retiredAt: '2026-09-07T01:00:00.000Z' as never },
    ];
    const registry = new OwnedAddressRegistry(entries);
    expect(registry.isOwned('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true);
    expect(registry.isOwned('DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ')).toBe(true);
    expect(registry.isOwned('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN')).toBe(false);
    expect(registry.isOwned(null)).toBe(false);
    expect(registry.excludeWallets([{ address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label: 'SMART_MONEY' }, { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', label: 'WHALE' }]).map((w) => w.label)).toEqual(['WHALE']);
  });
});
