import { type Sha256Hex, addMs, toInstant, instantToMs, type ActionCycle, type AdversarialReview, type AgentRun, type Instant, type PositionReviewState, type Proposal, type QueueMessageEnvelope, type SkillVersion, type SpendBudget, type SpendUsage, type ToolInvocation, type ToolRefusal, type UnresolvedReason, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { PgmqClient } from './queue-client.js';
import { recordClearedTransition } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Agents persistence (blueprint §6.10, §11.8–11.9, D39, D43; ADR-0001 amendment). A discretionary
 * cycle's outcome (cycle, model runs, proposals, reviews, tool audit) lands in one transaction
 * together with the position's review transition and, for a cleared exposure action, the outbox
 * message the trading-actions consumer picks up idempotently. Every table written here is
 * append-only; a cycle row is written once, at its terminal state.
 */

export async function ensureSkillVersion(sql: Sql, v: SkillVersion): Promise<'INSERTED' | 'EXISTS'> {
  const rows = await sql<{ id: string }[]>`
    insert into agents.skill_versions (id, skill_id, version_id, git_sha, tool_manifest_version, guideline_version, supported_action_types, workflow_graph_version, context_builder_version, proposer_model_policy_version, adversary_policy_required, status, effective_from, effective_to)
    values (${v.id}, ${v.skillId}, ${v.versionId}, ${v.gitSha}, ${v.toolManifestVersion}, ${v.guidelineVersion}, ${v.supportedActionTypes}, ${v.workflowGraphVersion}, ${v.contextBuilderVersion}, ${v.proposerModelPolicyVersion}, ${v.adversaryPolicyRequired}, ${v.status}, ${v.effectiveFrom}, ${v.effectiveTo})
    on conflict (version_id) do nothing returning id`;
  return rows.length > 0 ? 'INSERTED' : 'EXISTS';
}

export async function loadSkillVersion(sql: Sql, versionId: VersionId): Promise<SkillVersion | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select id, skill_id, version_id, git_sha, tool_manifest_version, guideline_version, supported_action_types, workflow_graph_version, context_builder_version, proposer_model_policy_version, adversary_policy_required, status, effective_from, effective_to
    from agents.skill_versions where version_id = ${versionId}`;
  if (!r) return null;
  return {
    id: r['id'] as Uuid, skillId: r['skill_id'] as string, versionId: r['version_id'] as VersionId, gitSha: r['git_sha'] as SkillVersion['gitSha'], toolManifestVersion: r['tool_manifest_version'] as VersionId, guidelineVersion: r['guideline_version'] as VersionId,
    supportedActionTypes: r['supported_action_types'] as SkillVersion['supportedActionTypes'], workflowGraphVersion: r['workflow_graph_version'] as VersionId, contextBuilderVersion: r['context_builder_version'] as VersionId, proposerModelPolicyVersion: r['proposer_model_policy_version'] as VersionId,
    adversaryPolicyRequired: true, status: r['status'] as SkillVersion['status'], effectiveFrom: toInstant(new Date(r['effective_from'] as string)), effectiveTo: r['effective_to'] ? toInstant(new Date(r['effective_to'] as string)) : null,
  };
}

export interface DiscretionaryOutcome {
  cycle: ActionCycle;
  proposals: Proposal[];
  reviews: AdversarialReview[];
  runs: AgentRun[];
  toolInvocations?: ToolInvocation[];
  toolRefusals?: ToolRefusal[];
}

export interface PositionReviewWrite {
  positionId: Uuid;
  reviewState: PositionReviewState;
  reason: UnresolvedReason | null;
  since: Instant;
  /** Set only when the cycle reviewed the position (REVIEWED). */
  lastReviewedCycleId: Uuid | null;
}

/**
 * Writes the whole outcome atomically. `positionReview` is the next review state computed by the
 * position-review machine in the worker (the repo owns no machine); `outbox` is enqueued inside the
 * same transaction so a crash between commit and enqueue cannot lose a cleared action.
 */
export async function persistDiscretionaryOutcome(sql: Sql, o: DiscretionaryOutcome, extra: { positionReview?: PositionReviewWrite; outbox?: QueueMessageEnvelope; releaseDigest?: Sha256Hex | null } = {}): Promise<void> {
  if (!['CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED'].includes(o.cycle.state)) throw new Error(`cycle ${o.cycle.id} is not terminal (${o.cycle.state})`);
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const c = o.cycle;
    await t`
      insert into agents.action_cycles (id, automation_run_id, trigger_id, candidate_id, position_id, strategy_version_id, skill_version_id, guideline_version_id, speed_tier, decision_budget_ms,
        proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, started_at, terminal_at)
      values (${c.id}, ${c.automationRunId}, ${c.triggerId}, ${c.candidateId}, ${c.positionId}, ${c.strategyVersionId}, ${c.skillVersionId}, ${c.guidelineVersionId}, ${c.speedTier}, ${c.decisionBudgetMs},
        ${c.proposedAction}, ${c.proposalId}, ${c.proposerRunIds}, ${c.adversaryRunIds}, ${c.verdict}, ${c.reasonCodes}, ${c.revisionRound}, ${c.state}, ${c.unresolvedReason}, ${t.json(asJson(c.cutoffs))}, ${c.clearedCutoffVersion}, ${c.riskEvaluationId}, ${c.intentId}, ${c.startedAt}, ${c.terminalAt})`;
    for (const r of o.runs) {
      await t`
        insert into agents.runs (id, action_cycle_id, candidate_id, position_id, role, provider, model, prompt_version, temperature, reasoning_config, input_evidence_ids, cutoff_version, cutoff_at, structured_output, tokens, cost_usd, latency_ms, success, schema_validation, created_at)
        values (${r.id}, ${r.actionCycleId}, ${r.candidateId}, ${r.positionId}, ${r.role}, ${r.provider}, ${r.model}, ${r.promptVersion}, ${r.temperature}, ${r.reasoningConfig ? t.json(asJson(r.reasoningConfig)) : null}, ${r.inputEvidenceIds}, ${r.cutoffVersion}, ${r.cutoffAt}, ${r.structuredOutput ? t.json(asJson(r.structuredOutput)) : null}, ${t.json(asJson(r.tokens))}, ${r.costUsd}, ${r.latencyMs}, ${r.success}, ${t.json(asJson(r.schemaValidation))}, ${r.createdAt})`;
    }
    for (const p of o.proposals) {
      await t`
        insert into trading.proposals (id, action_cycle_id, candidate_id, position_id, strategy_version_id, source, proposal, created_at, expires_at)
        values (${p.id}, ${p.actionCycleId}, ${p.candidateId}, ${p.positionId}, ${p.strategyVersionId}, ${p.source}, ${t.json(asJson(p.proposal))}, ${p.createdAt}, ${p.expiresAt})`;
    }
    for (const r of o.reviews) {
      await t`
        insert into agents.adversarial_reviews (id, action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at)
        values (${r.id}, ${r.actionCycleId}, ${r.agentRunId}, ${r.deterministicGate}, ${r.verdict}, ${t.json(asJson(r.objections))}, ${r.confidence}, ${r.cutoffVersion}, ${r.latencyMs}, ${r.blocking}, ${r.createdAt})`;
    }
    for (const i of o.toolInvocations ?? []) {
      await t`
        insert into agents.tool_invocations (id, agent_run_id, action_cycle_id, tool_name, tool_version, classification, request_hash, response_refs, cutoff_version, latency_ms, error, created_at)
        values (${i.id}, ${i.agentRunId}, ${i.actionCycleId}, ${i.toolName}, ${i.toolVersion}, ${i.classification}, ${i.requestHash}, ${i.responseRefs}, ${i.cutoffVersion}, ${i.latencyMs}, ${i.error}, ${i.createdAt})`;
    }
    for (const r of o.toolRefusals ?? []) {
      await t`
        insert into agents.tool_refusals (id, agent_run_id, action_cycle_id, requested_tool, reason, detail, request_hash, cutoff_version, created_at)
        values (${r.id}, ${r.agentRunId}, ${r.actionCycleId}, ${r.requestedTool}, ${r.reason}, ${r.detail}, ${r.requestHash}, ${r.cutoffVersion}, ${r.createdAt})`;
    }
    // ADR-0009 P2: a cleared discretionary cycle is recorded in the hash-chained ledger inside the same transaction.
    if (c.state === 'CLEARED') {
      const cleared = o.proposals.find((x) => x.id === c.proposalId);
      if (cleared) await recordClearedTransition(t, { cycle: c, proposal: cleared, releaseDigest: extra.releaseDigest ?? null, lotIds: [] });
    }
    if (extra.positionReview) {
      const pr = extra.positionReview;
      if (c.positionId !== pr.positionId) throw new Error('position review does not belong to this cycle');
      const rows = await t<{ id: string }[]>`
        update trading.positions set review_state = ${pr.reviewState}, review_state_reason = ${pr.reason}, review_state_since = ${pr.since},
          last_reviewed_cycle_id = coalesce(${pr.lastReviewedCycleId}, last_reviewed_cycle_id)
        where id = ${pr.positionId} and status <> 'CLOSED' returning id`;
      if (rows.length === 0) throw new Error(`position ${pr.positionId} is closed or missing`);
    }
    if (extra.outbox) await new PgmqClient(t).send(extra.outbox);
  });
}

export interface CycleSummary {
  cycle: Pick<ActionCycle, 'id' | 'state' | 'verdict' | 'proposedAction' | 'unresolvedReason' | 'revisionRound' | 'clearedCutoffVersion' | 'cutoffs' | 'proposerRunIds' | 'adversaryRunIds' | 'terminalAt'>;
  runs: number;
  reviews: number;
  toolInvocations: number;
  toolRefusals: number;
}

export async function loadCycleSummary(sql: Sql, cycleId: Uuid): Promise<CycleSummary | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    select c.id, c.state, c.verdict, c.proposed_action, c.unresolved_reason, c.revision_round, c.cleared_cutoff_version, c.cutoffs, c.proposer_run_ids, c.adversary_run_ids, c.terminal_at,
      (select count(*) from agents.runs r where r.action_cycle_id = c.id) as runs,
      (select count(*) from agents.adversarial_reviews v where v.action_cycle_id = c.id) as reviews,
      (select count(*) from agents.tool_invocations i where i.action_cycle_id = c.id) as tool_invocations,
      (select count(*) from agents.tool_refusals f where f.action_cycle_id = c.id) as tool_refusals
    from agents.action_cycles c where c.id = ${cycleId}`;
  if (!r) return null;
  return {
    cycle: { id: r['id'] as Uuid, state: r['state'] as ActionCycle['state'], verdict: r['verdict'] as ActionCycle['verdict'], proposedAction: r['proposed_action'] as ActionCycle['proposedAction'], unresolvedReason: r['unresolved_reason'] as ActionCycle['unresolvedReason'], revisionRound: r['revision_round'] as number, clearedCutoffVersion: r['cleared_cutoff_version'] as number | null, cutoffs: r['cutoffs'] as ActionCycle['cutoffs'], proposerRunIds: r['proposer_run_ids'] as Uuid[], adversaryRunIds: r['adversary_run_ids'] as Uuid[], terminalAt: r['terminal_at'] ? toInstant(new Date(r['terminal_at'] as string)) : null },
    runs: Number(r['runs']), reviews: Number(r['reviews']), toolInvocations: Number(r['tool_invocations']), toolRefusals: Number(r['tool_refusals']),
  };
}

