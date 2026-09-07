import type { OwnedAddress, SolanaAddress } from '@sol-agent-trader/contracts';

/**
 * Owned-address registry (blueprint D26, §8.6; INV-11). Every application-controlled address —
 * trading wallets, their token accounts, registered provider vaults, the cold-recovery wallet,
 * operator funding sources — is owned. A retired address stays owned: history must keep excluding
 * it. The registry is a pure value; the worker builds it from intelligence.owned_addresses and
 * trading.custody_accounts on every cycle.
 */
export class OwnedAddressRegistry {
  private readonly owned = new Set<string>();

  constructor(entries: Iterable<Pick<OwnedAddress, 'address'> | string>) {
    for (const e of entries) this.owned.add(typeof e === 'string' ? e : e.address);
  }

  isOwned(address: string | null | undefined): boolean {
    return address != null && this.owned.has(address);
  }

  get size(): number {
    return this.owned.size;
  }

  addresses(): SolanaAddress[] {
    return [...this.owned] as SolanaAddress[];
  }

  /** Flows with an owned endpoint on either side never count as external evidence (§8.6). */
  excludeFlows<T extends { fromOwner: string | null; toOwner: string | null }>(flows: readonly T[]): T[] {
    return flows.filter((f) => !this.isOwned(f.fromOwner) && !this.isOwned(f.toOwner));
  }

  /** Tracked-wallet rows for owned addresses are never smart money, whatever their label says. */
  excludeWallets<T extends { address: string }>(wallets: readonly T[]): T[] {
    return wallets.filter((w) => !this.isOwned(w.address));
  }

  /** True when any endpoint of any flow is owned: the evidence set is contaminated. */
  touches(flows: readonly { fromOwner: string | null; toOwner: string | null }[]): boolean {
    return flows.some((f) => this.isOwned(f.fromOwner) || this.isOwned(f.toOwner));
  }
}
