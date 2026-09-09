import { DEFAULT_AUTOMATION_SET, DEFAULT_DISCRETIONARY_CYCLE_POLICY, DEFAULT_TOOL_MANIFEST, FORBIDDEN_TOOL_CAPABILITIES, MODEL_POLICY_V1, TOOL_ARGUMENT_SCHEMAS, TRADING_SKILL_V1_BINDINGS } from '@sol-agent-trader/contracts';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Autonomy workspace read models (§20.12 Trading Skill Console, §20.13 Automations Console,
 * §20.14 Action Adversary Console). Versions, tool manifest and policies are pinned data from
 * `/libs/contracts`; usage, invocation stats, automation state, adversary rates and outcomes are
 * ledger facts under RLS. Nothing here is editable: the live agent cannot change its skill,
 * guidelines or automations, and neither can this page (§31).
 */

export interface SkillVersionRow {
  id: string;
  skill_id: string;
  version_id: string;
  git_sha: string;
  tool_manifest_version: string;
  guideline_version: string;
  supported_action_types: string[];
  workflow_graph_version: string;
  context_builder_version: string;
  proposer_model_policy_version: string;
  adversary_policy_required: boolean;
  status: string;
  effective_from: string;
  effective_to: string | null;
}

export interface ToolStat {
  name: string;
  invocations: number;
  errors: number;
  avgLatencyMs: number | null;
  last: string | null;
}

export interface AutomationRow {
  id: string;
  name: string;
  version_id: string;
  trigger_family: string;
  trigger_type: string;
  strategy_version_id: string;
  skill_version_id: string;
  filter: Record<string, unknown>;
  min_interval_ms: number;
  cooldown_ms: number;
  priority: number;
  scope: string;
  enabled_modes: string[];
  context_deadline_ms: number;
  enabled: boolean;
  last_fired_at: string | null;
  next_eligible_at: string | null;
  lastRun: { disposition: string; created_at: string } | null;
}

export interface AdversaryStats {
  reviews: number;
  aiReviews: number;
  deterministicReviews: number;
  verdicts: Record<string, number>;
  objectionCodes: { code: string; count: number }[];
  revisionCycles: number;
  revisionCleared: number;
  avgAiLatencyMs: number | null;
  unresolved: Record<string, number>;
  positionCyclesWithoutReview: number;
  positionCycles: number;
  outcomes: { confirmedRealized: number | null; confirmedLots: number; challengedRealized: number | null; challengedLots: number };
  adversaryModels: { provider: string; model: string; runs: number; failures: number }[];
}

export interface AutonomyView {
  skills: SkillVersionRow[];
  guidelines: { version_id: string; skill_id: string; rules: string[]; registered_at: string }[];
  boundStrategies: { version_id: string; strategy_id: string; status: string; skill_version_id: string | null; guideline_version_id: string | null; automation_set_version_id: string | null }[];
  usage: { runs24h: number; failedRuns24h: number; refusals24h: number; cycles24h: number; costUsd24h: number };
  toolStats: ToolStat[];
  automations: AutomationRow[];
  nextReassessments: { symbol: string; next_reassessment_at: string | null; speed_tier: string | null }[];
  adversary: AdversaryStats;
  manifest: typeof DEFAULT_TOOL_MANIFEST;
  argumentFields: Record<string, string[]>;
  forbidden: readonly string[];
  bindings: typeof TRADING_SKILL_V1_BINDINGS;
  modelPolicy: typeof MODEL_POLICY_V1;
  cyclePolicy: typeof DEFAULT_DISCRETIONARY_CYCLE_POLICY;
  automationSet: typeof DEFAULT_AUTOMATION_SET;
}

