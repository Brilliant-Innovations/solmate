import type { DiscoveredToken, DiscoverySource } from '@sol-agent-trader/contracts';

/**
 * Discovery universe merge (blueprint §7.1). Several sources report overlapping tokens; the
 * universe is keyed by mint, never by symbol. When sources disagree, the record keeps the source
 * with the highest evidence priority for identity and the maximum liquidity seen, and never fills
 * a null from one source with a zero from another.
 */
const SOURCE_PRIORITY: Readonly<Record<DiscoverySource, number>> = { MANUAL: 0, BIRDEYE_TRENDING: 1, BIRDEYE_NEW_LISTING: 2, BIRDEYE_TOKEN_LIST: 3 };

const pickNonNull = <T>(a: T | null, b: T | null): T | null => (a !== null ? a : b);
const maxNonNull = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export function mergeDiscovery(batches: readonly (readonly DiscoveredToken[])[]): DiscoveredToken[] {
  const byMint = new Map<string, DiscoveredToken>();
  for (const batch of batches) {
    for (const t of batch) {
      const prev = byMint.get(t.mintAddress);
      if (!prev) {
        byMint.set(t.mintAddress, t);
        continue;
      }
      const primary = SOURCE_PRIORITY[t.source] < SOURCE_PRIORITY[prev.source] ? t : prev;
      const secondary = primary === t ? prev : t;
      byMint.set(t.mintAddress, {
        ...primary,
        rank: pickNonNull(primary.rank, secondary.rank),
        liquidityUsd: maxNonNull(primary.liquidityUsd, secondary.liquidityUsd),
        volume24hUsd: maxNonNull(primary.volume24hUsd, secondary.volume24hUsd),
        priceUsd: pickNonNull(primary.priceUsd, secondary.priceUsd),
        marketCapUsd: pickNonNull(primary.marketCapUsd, secondary.marketCapUsd),
        listedAt: pickNonNull(primary.listedAt, secondary.listedAt),
        providerUpdatedAt: pickNonNull(primary.providerUpdatedAt, secondary.providerUpdatedAt),
      });
    }
  }
  return [...byMint.values()].sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || a.mintAddress.localeCompare(b.mintAddress));
}
