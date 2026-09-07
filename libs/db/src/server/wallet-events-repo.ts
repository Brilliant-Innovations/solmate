import type { Instant, Slot, SolanaAddress, TrackedWallet, TxSignature, WalletEvent } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/** Tracked-wallet persistence (§6.7, §3.2). Events are appended through intelligence.ingest_wallet_events(). */

export interface TrackedWalletRow {
  address: SolanaAddress;
  discoverySource: string;
  isOwned: boolean;
}

/** Wallets whose polling is switched on; paused wallets keep their immutable history (§6.7). */
export async function listTrackedWallets(sql: Sql): Promise<TrackedWalletRow[]> {
  const rows = await sql<{ address: string; discovery_source: string; is_owned: boolean }[]>`
    select address, discovery_source, is_owned from intelligence.wallets where tracking_active order by first_seen_at asc`;
  return rows.map((r) => ({ address: r.address as SolanaAddress, discoverySource: r.discovery_source, isOwned: r.is_owned }));
}

/** Idempotent registration; labels are evidence with provenance and are only added here, never rewritten. */
export async function registerTrackedWallet(sql: Sql, w: { address: SolanaAddress; discoverySource: string; labels: TrackedWallet['labels']; isOwned: boolean; firstSeenAt: Instant }): Promise<void> {
  await sql`
    insert into intelligence.wallets (address, discovery_source, labels, is_owned, first_seen_at)
    values (${w.address}, ${w.discoverySource}, ${sql.json(asJson(w.labels))}, ${w.isOwned}, ${w.firstSeenAt})
    on conflict (address) do update set is_owned = intelligence.wallets.is_owned or excluded.is_owned`;
}

export async function setWalletTracking(sql: Sql, wallet: SolanaAddress, active: boolean): Promise<void> {
  await sql`update intelligence.wallets set tracking_active = ${active} where address = ${wallet}`;
}

export async function walletCursor(sql: Sql, wallet: SolanaAddress): Promise<{ lastSignature: TxSignature | null; lastSlot: Slot | null } | null> {
  const [r] = await sql<{ last_signature: string | null; last_slot: string | number | null }[]>`
    select last_signature, last_slot from intelligence.wallet_cursors where wallet = ${wallet}`;
  return r ? { lastSignature: r.last_signature as TxSignature | null, lastSlot: r.last_slot === null ? null : (Number(r.last_slot) as Slot) } : null;
}

/** Appends events (duplicates ignored) and moves the cursor; returns the number actually inserted. */
export async function ingestWalletEvents(sql: Sql, wallet: SolanaAddress, events: readonly WalletEvent[], cursor: { lastSignature: TxSignature; lastSlot: Slot } | null): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select intelligence.ingest_wallet_events(${wallet}, ${sql.json(asJson(events))}, ${cursor ? sql.json(asJson(cursor)) : null}) as n`;
  return Number(r?.n ?? 0);
}
