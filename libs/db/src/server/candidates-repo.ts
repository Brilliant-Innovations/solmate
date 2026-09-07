import type { Candidate, CandidateStatus, FeatureSnapshot, Instant, ReasonCode, TriggerFamily, Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Candidate persistence (blueprint §6.9). Candidates are mutable only in status (the lifecycle
 * machine decides); detection facts — snapshot, eligibility record, score, trigger details — are
 * written once. Rejected candidates are kept so filter value can be measured (§32).
 */

export async function insertCandidate(sql: Sql, c: Candidate): Promise<void> {
  await sql`
    insert into signals.candidates (id, asset_id, discovered_at, trigger_family, trigger_details, scanner_score, status, feature_snapshot_id, eligibility_evaluation_id, expires_at, deterministic_rejection_reason, dedupe_key, strategy_version_ids)
    values (${c.id}, ${c.assetId}, ${c.discoveredAt}, ${c.triggerFamily}, ${sql.json(asJson(c.triggerDetails))}, ${c.scannerScore}, ${c.status}, ${c.featureSnapshotId}, ${c.eligibilityEvaluationId}, ${c.expiresAt}, ${c.deterministicRejectionReason}, ${c.dedupeKey}, ${c.strategyVersionIds})`;
}

/** Non-terminal candidates for an asset and family (dedupe input). */
export async function listOpenCandidates(sql: Sql, assetId: Uuid, family: TriggerFamily): Promise<Pick<Candidate, 'id' | 'dedupeKey' | 'discoveredAt' | 'status' | 'expiresAt'>[]> {
  const rows = await sql<{ id: string; dedupe_key: string; discovered_at: string; status: CandidateStatus; expires_at: string }[]>`
    select id, dedupe_key, discovered_at, status, expires_at from signals.candidates
    where asset_id = ${assetId} and trigger_family = ${family} and status in ('DETECTED', 'ENRICHING', 'AGENT_REVIEW')
    order by discovered_at desc`;
  return rows.map((r) => ({ id: r.id as Uuid, dedupeKey: r.dedupe_key, discoveredAt: new Date(r.discovered_at).toISOString() as Instant, status: r.status, expiresAt: new Date(r.expires_at).toISOString() as Instant }));
}

/** Newest REJECTED/EXPIRED time for an asset and family (cooldown input). */
export async function lastTerminalCandidateAt(sql: Sql, assetId: Uuid, family: TriggerFamily): Promise<Instant | null> {
  const [r] = await sql<{ at: string | null }[]>`
    select max(updated_at) as at from signals.candidates where asset_id = ${assetId} and trigger_family = ${family} and status in ('REJECTED', 'EXPIRED')`;
  return r?.at ? (new Date(r.at).toISOString() as Instant) : null;
}

/** Latest feature snapshot per ELIGIBLE asset, with the id of the latest eligibility record: the scanner's input set. */
export async function listScanInputs(sql: Sql, limit: number): Promise<{ snapshot: FeatureSnapshot; eligibilityEvaluationId: Uuid }[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select f.*, e.id as eligibility_id
    from core.assets a
    join lateral (select * from signals.feature_snapshots x where x.asset_id = a.id order by as_of desc limit 1) f on true
    join lateral (select id from core.asset_eligibility y where y.asset_id = a.id order by evaluated_at desc limit 1) e on true
    where a.status = 'ELIGIBLE'
    order by f.as_of desc
    limit ${limit}`;
  return rows.map((r) => ({
    eligibilityEvaluationId: r['eligibility_id'] as Uuid,
    snapshot: {
      id: r['id'] as Uuid,
      assetId: r['asset_id'] as Uuid,
      asOf: new Date(r['as_of'] as string).toISOString() as Instant,
      featureEngineVersion: r['feature_engine_version'] as FeatureSnapshot['featureEngineVersion'],
      provenance: r['provenance'] as FeatureSnapshot['provenance'],
      marketSnapshotId: r['market_snapshot_id'] as Uuid | null,
      features: r['features'] as FeatureSnapshot['features'],
      regime: r['regime'] as FeatureSnapshot['regime'],
      marketSessions: r['market_sessions'] as FeatureSnapshot['marketSessions'],
      selfInfluenceSuppressed: r['self_influence_suppressed'] as boolean,
    },
  }));
}

/** Moves every open candidate past its expiry to EXPIRED (§6.9 lifecycle TICK); returns how many. */
export async function expireCandidates(sql: Sql, now: Instant): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update signals.candidates set status = 'EXPIRED' where status in ('DETECTED', 'ENRICHING', 'AGENT_REVIEW') and expires_at <= ${now} returning id`;
  return rows.length;
}

export async function rejectCandidate(sql: Sql, id: Uuid, reason: ReasonCode): Promise<void> {
  await sql`update signals.candidates set status = 'REJECTED', deterministic_rejection_reason = ${reason} where id = ${id} and status in ('DETECTED', 'ENRICHING', 'AGENT_REVIEW')`;
}
