import type { ActionCycle, AdversarialReview, Candidate, FeatureSnapshot, Instant, Proposal, ReasonCode, StrategyVersion, Uuid, VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Strategy versions, action cycles, proposals and adversarial reviews (blueprint §6.21, §6.10D,
 * §6.11; D7 immutable versions). Cycles are written once in their terminal state by the S0 runner
 * and never mutated here; proposals and reviews are immutable rows. The candidate's status
 * follows the SAFE outcome; both variants' version ids are recorded on it.
 */

/** Registers a strategy version if absent. Existing rows are immutable (D7), so a changed definition needs a new version id. */
export async function ensureStrategyVersion(sql: Sql, v: StrategyVersion): Promise<'INSERTED' | 'EXISTS'> {
  const rows = await sql<{ id: string }[]>`
    insert into research.strategy_versions (id, strategy_id, version_id, variant, git_sha, feature_version, prompt_versions, model_selections, thresholds, risk_policy_version,
      skill_version_id, guideline_version_id, automation_set_version_id, speed_tier, max_decision_latency_ms, max_candidate_age_ms, max_quote_age_ms, chase_tolerance_bps,
      allowed_action_types, reassessment_policy, adversary_policy, session_rules, regime_conditions, outside_window_behavior, warmup, event_window_policy, offline_protection,
      attended_presence_required_profiles, human_reaction_floor_ms, live_intent_expiry_ms, eligible_capital_authorities, status, active_from, active_to)
    values (${v.id}, ${v.strategyId}, ${v.versionId}, ${v.variant}, ${v.gitSha}, ${v.featureVersion}, ${sql.json(asJson(v.promptVersions))}, ${sql.json(asJson(v.modelSelections))}, ${sql.json(asJson(v.thresholds))}, ${v.riskPolicyVersion},
      ${v.skillVersionId}, ${v.guidelineVersionId}, ${v.automationSetVersionId}, ${v.speedTier}, ${v.maxDecisionLatencyMs}, ${v.maxCandidateAgeMs}, ${v.maxQuoteAgeMs}, ${v.chaseToleranceBps},
      ${v.allowedActionTypes}, ${sql.json(asJson(v.reassessmentPolicy))}, ${sql.json(asJson(v.adversaryPolicy))}, ${sql.json(asJson(v.sessionRules))}, ${sql.json(asJson(v.regimeConditions))}, ${v.outsideWindowBehavior}, ${sql.json(asJson(v.warmup))}, ${sql.json(asJson(v.eventWindowPolicy))}, ${sql.json(asJson(v.offlineProtection))},
      ${v.attendedPresenceRequiredProfiles}, ${v.humanReactionFloorMs}, ${v.liveIntentExpiryMs}, ${v.eligibleCapitalAuthorities}, ${v.status}, ${v.activeFrom}, ${v.activeTo})
    on conflict (version_id) do nothing
    returning id`;
  return rows.length ? 'INSERTED' : 'EXISTS';
}

/** DETECTED, unexpired candidates that have no action cycle yet for `strategyVersionId`, each with the feature snapshot it was detected on (point in time, not the latest). */
export async function listCandidatesAwaitingStrategy(sql: Sql, strategyVersionId: VersionId, now: Instant, limit: number): Promise<{ candidate: Candidate; snapshot: FeatureSnapshot }[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select c.id, c.asset_id, c.discovered_at, c.trigger_family, c.trigger_details, c.scanner_score, c.status, c.feature_snapshot_id, c.eligibility_evaluation_id, c.expires_at,
      c.deterministic_rejection_reason, c.dedupe_key, c.strategy_version_ids,
      f.id as f_id, f.as_of as f_as_of, f.feature_engine_version as f_engine, f.provenance as f_provenance, f.market_snapshot_id as f_market_snapshot_id, f.features as f_features,
      f.regime as f_regime, f.market_sessions as f_sessions, f.self_influence_suppressed as f_suppressed
    from signals.candidates c
    join signals.feature_snapshots f on f.id = c.feature_snapshot_id
    where c.status = 'DETECTED' and c.expires_at > ${now}
      and not exists (select 1 from agents.action_cycles x where x.candidate_id = c.id and x.strategy_version_id = ${strategyVersionId})
    order by c.discovered_at asc
    limit ${limit}`;
  return rows.map((r) => ({
    candidate: {
      id: r['id'] as Uuid,
      assetId: r['asset_id'] as Uuid,
      discoveredAt: new Date(r['discovered_at'] as string).toISOString() as Instant,
      triggerFamily: r['trigger_family'] as Candidate['triggerFamily'],
      triggerDetails: r['trigger_details'] as Candidate['triggerDetails'],
      scannerScore: r['scanner_score'] as number,
      status: r['status'] as Candidate['status'],
      featureSnapshotId: r['feature_snapshot_id'] as Uuid,
      eligibilityEvaluationId: r['eligibility_evaluation_id'] as Uuid,
      expiresAt: new Date(r['expires_at'] as string).toISOString() as Instant,
      deterministicRejectionReason: (r['deterministic_rejection_reason'] as ReasonCode | null) ?? null,
      dedupeKey: r['dedupe_key'] as string,
      strategyVersionIds: (r['strategy_version_ids'] as VersionId[]) ?? [],
    },
    snapshot: {
      id: r['f_id'] as Uuid,
      assetId: r['asset_id'] as Uuid,
      asOf: new Date(r['f_as_of'] as string).toISOString() as Instant,
      featureEngineVersion: r['f_engine'] as VersionId,
      provenance: r['f_provenance'] as FeatureSnapshot['provenance'],
      marketSnapshotId: (r['f_market_snapshot_id'] as Uuid | null) ?? null,
      features: r['f_features'] as FeatureSnapshot['features'],
      regime: (r['f_regime'] as FeatureSnapshot['regime']) ?? null,
      marketSessions: (r['f_sessions'] as FeatureSnapshot['marketSessions']) ?? [],
      selfInfluenceSuppressed: r['f_suppressed'] as boolean,
    },
  }));
}

export interface PersistedDecision {
  cycle: ActionCycle;
  proposal: Proposal;
  review: AdversarialReview;
}

/**
 * Writes one candidate's decisions (RAW and SAFE) atomically and moves the candidate to
 * `candidateStatus` with `rejectionReason` when REJECTED. The candidate must still be DETECTED:
 * a second runner racing on the same candidate finds zero rows updated and the transaction rolls back.
 */
export async function persistS0Decisions(sql: Sql, candidateId: Uuid, decisions: PersistedDecision[], candidateStatus: 'QUALIFIED' | 'REJECTED', rejectionReason: ReasonCode | null): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    for (const { cycle: c, proposal: p, review: r } of decisions) {
      await t`
        insert into agents.action_cycles (id, automation_run_id, trigger_id, candidate_id, position_id, strategy_version_id, skill_version_id, guideline_version_id, speed_tier, decision_budget_ms,
          proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, started_at, terminal_at)
        values (${c.id}, ${c.automationRunId}, ${c.triggerId}, ${c.candidateId}, ${c.positionId}, ${c.strategyVersionId}, ${c.skillVersionId}, ${c.guidelineVersionId}, ${c.speedTier}, ${c.decisionBudgetMs},
          ${c.proposedAction}, ${c.proposalId}, ${c.proposerRunIds}, ${c.adversaryRunIds}, ${c.verdict}, ${c.reasonCodes}, ${c.revisionRound}, ${c.state}, ${c.unresolvedReason}, ${t.json(asJson(c.cutoffs))}, ${c.clearedCutoffVersion}, ${c.riskEvaluationId}, ${c.intentId}, ${c.startedAt}, ${c.terminalAt})`;
      await t`
        insert into trading.proposals (id, action_cycle_id, candidate_id, position_id, strategy_version_id, source, proposal, created_at, expires_at)
        values (${p.id}, ${p.actionCycleId}, ${p.candidateId}, ${p.positionId}, ${p.strategyVersionId}, ${p.source}, ${t.json(asJson(p.proposal))}, ${p.createdAt}, ${p.expiresAt})`;
      await t`
        insert into agents.adversarial_reviews (id, action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at)
        values (${r.id}, ${r.actionCycleId}, ${r.agentRunId}, ${r.deterministicGate}, ${r.verdict}, ${t.json(asJson(r.objections))}, ${r.confidence}, ${r.cutoffVersion}, ${r.latencyMs}, ${r.blocking}, ${r.createdAt})`;
    }
    const versions = [...new Set(decisions.map((d) => d.cycle.strategyVersionId))];
    const updated = await t<{ id: string }[]>`
      update signals.candidates set status = ${candidateStatus}, deterministic_rejection_reason = ${rejectionReason},
        strategy_version_ids = (select array(select distinct unnest(strategy_version_ids || ${versions}::core.version_id[])))
      where id = ${candidateId} and status = 'DETECTED' returning id`;
    if (updated.length === 0) throw new Error(`candidate ${candidateId} is no longer DETECTED`);
  });
}

/** Cycle, proposal and review rows for a candidate: the Inspector's counterfactual input and the reconstruction test's stored side. */
export async function listCyclesForCandidate(sql: Sql, candidateId: Uuid): Promise<{ cycle: Pick<ActionCycle, 'id' | 'strategyVersionId' | 'state' | 'verdict' | 'reasonCodes' | 'proposalId'>; review: Pick<AdversarialReview, 'verdict' | 'objections' | 'deterministicGate' | 'blocking'> | null }[]> {
  const rows = await sql<{ id: string; strategy_version_id: string; state: ActionCycle['state']; verdict: ActionCycle['verdict']; reason_codes: string[]; proposal_id: string | null; r_verdict: AdversarialReview['verdict'] | null; r_objections: AdversarialReview['objections'] | null; r_gate: boolean | null; r_blocking: boolean | null }[]>`
    select c.id, c.strategy_version_id, c.state, c.verdict, c.reason_codes, c.proposal_id, r.verdict as r_verdict, r.objections as r_objections, r.deterministic_gate as r_gate, r.blocking as r_blocking
    from agents.action_cycles c
    left join lateral (select * from agents.adversarial_reviews y where y.action_cycle_id = c.id order by created_at desc limit 1) r on true
    where c.candidate_id = ${candidateId}
    order by c.strategy_version_id`;
  return rows.map((r) => ({
    cycle: { id: r.id as Uuid, strategyVersionId: r.strategy_version_id as VersionId, state: r.state, verdict: r.verdict, reasonCodes: r.reason_codes, proposalId: (r.proposal_id as Uuid | null) ?? null },
    review: r.r_verdict ? { verdict: r.r_verdict, objections: r.r_objections ?? [], deterministicGate: r.r_gate ?? false, blocking: r.r_blocking ?? false } : null,
  }));
}

/** EXPIRED cycles for a candidate whose age passed the strategy's contract (D32): recorded, and the candidate leaves DETECTED as stale. */
export async function persistS0Expiry(sql: Sql, candidateId: Uuid, cycles: ActionCycle[]): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    for (const c of cycles) {
      await t`
        insert into agents.action_cycles (id, automation_run_id, trigger_id, candidate_id, position_id, strategy_version_id, skill_version_id, guideline_version_id, speed_tier, decision_budget_ms,
          proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, started_at, terminal_at)
        values (${c.id}, ${c.automationRunId}, ${c.triggerId}, ${c.candidateId}, ${c.positionId}, ${c.strategyVersionId}, ${c.skillVersionId}, ${c.guidelineVersionId}, ${c.speedTier}, ${c.decisionBudgetMs},
          ${c.proposedAction}, ${c.proposalId}, ${c.proposerRunIds}, ${c.adversaryRunIds}, ${c.verdict}, ${c.reasonCodes}, ${c.revisionRound}, ${c.state}, ${c.unresolvedReason}, ${t.json(asJson(c.cutoffs))}, ${c.clearedCutoffVersion}, ${c.riskEvaluationId}, ${c.intentId}, ${c.startedAt}, ${c.terminalAt})`;
    }
    const versions = [...new Set(cycles.map((c) => c.strategyVersionId))];
    const updated = await t<{ id: string }[]>`
      update signals.candidates set status = 'REJECTED', deterministic_rejection_reason = 'CANDIDATE_STALE',
        strategy_version_ids = (select array(select distinct unnest(strategy_version_ids || ${versions}::core.version_id[])))
      where id = ${candidateId} and status = 'DETECTED' returning id`;
    if (updated.length === 0) throw new Error(`candidate ${candidateId} is no longer DETECTED`);
  });
}
