import { toInstant, type Amount, type CustodyReconciliation, type EligibilitySummaryEntry, type Instant, type KeyId, type MintAddress, type OpenLotSummary, type Release, type Sequence, type Sha256Hex, type SignedRiskStateProjection, type Slot, type Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * State projector persistence (blueprint §6.14A, D21, D52; execution plan M7). Projections are
 * append-only and sequenced per account (unique (account_id, sequence)); the authorizer loads the
 * latest and refuses rollbacks. Releases are registered by digest so the same binding never gets
 * two rows.
 */

export async function ensureRelease(sql: Sql, r: Release): Promise<{ id: Uuid; outcome: 'INSERTED' | 'EXISTS' }> {
  const rows = await sql<{ id: string }[]>`
    insert into research.releases (id, digest, binding, status, created_at, promoted_at, retired_at)
    values (${r.id}, ${r.digest}, ${sql.json(asJson(r.binding))}, ${r.status}, ${r.createdAt}, ${r.promotedAt}, ${r.retiredAt})
    on conflict (digest) do nothing returning id`;
  if (rows[0]) return { id: rows[0].id as Uuid, outcome: 'INSERTED' };
  const [existing] = await sql<{ id: string }[]>`select id from research.releases where digest = ${r.digest}`;
  if (!existing) throw new Error(`release ${r.digest} neither inserted nor found`);
  return { id: existing.id as Uuid, outcome: 'EXISTS' };
}

export async function nextProjectionSequence(sql: Sql, accountId: Uuid): Promise<Sequence> {
  const [r] = await sql<{ next: string | number }[]>`select coalesce(max(sequence), -1) + 1 as next from risk.state_projections where account_id = ${accountId}`;
  return Number(r?.next ?? 0) as Sequence;
}

export async function insertProjection(sql: Sql, accountId: Uuid, envelope: SignedRiskStateProjection): Promise<void> {
  await sql`
    insert into risk.state_projections (account_id, sequence, envelope, payload_hash, key_id, as_of, chain_slot)
    values (${accountId}, ${envelope.payload.sequence}, ${sql.json(asJson(envelope))}, ${envelope.payloadHash}, ${envelope.keyId}, ${envelope.payload.asOf}, ${envelope.payload.chainSlot})`;
}

export interface ProjectionRow {
  sequence: Sequence;
  asOf: Instant;
  chainSlot: Slot;
  payloadHash: Sha256Hex;
  keyId: KeyId;
}

export async function listProjections(sql: Sql, accountId: Uuid, limit: number): Promise<ProjectionRow[]> {
  const rows = await sql<{ sequence: string | number; as_of: string; chain_slot: string | number; payload_hash: string; key_id: string }[]>`
    select sequence, as_of, chain_slot, payload_hash, key_id from risk.state_projections where account_id = ${accountId} order by sequence desc limit ${limit}`;
  return rows.map((r) => ({ sequence: Number(r.sequence) as Sequence, asOf: toInstant(new Date(r.as_of)), chainSlot: Number(r.chain_slot) as Slot, payloadHash: r.payload_hash as Sha256Hex, keyId: r.key_id as KeyId }));
}

/** Open lots with what the projection carries per lot; provider protection counts only when an order id is recorded. */
export async function listOpenLotSummaries(sql: Sql, accountId: Uuid): Promise<OpenLotSummary[]> {
  const rows = await sql<{ id: string; position_id: string; asset_id: string; mint: string; quantity: string; cost: string; protection_mode: OpenLotSummary['protectionMode']; provider_order_id: string | null }[]>`
    select l.id, l.position_id, l.asset_id, l.mint, l.quantity::text as quantity, l.cost_basis_base_units::text as cost, l.protection_mode, l.provider_order_id
    from trading.position_lots l join trading.positions p on p.id = l.position_id
    where p.account_id = ${accountId} and l.status = 'OPEN' and l.quantity <> 0
    order by l.opened_at asc`;
  return rows.map((r) => ({ lotId: r.id as Uuid, positionId: r.position_id as Uuid, assetId: r.asset_id as Uuid, mint: r.mint as MintAddress, quantity: r.quantity as Amount, costBasisBaseUnits: r.cost as Amount, protectionMode: r.protection_mode, providerProtectionActive: r.protection_mode === 'JUPITER_TRIGGER' && r.provider_order_id !== null }));
}

/** The newest custody reconciliation for the account: chain slot and observed balances per custody account. */
export async function latestReconciliation(sql: Sql, accountId: Uuid): Promise<Pick<CustodyReconciliation, 'evaluatedAt' | 'chainSlot' | 'status' | 'balances'> | null> {
  const [r] = await sql<{ evaluated_at: string; chain_slot: string | number | null; status: CustodyReconciliation['status']; balances: CustodyReconciliation['balances'] }[]>`
    select evaluated_at, chain_slot, status, balances from trading.custody_reconciliations where account_id = ${accountId} order by evaluated_at desc limit 1`;
  if (!r) return null;
  return { evaluatedAt: toInstant(new Date(r.evaluated_at)), chainSlot: r.chain_slot === null ? null : (Number(r.chain_slot) as Slot), status: r.status, balances: r.balances };
}

/** Latest eligibility evaluation for every asset the account currently holds. */
export async function heldAssetEligibility(sql: Sql, accountId: Uuid): Promise<EligibilitySummaryEntry[]> {
  const rows = await sql<{ asset_id: string; id: string; eligible: boolean; evaluated_at: string }[]>`
    select distinct on (e.asset_id) e.asset_id, e.id, e.eligible, e.evaluated_at
    from core.asset_eligibility e
    where e.asset_id in (select p.asset_id from trading.positions p where p.account_id = ${accountId} and p.status <> 'CLOSED')
    order by e.asset_id, e.evaluated_at desc`;
  return rows.map((r) => ({ assetId: r.asset_id as Uuid, evaluationId: r.id as Uuid, eligible: r.eligible, evaluatedAt: toInstant(new Date(r.evaluated_at)) }));
}
