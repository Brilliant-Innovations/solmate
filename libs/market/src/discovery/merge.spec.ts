import { toInstant, type DiscoveredToken } from '@sol-agent-trader/contracts';
import { mergeDiscovery } from './merge.js';

const NOW = toInstant(Date.UTC(2026, 8, 6, 12, 0, 0));
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as DiscoveredToken['mintAddress'];
const tok = (over: Partial<DiscoveredToken>): DiscoveredToken => ({
  mintAddress: MINT, symbol: 'X', name: 'X', decimals: 6, source: 'BIRDEYE_TOKEN_LIST', rank: null, liquidityUsd: null, volume24hUsd: null, priceUsd: null, marketCapUsd: null, listedAt: null, providerUpdatedAt: null, observedAt: NOW, ...over,
});

describe('discovery merge (§7.1, identity by mint)', () => {
  it('dedupes by mint, keeps the highest-priority source identity, max liquidity and never fills null with zero', () => {
    const merged = mergeDiscovery([
      [tok({ source: 'BIRDEYE_TOKEN_LIST', liquidityUsd: 500, symbol: 'OLD', priceUsd: 2 })],
      [tok({ source: 'BIRDEYE_TRENDING', liquidityUsd: 300, symbol: 'NEW', rank: 4, priceUsd: null })],
      [tok({ source: 'BIRDEYE_NEW_LISTING', liquidityUsd: null, listedAt: NOW })],
    ]);
    expect(merged).toHaveLength(1);
    // Identity from TRENDING (highest priority), liquidity = max, price/listedAt filled from the sources that had them.
    expect(merged[0]).toMatchObject({ source: 'BIRDEYE_TRENDING', symbol: 'NEW', rank: 4, liquidityUsd: 500, priceUsd: 2, listedAt: NOW });
    const zeroed = mergeDiscovery([[tok({ liquidityUsd: null, priceUsd: null })], [tok({ source: 'BIRDEYE_TRENDING', liquidityUsd: null, priceUsd: null })]]);
    expect(zeroed[0]).toMatchObject({ liquidityUsd: null, priceUsd: null });
  });

  it('sorts by liquidity descending with unknown liquidity last', () => {
    const a = tok({ mintAddress: 'So11111111111111111111111111111111111111112' as never, liquidityUsd: 10 });
    const b = tok({ liquidityUsd: null });
    const c = tok({ mintAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as never, liquidityUsd: 99 });
    expect(mergeDiscovery([[a, b, c]]).map((t) => t.liquidityUsd)).toEqual([99, 10, null]);
  });
});
