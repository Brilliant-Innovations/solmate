import type { Instant, Uuid } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';

/** Restart recovery reads and settlements (§21.3). Every write here only moves an intent to a terminal state the attempts already prove. */

export interface RecoveryFactRows {
  openPositions: number;
  openLots: number;
  intents: Record<string, number>;
  inFlightAttempts: number;
}

export async function recoveryFacts(sql: Sql, accountId: Uuid): Promise<RecoveryFactRows> {
  const [p] = await sql<{ positions: number; lots: number }[]>`
    select (select count(*)::int from trading.positions where account_id = ${accountId} and status = 'OPEN') as positions,
           (select count(*)::int from trading.position_lots l join trading.positions p on p.id = l.position_id where p.account_id = ${accountId} and l.status = 'OPEN') as lots`;
  const intents = await sql<{ state: string; n: number }[]>`
    select lifecycle_state as state, count(*)::int as n from trading.intents where account_id = ${accountId} and lifecycle_state in ('CREATED', 'AUTHORIZED', 'APPROVED', 'EXECUTING') group by lifecycle_state`;
  const [a] = await sql<{ n: number }[]>`
    select count(*)::int as n from trading.order_attempts oa join trading.intents i on i.id = oa.intent_id
    where i.account_id = ${accountId} and oa.state in ('SIGNED_NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED_PROVISIONAL', 'REORG_PENDING')`;
  return { openPositions: p?.positions ?? 0, openLots: p?.lots ?? 0, intents: Object.fromEntries(intents.map((r) => [r.state, r.n])), inFlightAttempts: a?.n ?? 0 };
}

export async function expireStaleIntents(sql: Sql, accountId: Uuid, now: Instant): Promise<Uuid[]> {
  const rows = await sql<{ id: string }[]>`
    update trading.intents set lifecycle_state = 'EXPIRED'
    where account_id = ${accountId} and lifecycle_state in ('CREATED', 'AUTHORIZED', 'APPROVED') and expires_at <= ${now}
    returning id`;
  return rows.map((r) => r.id as Uuid);
}

export async function settleIntentsFromAttempts(sql: Sql, accountId: Uuid): Promise<{ intentId: Uuid; state: 'COMPLETED' | 'FAILED' }[]> {
  const rows = await sql<{ id: string; state: 'COMPLETED' | 'FAILED' }[]>`
    with newest as (
      select distinct on (oa.intent_id) oa.intent_id, oa.state from trading.order_attempts oa join trading.intents i on i.id = oa.intent_id
      where i.account_id = ${accountId} and i.lifecycle_state = 'EXECUTING' order by oa.intent_id, oa.attempt_number desc
    )
    update trading.intents i set lifecycle_state = case when n.state = 'FINALIZED' then 'COMPLETED' else 'FAILED' end
    from newest n where i.id = n.intent_id and n.state in ('FINALIZED', 'NOT_LANDED')
    returning i.id, i.lifecycle_state as state`;
  return rows.map((r) => ({ intentId: r.id as Uuid, state: r.state }));
}

export async function failOrphanedExecuting(sql: Sql, accountId: Uuid, now: Instant): Promise<Uuid[]> {
  const rows = await sql<{ id: string }[]>`
    update trading.intents i set lifecycle_state = 'FAILED'
    where i.account_id = ${accountId} and i.lifecycle_state = 'EXECUTING' and i.expires_at <= ${now}
      and not exists (select 1 from trading.order_attempts oa where oa.intent_id = i.id)
    returning i.id`;
  return rows.map((r) => r.id as Uuid);
}

/** ADR-0007 SINGLE_SLEEVE_PER_MINT: mints an account holds under more than one strategy sleeve. Empty is the arming precondition. */
export async function sleeveConflicts(sql: Sql, accountId: Uuid): Promise<{ mint: string; sleeves: number }[]> {
  const rows = await sql<{ mint: string; sleeves: number }[]>`
    select l.mint, count(distinct l.sleeve_id)::int as sleeves from trading.position_lots l join trading.positions p on p.id = l.position_id
    where p.account_id = ${accountId} and l.status = 'OPEN' group by l.mint having count(distinct l.sleeve_id) > 1`;
  return rows;
}
