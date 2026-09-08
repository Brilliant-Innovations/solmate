import { toInstant, type AutomationRun, type AutomationSet, type AutomationTriggerType, type Candidate, type Instant, type PositionReviewState, type PositionSafetyState, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Automation persistence and target listing for the agents role (blueprint §6.10C, §11.7).
 * Definitions are installed per (strategy, skill) binding from the versioned set and never edited
 * by the agent; every evaluation that is not a plain cooldown skip leaves an `automation_runs` row.
 */

export async function installAutomationSet(sql: Sql, set: AutomationSet, binding: { strategyVersionId: VersionId; skillVersionId: VersionId }): Promise<Record<string, Uuid>> {
  const ids: Record<string, Uuid> = {};
  for (const r of set.rules) {
    const name = `${r.name}:${binding.strategyVersionId}`;
    const [row] = await sql<{ id: string }[]>`
      insert into agents.automation_definitions (name, version_id, trigger_family, trigger_type, strategy_version_id, skill_version_id, filter, min_interval_ms, cooldown_ms, priority, scope, enabled_modes, context_deadline_ms, enabled)
      values (${name}, ${set.version}, ${r.triggerFamily}, ${r.triggerType}, ${binding.strategyVersionId}, ${binding.skillVersionId}, '{}'::jsonb, ${r.minIntervalMs}, ${r.cooldownMs}, ${r.priority}, ${r.triggerFamily === 'OPEN_POSITION' ? 'POSITION' : r.triggerFamily}, ${r.enabledModes}, ${r.contextDeadlineMs}, ${r.enabled})
      on conflict (name, version_id) do update set enabled = excluded.enabled returning id`;
    if (row) ids[r.triggerType] = row.id as Uuid;
  }
  return ids;
}

export async function recordAutomationRun(sql: Sql, run: AutomationRun): Promise<void> {
  await sql`
    insert into agents.automation_runs (id, automation_id, automation_version_id, trigger_event, cutoff_version, cutoff_at, skill_invocation_run_id, action_cycle_id, disposition, created_at)
    values (${run.id}, ${run.automationId}, ${run.automationVersionId}, ${sql.json(asJson(run.triggerEvent))}, ${run.cutoffVersion}, ${run.cutoffAt}, ${run.skillInvocationRunId}, ${run.actionCycleId}, ${run.disposition}, ${run.createdAt})`;
}

export interface AutomationHistoryRow {
  lastFiredAt: Instant | null;
  lastFiredByType: Partial<Record<AutomationTriggerType, Instant>>;
}

/** Last INVOKED firing for a target, overall and per trigger type (the engine's cooldown and interval inputs). */
export async function automationHistory(sql: Sql, targetId: Uuid): Promise<AutomationHistoryRow> {
  const rows = await sql<{ trigger_type: string; last: string }[]>`
    select trigger_event ->> 'type' as trigger_type, max(created_at) as last
    from agents.automation_runs where disposition = 'INVOKED' and trigger_event ->> 'targetId' = ${targetId}
    group by trigger_event ->> 'type'`;
  const byType: Partial<Record<AutomationTriggerType, Instant>> = {};
  let last: Instant | null = null;
  for (const r of rows) {
    const at = toInstant(new Date(r.last));
    byType[r.trigger_type as AutomationTriggerType] = at;
    if (last === null || at > last) last = at;
  }
  return { lastFiredAt: last, lastFiredByType: byType };
}

/**
 * Candidates the strategy has not cycled yet, discovered within its candidate-age contract and not
 * expired. Status is deliberately not filtered: S1 must see the same opportunity set S0 saw, whatever
 * S0 decided (§32 research validity).
 */
export async function listCandidateTargets(sql: Sql, strategyVersionId: VersionId, now: Instant, maxAgeMs: number, limit: number, families: readonly string[]): Promise<Candidate[]> {
  const since = toInstant(new Date(Date.parse(now) - maxAgeMs));
  const rows = await sql<Record<string, unknown>[]>`
    select c.* from signals.candidates c
    where c.status <> 'EXPIRED' and c.expires_at > ${now} and c.discovered_at >= ${since} and c.discovered_at <= ${now}
      and c.trigger_family = any(${[...families]}::enums.trigger_family[])
      and not exists (select 1 from agents.action_cycles x where x.candidate_id = c.id and x.strategy_version_id = ${strategyVersionId})
    order by c.discovered_at asc limit ${limit}`;
  return rows.map((r) => ({
    id: r['id'] as Uuid, assetId: r['asset_id'] as Uuid, discoveredAt: toInstant(new Date(r['discovered_at'] as string)), triggerFamily: r['trigger_family'] as Candidate['triggerFamily'], triggerDetails: r['trigger_details'] as Candidate['triggerDetails'], scannerScore: Number(r['scanner_score']), status: r['status'] as Candidate['status'],
    featureSnapshotId: r['feature_snapshot_id'] as Uuid, eligibilityEvaluationId: r['eligibility_evaluation_id'] as Uuid, expiresAt: toInstant(new Date(r['expires_at'] as string)), deterministicRejectionReason: (r['deterministic_rejection_reason'] as Candidate['deterministicRejectionReason']) ?? null, dedupeKey: r['dedupe_key'] as string, strategyVersionIds: (r['strategy_version_ids'] as VersionId[]) ?? [],
  }));
}

export interface PositionTargetRow {
  id: Uuid;
  accountId: Uuid;
  assetId: Uuid;
  mint: string;
  symbol: string;
  strategyVersionId: VersionId;
  openedAt: Instant;
  averageEntryPrice: number | null;
  markPrice: number | null;
  safetyState: PositionSafetyState;
  reviewState: PositionReviewState;
  reviewStateSince: Instant;
  nextReassessmentAt: Instant | null;
  lastReviewedCycleId: Uuid | null;
  /** Start of the latest position cycle, whatever its outcome. */
  lastCycleAt: Instant | null;
  /** Latest consecutive position cycles that did not clear (D39 backoff and alert input). */
  consecutiveUnresolved: number;
  unreviewedStop: number | null;
}

/** Open positions whose oldest open lot belongs to the strategy, with what the automation engine needs. */
export async function listPositionTargets(sql: Sql, strategyVersionId: VersionId, limit: number): Promise<PositionTargetRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select p.id, p.account_id, p.asset_id, p.mint, a.symbol, p.opened_at, p.average_entry_price, p.safety_state, p.review_state, p.review_state_since, p.next_reassessment_at, p.last_reviewed_cycle_id, p.unreviewed_stop,
      (select m.price_usd from market.snapshots m where m.asset_id = p.asset_id and m.price_usd is not null order by m.observed_at desc limit 1) as mark_price,
      (select max(c.started_at) from agents.action_cycles c where c.position_id = p.id) as last_cycle_at,
      (select count(*) from (select c.state from agents.action_cycles c where c.position_id = p.id order by c.started_at desc limit 10) recent where recent.state in ('UNRESOLVED', 'REJECTED', 'EXPIRED')) as recent_failed,
      (select c.state from agents.action_cycles c where c.position_id = p.id order by c.started_at desc limit 1) as last_state
    from trading.positions p join core.assets a on a.id = p.asset_id
    where p.status <> 'CLOSED' and p.quantity <> 0
      and (select l.strategy_version_id from trading.position_lots l where l.position_id = p.id and l.status = 'OPEN' order by l.opened_at limit 1) = ${strategyVersionId}
    order by p.opened_at asc limit ${limit}`;
  return rows.map((r) => ({
    id: r['id'] as Uuid, accountId: r['account_id'] as Uuid, assetId: r['asset_id'] as Uuid, mint: r['mint'] as string, symbol: r['symbol'] as string, strategyVersionId, openedAt: toInstant(new Date(r['opened_at'] as string)),
    averageEntryPrice: r['average_entry_price'] === null ? null : Number(r['average_entry_price']), markPrice: r['mark_price'] === null || r['mark_price'] === undefined ? null : Number(r['mark_price']), safetyState: r['safety_state'] as PositionSafetyState,
    reviewState: r['review_state'] as PositionReviewState, reviewStateSince: toInstant(new Date(r['review_state_since'] as string)), nextReassessmentAt: r['next_reassessment_at'] ? toInstant(new Date(r['next_reassessment_at'] as string)) : null,
    lastReviewedCycleId: (r['last_reviewed_cycle_id'] as Uuid | null) ?? null, lastCycleAt: r['last_cycle_at'] ? toInstant(new Date(r['last_cycle_at'] as string)) : null,
    consecutiveUnresolved: r['last_state'] === 'CLEARED' ? 0 : Number(r['recent_failed'] ?? 0), unreviewedStop: r['unreviewed_stop'] === null ? null : Number(r['unreviewed_stop']),
  }));
}
