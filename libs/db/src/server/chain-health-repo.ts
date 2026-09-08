import { toInstant, type ChainHealthSnapshot, type ChainView, type Instant, type Slot, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/** Chain-health history (§14.7): append-only snapshots; the newest one is the current verdict. */

export async function insertChainHealth(sql: Sql, s: ChainHealthSnapshot): Promise<void> {
  await sql`
    insert into ops.chain_health (id, observed_at, policy_version, state, views, head_slot, slot_advanced, confirmed_finalized_lag_slots, view_divergence_slots, effect_on_entries, reasons)
    values (${s.id}, ${s.observedAt}, ${s.policyVersion}, ${s.state}, ${sql.json(asJson(s.views))}, ${s.headSlot}, ${s.slotAdvanced}, ${s.confirmedFinalizedLagSlots}, ${s.viewDivergenceSlots}, ${s.effectOnEntries}, ${s.reasons})`;
}

export async function latestChainHealth(sql: Sql): Promise<ChainHealthSnapshot | null> {
  const [r] = await sql<Record<string, unknown>[]>`select * from ops.chain_health order by observed_at desc limit 1`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    observedAt: toInstant(new Date(r['observed_at'] as string)),
    policyVersion: r['policy_version'] as VersionId,
    state: r['state'] as ChainHealthSnapshot['state'],
    views: r['views'] as ChainView[],
    headSlot: r['head_slot'] === null ? null : (Number(r['head_slot']) as Slot),
    slotAdvanced: r['slot_advanced'] as boolean | null,
    confirmedFinalizedLagSlots: r['confirmed_finalized_lag_slots'] as number | null,
    viewDivergenceSlots: r['view_divergence_slots'] as number | null,
    effectOnEntries: r['effect_on_entries'] as ChainHealthSnapshot['effectOnEntries'],
    reasons: r['reasons'] as string[],
  };
}

/** The last time the confirmed head moved, from the history, so a restart does not reset the stall clock. */
export async function lastHeadAdvance(sql: Sql): Promise<{ headSlot: Slot; observedAt: Instant; lastAdvanceAt: Instant } | null> {
  const [latest] = await sql<{ head_slot: string | number | null; observed_at: string }[]>`select head_slot, observed_at from ops.chain_health where head_slot is not null order by observed_at desc limit 1`;
  if (!latest || latest.head_slot === null) return null;
  const head = Number(latest.head_slot);
  const [advanced] = await sql<{ observed_at: string }[]>`select observed_at from ops.chain_health where head_slot is not null and head_slot < ${head} order by observed_at desc limit 1`;
  const [first] = await sql<{ observed_at: string }[]>`select observed_at from ops.chain_health where head_slot = ${head} order by observed_at asc limit 1`;
  const lastAdvanceAt = advanced ? (first?.observed_at ?? latest.observed_at) : latest.observed_at;
  return { headSlot: head as Slot, observedAt: toInstant(new Date(latest.observed_at)), lastAdvanceAt: toInstant(new Date(lastAdvanceAt)) };
}