/** Static data source and point-in-time behaviour per tool (§20.12 Tools tab); the handlers resolve ids server-side against the cycle scope. */
export const TOOL_SOURCES: Record<string, { source: string; pointInTime: string }> = {
  getCandidateContext: { source: 'signals.candidates + strategy thresholds', pointInTime: 'as of the cycle cutoff' },
  getAssetMarketState: { source: 'market.snapshots, signals.feature_snapshots, regime', pointInTime: 'as of the cutoff; stale labelled, never zero-filled' },
  getAssetSafetyState: { source: 'core.asset_eligibility (chain-verified security fields)', pointInTime: 'latest evaluation at or before the cutoff' },
  getOnchainContext: { source: 'holder concentration, flows, tracked wallets (own addresses excluded)', pointInTime: 'as of the cutoff' },
  getNewsSocialEvidence: { source: 'intelligence.events via event_assets, deduplicated', pointInTime: 'first seen at or before the cutoff (D26 first-seen rule)' },
  getPositionContext: { source: 'trading.positions + lots + protection', pointInTime: 'as of the cutoff' },
  getPortfolioContext: { source: 'portfolio snapshot, sleeves, cohorts, spend budgets', pointInTime: 'latest snapshot at or before the cutoff' },
  getExecutionPreview: { source: 'quote probe for the deterministic size', pointInTime: 'preview at call time; nothing reserved or signed' },
  submitActionProposal: { source: 'writes one TradingActionProposal for adversarial review', pointInTime: 'carries evidenceCutoffVersion; no amount, destination or execution field' },
};

