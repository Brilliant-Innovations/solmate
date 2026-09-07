import { randomUUID } from 'node:crypto';
import type { Clock, Slot, SolanaAddress, TxSignature, Uuid, WalletEvent } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { deriveWalletEvents, OwnedAddressRegistry, type HeliusClient } from '@sol-agent-trader/onchain';

/**
 * Worker role `tracked-wallets` (blueprint §3.2, §6.7, §9.3; D8, D26). Polls Helius parsed history
 * for every tracked wallet since its cursor, derives deterministic events, and appends them
 * idempotently. Owned wallets — flagged on the row or present in the owned-address registry —
 * are skipped outright so our own trades never become smart-money evidence (INV-11). Webhook
 * delivery reuses the same derivation once a public receiver exists (hosted profiles).
 */

export interface TrackedWalletsRepo {
  listTrackedWallets(): Promise<{ address: SolanaAddress; isOwned: boolean }[]>;
  listOwnedAddresses(): Promise<{ address: SolanaAddress }[]>;
  walletCursor(wallet: SolanaAddress): Promise<{ lastSignature: TxSignature | null; lastSlot: Slot | null } | null>;
  ingestWalletEvents(wallet: SolanaAddress, events: readonly WalletEvent[], cursor: { lastSignature: TxSignature; lastSlot: Slot } | null): Promise<number>;
}

export interface TrackedWalletsDeps {
  helius: HeliusClient;
  repo: TrackedWalletsRepo;
  clock: Clock;
  logger: Logger;
  config: { pageSize: number; maxPagesPerWallet: number };
}

export interface TrackedWalletsCycleReport {
  wallets: number;
  skippedOwned: number;
  transactions: number;
  parseFailures: number;
  events: number;
  inserted: number;
  errors: { wallet: SolanaAddress; error: string }[];
}

export async function runTrackedWalletsCycle(deps: TrackedWalletsDeps): Promise<TrackedWalletsCycleReport> {
  const report: TrackedWalletsCycleReport = { wallets: 0, skippedOwned: 0, transactions: 0, parseFailures: 0, events: 0, inserted: 0, errors: [] };
  const wallets = await deps.repo.listTrackedWallets();
  const owned = new OwnedAddressRegistry(await deps.repo.listOwnedAddresses());
  report.wallets = wallets.length;
  const isOwned = (a: string) => owned.isOwned(a) || (wallets.find((w) => w.address === a)?.isOwned ?? false);

  for (const w of wallets) {
    if (isOwned(w.address)) {
      report.skippedOwned++;
      continue;
    }
    try {
      const cursor = await deps.repo.walletCursor(w.address);
      let after = cursor?.lastSignature ?? null;
      let token: string | null = null;
      for (let page = 0; page < deps.config.maxPagesPerWallet; page++) {
        const { items, paginationToken } = await deps.helius.transactionHistory({ address: w.address, afterSignature: after, limit: deps.config.pageSize, paginationToken: token });
        if (items.length === 0) break;
        const events: WalletEvent[] = [];
        let newest: { lastSignature: TxSignature; lastSlot: Slot } | null = null;
        for (const it of items) {
          if (!it.ok) {
            report.parseFailures++;
            continue;
          }
          report.transactions++;
          newest = { lastSignature: it.facts.signature, lastSlot: it.facts.slot };
          events.push(...(await deriveWalletEvents(it.facts, { wallet: w.address, isOwned, source: 'HELIUS_POLL', now: deps.clock.now(), newId: () => randomUUID() as Uuid })));
        }
        report.events += events.length;
        report.inserted += await deps.repo.ingestWalletEvents(w.address, events, newest);
        if (!paginationToken || !newest) break;
        // Continue from the newest signature we processed; the token is a hint, the cursor is truth.
        after = newest.lastSignature;
        token = paginationToken;
      }
    } catch (err) {
      report.errors.push({ wallet: w.address, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('tracked_wallets_cycle', { wallets: report.wallets, skippedOwned: report.skippedOwned, transactions: report.transactions, parseFailures: report.parseFailures, events: report.events, inserted: report.inserted, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('tracked_wallets_wallet_failed', { wallet: e.wallet, error: e.error });
  return report;
}
