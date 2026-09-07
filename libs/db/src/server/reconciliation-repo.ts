import type { Amount, CustodyKind, CustodyReconciliation, Instant, MintAddress, OwnedAddress, Slot, SolanaAddress, SolanaCluster, TransactionClass, TxSignature, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Persistence for chain/custody reconciliation and the owned-address registry (blueprint D9, D26,
 * §6.17). Reports go through trading.record_reconciliation(), which pauses running sessions in the
 * same transaction when the report is a MISMATCH. Nothing here decides; the engine in libs/onchain does.
 */

export interface TradingAccountRow {
  id: Uuid;
  name: string;
  cluster: SolanaCluster;
  tradingWallet: SolanaAddress;
  settlementMint: MintAddress;
}

export async function listTradingAccounts(sql: Sql): Promise<TradingAccountRow[]> {
  const rows = await sql<{ id: string; name: string; cluster: SolanaCluster; trading_wallet: string; settlement_mint: string }[]>`
    select id, name, cluster, trading_wallet, settlement_mint from trading.accounts order by created_at asc`;
  return rows.map((r) => ({ id: r.id as Uuid, name: r.name, cluster: r.cluster, tradingWallet: r.trading_wallet as SolanaAddress, settlementMint: r.settlement_mint as MintAddress }));
}

export interface CustodyRow {
  id: Uuid;
  address: SolanaAddress;
  kind: CustodyKind;
  mint: MintAddress | null;
  allowedMovementTypes: TransactionClass[];
  active: boolean;
}

/** Registered custody for one account; `active` folds active dates and verification state. */
export async function listCustodyAccounts(sql: Sql, accountId: Uuid, now: Instant): Promise<CustodyRow[]> {
  const rows = await sql<{ id: string; address: string; kind: CustodyKind; mint: string | null; allowed_movement_types: TransactionClass[]; active: boolean }[]>`
    select id, address, kind, mint, allowed_movement_types,
      (verification_state = 'VERIFIED' and active_from <= ${now}::timestamptz and (active_to is null or active_to > ${now}::timestamptz)) as active
    from trading.custody_accounts where account_id = ${accountId} order by active_from asc`;
  return rows.map((r) => ({ id: r.id as Uuid, address: r.address as SolanaAddress, kind: r.kind, mint: r.mint as MintAddress | null, allowedMovementTypes: r.allowed_movement_types, active: r.active }));
}

/** Open-position quantity per mint: what the chain must hold for this account. */
export async function ledgerExpectations(sql: Sql, accountId: Uuid): Promise<{ mint: MintAddress; expected: Amount }[]> {
  const rows = await sql<{ mint: string; expected: string }[]>`
    select mint, sum(quantity)::text as expected from trading.positions where account_id = ${accountId} and status <> 'CLOSED' group by mint order by mint`;
  return rows.map((r) => ({ mint: r.mint as MintAddress, expected: r.expected as Amount }));
}

export async function reconciliationCursor(sql: Sql, accountId: Uuid): Promise<{ lastSignature: TxSignature | null; lastSlot: Slot | null; solLamports: Amount | null } | null> {
  const [r] = await sql<{ last_signature: string | null; last_slot: string | number | null; sol_lamports: string | null }[]>`
    select last_signature, last_slot, sol_lamports from trading.reconciliation_cursors where account_id = ${accountId}`;
  if (!r) return null;
  return { lastSignature: r.last_signature as TxSignature | null, lastSlot: r.last_slot === null ? null : (Number(r.last_slot) as Slot), solLamports: r.sol_lamports as Amount | null };
}

/** The authorized lifecycle a landed signature belongs to, if any (§6.18 order attempts). */
export async function lifecycleForSignature(sql: Sql, signature: TxSignature): Promise<{ lifecycleId: Uuid; movementType: TransactionClass } | null> {
  const [r] = await sql<{ intent_id: string; transaction_class: TransactionClass }[]>`
    select oa.intent_id, o.transaction_class from trading.order_attempts oa join trading.orders o on o.id = oa.order_id
    where oa.wallet_signature = ${signature} or oa.expected_tx_signature = ${signature} limit 1`;
  return r ? { lifecycleId: r.intent_id as Uuid, movementType: r.transaction_class } : null;
}

export async function recordReconciliation(sql: Sql, report: CustodyReconciliation): Promise<void> {
  await sql`select trading.record_reconciliation(${sql.json(asJson(report))})`;
}

// Owned addresses (D26) --------------------------------------------------------------------------

export async function listOwnedAddresses(sql: Sql): Promise<OwnedAddress[]> {
  const rows = await sql<{ address: string; purpose: OwnedAddress['purpose']; cluster: SolanaCluster; account_id: string | null; registered_at: Date; retired_at: Date | null }[]>`
    select address, purpose, cluster, account_id, registered_at, retired_at from intelligence.owned_addresses order by registered_at asc`;
  return rows.map((r) => ({ address: r.address as SolanaAddress, purpose: r.purpose, cluster: r.cluster, accountId: r.account_id as Uuid | null, registeredAt: r.registered_at.toISOString() as Instant, retiredAt: r.retired_at ? (r.retired_at.toISOString() as Instant) : null }));
}

/** Idempotent registration; a re-registration never un-retires or re-purposes an address silently. */
export async function registerOwnedAddress(sql: Sql, a: OwnedAddress): Promise<void> {
  await sql`
    insert into intelligence.owned_addresses (address, purpose, cluster, account_id, registered_at, retired_at)
    values (${a.address}, ${a.purpose}, ${a.cluster}, ${a.accountId}, ${a.registeredAt}, ${a.retiredAt})
    on conflict (address) do nothing`;
}