export async function loadAutonomy(nowMs: number): Promise<AutonomyView> {
  const supabase = await createSupabaseServerClient();
  const argumentFields = Object.fromEntries(Object.entries(TOOL_ARGUMENT_SCHEMAS).map(([k, schema]) => [k, Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape ?? {})]));
  const base: AutonomyView = {
    skills: [], guidelines: [], boundStrategies: [], usage: { runs24h: 0, failedRuns24h: 0, refusals24h: 0, cycles24h: 0, costUsd24h: 0 }, toolStats: [], automations: [], nextReassessments: [],
    adversary: { reviews: 0, aiReviews: 0, deterministicReviews: 0, verdicts: {}, objectionCodes: [], revisionCycles: 0, revisionCleared: 0, avgAiLatencyMs: null, unresolved: {}, positionCyclesWithoutReview: 0, positionCycles: 0, outcomes: { confirmedRealized: null, confirmedLots: 0, challengedRealized: null, challengedLots: 0 }, adversaryModels: [] },
    manifest: DEFAULT_TOOL_MANIFEST, argumentFields, forbidden: FORBIDDEN_TOOL_CAPABILITIES, bindings: TRADING_SKILL_V1_BINDINGS, modelPolicy: MODEL_POLICY_V1, cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY, automationSet: DEFAULT_AUTOMATION_SET,
  };
  if (!supabase) return base;
  const since24h = new Date(nowMs - 24 * 3_600_000).toISOString();
  const since7d = new Date(nowMs - 7 * 86_400_000).toISOString();
  const [skills, guidelines, strategies, runs, refusals, cycles24, tools, automations, automationRuns, positions, reviews, cycles7, lots] = await Promise.all([
    supabase.schema('agents').from('skill_versions').select('*').order('effective_from', { ascending: false }),
    supabase.schema('agents').from('guideline_versions').select('version_id, skill_id, rules, registered_at').order('registered_at', { ascending: false }),
    supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, status, skill_version_id, guideline_version_id, automation_set_version_id').order('version_id'),
    supabase.schema('agents').from('runs').select('role, provider, model, success, cost_usd, created_at').gte('created_at', since7d).order('created_at', { ascending: false }).limit(2000),
    supabase.schema('agents').from('tool_refusals').select('id', { count: 'exact', head: true }).gte('created_at', since24h),
    supabase.schema('agents').from('action_cycles').select('id', { count: 'exact', head: true }).gte('started_at', since24h),
    supabase.schema('agents').from('tool_invocations').select('tool_name, latency_ms, error, created_at').gte('created_at', since7d).order('created_at', { ascending: false }).limit(5000),
    supabase.schema('agents').from('automation_definitions').select('id, name, version_id, trigger_family, trigger_type, strategy_version_id, skill_version_id, filter, min_interval_ms, cooldown_ms, priority, scope, enabled_modes, context_deadline_ms, enabled, last_fired_at, next_eligible_at').order('priority', { ascending: false }),
    supabase.schema('agents').from('automation_runs').select('automation_id, disposition, created_at').order('created_at', { ascending: false }).limit(500),
    supabase.schema('trading').from('positions').select('asset_id, next_reassessment_at').eq('status', 'OPEN' as never).limit(20),
    supabase.schema('agents').from('adversarial_reviews').select('action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, latency_ms, blocking, created_at').gte('created_at', since7d).order('created_at', { ascending: false }).limit(3000),
    supabase.schema('agents').from('action_cycles').select('id, position_id, verdict, revision_round, state, unresolved_reason, intent_id').gte('started_at', since7d).limit(3000),
    supabase.schema('trading').from('position_lots').select('entry_intent_id, realized_pnl_base_units, status').eq('status', 'CLOSED' as never).limit(2000),
  ]);
  const runRows = (runs.data as { role: string; provider: string; model: string; success: boolean; cost_usd: number; created_at: string }[] | null) ?? [];
  const runs24 = runRows.filter((r) => r.created_at >= since24h);
  const toolRows = (tools.data as { tool_name: string; latency_ms: number; error: string | null; created_at: string }[] | null) ?? [];
  const toolStats: ToolStat[] = DEFAULT_TOOL_MANIFEST.tools.map((t) => {
    const rows = toolRows.filter((x) => x.tool_name === t.name);
    return { name: t.name, invocations: rows.length, errors: rows.filter((x) => x.error).length, avgLatencyMs: rows.length ? Math.round(rows.reduce((a, x) => a + x.latency_ms, 0) / rows.length) : null, last: rows[0]?.created_at ?? null };
  });
  const lastRunByAutomation = new Map<string, { disposition: string; created_at: string }>();
  for (const r of (automationRuns.data as { automation_id: string; disposition: string; created_at: string }[] | null) ?? []) if (!lastRunByAutomation.has(r.automation_id)) lastRunByAutomation.set(r.automation_id, r);
  const automationRows: AutomationRow[] = ((automations.data as unknown as Omit<AutomationRow, 'lastRun'>[] | null) ?? []).map((a) => ({ ...a, enabled_modes: a.enabled_modes ?? [], filter: a.filter ?? {}, lastRun: lastRunByAutomation.get(a.id) ?? null }));
  // Next reassessment per open position, with the tier heartbeat that would fire if nothing else happens.
  const posRows = (positions.data as { asset_id: string; next_reassessment_at: string | null }[] | null) ?? [];
  const assetIds = [...new Set(posRows.map((p) => p.asset_id))];
  const assets = assetIds.length ? await supabase.schema('core').from('assets').select('id, symbol').in('id', assetIds) : { data: [] };
  const symbol = new Map(((assets.data as { id: string; symbol: string }[] | null) ?? []).map((a) => [a.id, a.symbol]));
  const strategyRows = ((strategies.data as unknown as AutonomyView['boundStrategies'] | null) ?? []);
  // Adversary statistics.
  const reviewRows = (reviews.data as { action_cycle_id: string; agent_run_id: string | null; deterministic_gate: boolean; verdict: string; objections: { code: string }[]; latency_ms: number; blocking: boolean; created_at: string }[] | null) ?? [];
  const cycleRows = (cycles7.data as { id: string; position_id: string | null; verdict: string | null; revision_round: number; state: string; unresolved_reason: string | null; intent_id: string | null }[] | null) ?? [];
  const verdicts: Record<string, number> = {};
  const codes = new Map<string, number>();
  let aiLatency = 0;
  let ai = 0;
  for (const r of reviewRows) {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    for (const o of r.objections ?? []) codes.set(o.code, (codes.get(o.code) ?? 0) + 1);
    if (!r.deterministic_gate) {
      ai++;
      aiLatency += r.latency_ms;
    }
  }
  const reviewedCycles = new Set(reviewRows.map((r) => r.action_cycle_id));
  const positionCycles = cycleRows.filter((c) => c.position_id !== null);
  const unresolved: Record<string, number> = {};
  for (const c of cycleRows) if (c.state === 'UNRESOLVED' && c.unresolved_reason) unresolved[c.unresolved_reason] = (unresolved[c.unresolved_reason] ?? 0) + 1;
  const revisionCycles = cycleRows.filter((c) => c.revision_round > 0);
  const lotRows = (lots.data as { entry_intent_id: string; realized_pnl_base_units: string; status: string }[] | null) ?? [];
  const intentIds = [...new Set(cycleRows.map((c) => c.intent_id).filter((x): x is string => !!x))];
  const verdictByIntent = new Map<string, { verdict: string | null; revised: boolean }>();
  for (const c of cycleRows) if (c.intent_id) verdictByIntent.set(c.intent_id, { verdict: c.verdict, revised: c.revision_round > 0 });
  const outcome = (pick: (v: { verdict: string | null; revised: boolean }) => boolean) => {
    const rel = lotRows.filter((l) => intentIds.includes(l.entry_intent_id) && pick(verdictByIntent.get(l.entry_intent_id)!));
    return { n: rel.length, realized: rel.length ? rel.reduce((a, l) => a + Number(l.realized_pnl_base_units) / 1e6, 0) : null };
  };
  const confirmed = outcome((v) => v.verdict === 'CONFIRM' && !v.revised);
  const challenged = outcome((v) => v.revised || v.verdict === 'CHALLENGE');
  const modelMap = new Map<string, { provider: string; model: string; runs: number; failures: number }>();
  for (const r of runRows.filter((x) => x.role === 'ACTION_ADVERSARY')) {
    const k = `${r.provider}/${r.model}`;
    const m = modelMap.get(k) ?? { provider: r.provider, model: r.model, runs: 0, failures: 0 };
    m.runs++;
    if (!r.success) m.failures++;
    modelMap.set(k, m);
  }
  return {
    ...base,
    skills: ((skills.data as unknown as SkillVersionRow[] | null) ?? []).map((s) => ({ ...s, supported_action_types: s.supported_action_types ?? [] })),
    guidelines: ((guidelines.data as unknown as AutonomyView['guidelines'] | null) ?? []).map((g) => ({ ...g, rules: Array.isArray(g.rules) ? g.rules : [] })),
    boundStrategies: strategyRows,
    usage: { runs24h: runs24.length, failedRuns24h: runs24.filter((r) => !r.success).length, refusals24h: refusals.count ?? 0, cycles24h: cycles24.count ?? 0, costUsd24h: runs24.reduce((a, r) => a + (r.cost_usd ?? 0), 0) },
    toolStats,
    automations: automationRows,
    nextReassessments: posRows.map((p) => ({ symbol: symbol.get(p.asset_id) ?? 'unknown', next_reassessment_at: p.next_reassessment_at, speed_tier: null })),
    adversary: {
      reviews: reviewRows.length,
      aiReviews: ai,
      deterministicReviews: reviewRows.length - ai,
      verdicts,
      objectionCodes: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 12),
      revisionCycles: revisionCycles.length,
      revisionCleared: revisionCycles.filter((c) => c.state === 'CLEARED').length,
      avgAiLatencyMs: ai ? Math.round(aiLatency / ai) : null,
      unresolved,
      positionCyclesWithoutReview: positionCycles.filter((c) => !reviewedCycles.has(c.id) && ['CLEARED', 'REJECTED'].includes(c.state)).length,
      positionCycles: positionCycles.length,
      outcomes: { confirmedRealized: confirmed.realized, confirmedLots: confirmed.n, challengedRealized: challenged.realized, challengedLots: challenged.n },
      adversaryModels: [...modelMap.values()],
    },
  };
}