// D43 spend budgets ------------------------------------------------------------------------------

export async function ensureSpendBudget(sql: Sql, b: SpendBudget): Promise<'INSERTED' | 'EXISTS'> {
  const rows = await sql<{ id: string }[]>`
    insert into ops.spend_budgets (id, version_id, scope, scope_id, limits, active, created_at)
    values (${b.id}, ${b.versionId}, ${b.scope}, ${b.scopeId}, ${sql.json(asJson(b.limits))}, ${b.active}, ${b.createdAt})
    on conflict (scope, scope_id, version_id) do nothing returning id`;
  return rows.length > 0 ? 'INSERTED' : 'EXISTS';
}

export async function listActiveSpendBudgets(sql: Sql): Promise<SpendBudget[]> {
  const rows = await sql<Record<string, unknown>[]>`select id, version_id, scope, scope_id, limits, active, created_at from ops.spend_budgets where active order by scope, scope_id, version_id`;
  return rows.map((r) => ({ id: r['id'] as Uuid, versionId: r['version_id'] as VersionId, scope: r['scope'] as SpendBudget['scope'], scopeId: r['scope_id'] as string | null, limits: r['limits'] as SpendBudget['limits'], active: r['active'] as boolean, createdAt: toInstant(new Date(r['created_at'] as string)) }));
}

function usageOf(r: Record<string, unknown>): SpendUsage {
  return { id: r['id'] as Uuid, budgetId: r['budget_id'] as Uuid, windowStart: toInstant(new Date(r['window_start'] as string)), windowEnd: toInstant(new Date(r['window_end'] as string)), cycles: Number(r['cycles']), modelUsd: Number(r['model_usd']), providerRequests: Number(r['provider_requests']), state: r['state'] as SpendUsage['state'], updatedAt: toInstant(new Date(r['updated_at'] as string)) };
}

/** Usage windows that contain `now` for the given budgets. */
export async function listSpendUsageAt(sql: Sql, budgetIds: readonly Uuid[], now: Instant): Promise<SpendUsage[]> {
  if (budgetIds.length === 0) return [];
  const rows = await sql<Record<string, unknown>[]>`
    select id, budget_id, window_start, window_end, cycles, model_usd, provider_requests, state, updated_at from ops.spend_usage
    where budget_id = any(${[...budgetIds]}::uuid[]) and window_start <= ${now} and window_end > ${now}`;
  return rows.map(usageOf);
}

/** The window a charge at `at` belongs to for a budget scope: hourly for cycles, daily for model spend, per minute for provider requests. */
export function spendWindow(at: Instant, unit: 'HOUR' | 'DAY' | 'MINUTE'): { start: Instant; end: Instant } {
  const ms = instantToMs(at);
  const size = unit === 'DAY' ? 86_400_000 : unit === 'HOUR' ? 3_600_000 : 60_000;
  const start = toInstant(ms - (ms % size));
  return { start, end: addMs(start, size) };
}

export async function chargeSpendUsage(sql: Sql, budgetId: Uuid, window: { start: Instant; end: Instant }, delta: { cycles?: number; modelUsd?: number; providerRequests?: number }): Promise<SpendUsage> {
  const [r] = await sql<Record<string, unknown>[]>`select * from ops.charge_spend_usage(${budgetId}, ${window.start}, ${window.end}, ${delta.cycles ?? 0}, ${delta.modelUsd ?? 0}, ${delta.providerRequests ?? 0})`;
  if (!r) throw new Error('charge_spend_usage returned no row');
  return usageOf(r);
}

export async function pauseSpendWindow(sql: Sql, usageId: Uuid): Promise<void> {
  await sql`update ops.spend_usage set state = 'BUDGET_PAUSED', updated_at = now() where id = ${usageId}`;
}
