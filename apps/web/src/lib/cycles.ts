import { createSupabaseServerClient } from './supabase/server';

/**
 * Read models for Agent Activity (§20.6) and the Decision / Action Inspector (§20.7). Every row is
 * an RLS-scoped projection of ledger tables that the worker wrote; the browser derives no
 * authority from them. Joins are done here rather than through PostgREST embedding so a missing
 * related row shows as "unknown" instead of hiding the cycle. Deterministic facts (gate output,
 * risk evaluation, authorization hash, fills) and AI interpretation (proposer thesis, adversary
 * objections from a model run) are kept in separate fields so the pages can label them.
 */

export interface CycleRow {
  id: string;
  candidate_id: string | null;
  position_id: string | null;
  strategy_version_id: string;
  skill_version_id: string | null;
  speed_tier: string;
  decision_budget_ms: number;
  proposed_action: string | null;
  proposal_id: string | null;
  proposer_run_ids: string[];
  adversary_run_ids: string[];
  verdict: string | null;
  reason_codes: string[];
  revision_round: number;
  state: string;
  unresolved_reason: string | null;
  cutoffs: { version: number; at: string; consumedByRunIds: string[] }[];
  cleared_cutoff_version: number | null;
  risk_evaluation_id: string | null;
  intent_id: string | null;
  automation_run_id: string | null;
  started_at: string;
  terminal_at: string | null;
}

export interface AssetRef {
  id: string;
  symbol: string;
  mint: string;
  decimals: number;
}

export interface CycleView extends CycleRow {
  asset: AssetRef | null;
  strategy: { strategy_id: string; variant: string } | null;
  trigger: { family: string; discovered_at: string } | null;
  proposal: { source: string; confidence: number; thesis: string; expires_at: string } | null;
  review: { verdict: string; deterministic_gate: boolean; objections: { code: string; detail: string }[]; blocking: boolean } | null;
  /** Position review state at read time, for open-position cycles. */
  position_review: { review_state: string; review_state_reason: string | null; review_state_since: string } | null;
}

export type CycleStatusFilter = 'active' | 'completed' | 'failed' | '';

export interface CycleFilters {
  status?: CycleStatusFilter;
  strategy?: string;
  action?: string;
  /** 'agree' = proposer/adversary agreed (CONFIRM), 'disagree' = CHALLENGE or REJECT. */
  agreement?: 'agree' | 'disagree' | '';
  token?: string;
  result?: string;
  /** Cycles that failed to clear, by state or unresolved reason. */
  failReason?: string;
  /** Only cycles that reassess this open position. */
  positionId?: string;
  limit?: number;
}

const ACTIVE_STATES = ['TRIGGERED', 'CONTEXT_BUILT', 'PROPOSED', 'REVISION_REQUESTED'];
const FAILED_STATES = ['REJECTED', 'EXPIRED', 'UNRESOLVED'];

export const CYCLE_PAGE_SIZE = 100;

export function stageLabel(c: CycleView): string {
  if (c.position_review && c.position_review.review_state !== 'REVIEWED') {
    return c.position_review.review_state === 'PROTECTION_ONLY' ? 'PROTECTION_ONLY (unreviewed)' : c.position_review.review_state;
  }
  switch (c.state) {
    case 'TRIGGERED':
      return 'TRIGGERED';
    case 'CONTEXT_BUILT':
      return 'EVIDENCE BUILT';
    case 'PROPOSED':
      return c.revision_round > 0 ? 'ADVERSARY ROUND 2' : 'ADVERSARY ROUND 1';
    case 'REVISION_REQUESTED':
      return 'PROPOSER REVISION';
    case 'CLEARED':
      return c.intent_id ? 'CLEARED → INTENT' : 'CLEARED';
    case 'UNRESOLVED':
      return `UNRESOLVED (${c.unresolved_reason ?? 'unknown'})`;
    default:
      return c.state;
  }
}

export async function loadCycles(f: CycleFilters): Promise<CycleView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  let q = supabase
    .schema('agents')
    .from('action_cycles')
    .select('id, candidate_id, position_id, strategy_version_id, skill_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, automation_run_id, started_at, terminal_at')
    .order('started_at', { ascending: false })
    .limit(f.limit ?? CYCLE_PAGE_SIZE);
  if (f.status === 'active') q = q.in('state', ACTIVE_STATES as never[]);
  else if (f.status === 'completed') q = q.eq('state', 'CLEARED' as never);
  else if (f.status === 'failed') q = q.in('state', FAILED_STATES as never[]);
  if (f.strategy) q = q.eq('strategy_version_id', f.strategy);
  if (f.action) q = q.eq('proposed_action', f.action as never);
  if (f.agreement === 'agree') q = q.eq('verdict', 'CONFIRM' as never);
  else if (f.agreement === 'disagree') q = q.in('verdict', ['CHALLENGE', 'REJECT'] as never[]);
  if (f.result) q = q.eq('state', f.result as never);
  if (f.positionId) q = q.eq('position_id', f.positionId);
  if (f.failReason) q = q.or(`unresolved_reason.eq.${f.failReason},reason_codes.cs.{${f.failReason}}`);
  const { data } = await q;
  const rows = ((data as unknown as CycleRow[] | null) ?? []).map(normalise);
  const views = await hydrate(rows);
  if (f.token) {
    const t = f.token.trim().toLowerCase();
    return views.filter((v) => v.asset && (v.asset.symbol.toLowerCase() === t || v.asset.mint === f.token!.trim()));
  }
  return views;
}

/** Open positions whose review state is not REVIEWED: shown at the top of Agent Activity (§13.7B, §20.6). */
export async function loadUnreviewedPositions(): Promise<{ id: string; symbol: string; review_state: string; review_state_reason: string | null; review_state_since: string }[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('trading').from('positions').select('id, asset_id, review_state, review_state_reason, review_state_since').eq('status', 'OPEN' as never).neq('review_state', 'REVIEWED' as never).limit(50);
  const rows = (data as { id: string; asset_id: string; review_state: string; review_state_reason: string | null; review_state_since: string }[] | null) ?? [];
  const assets = await loadAssets(supabase, rows.map((r) => r.asset_id));
  return rows.map((r) => ({ id: r.id, symbol: assets.get(r.asset_id)?.symbol ?? 'unknown', review_state: r.review_state, review_state_reason: r.review_state_reason, review_state_since: r.review_state_since }));
}

export async function loadCycleFacets(): Promise<{ strategies: string[]; actions: string[]; failReasons: string[] }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { strategies: [], actions: [], failReasons: [] };
  const { data } = await supabase.schema('agents').from('action_cycles').select('strategy_version_id, proposed_action, unresolved_reason, reason_codes, state').order('started_at', { ascending: false }).limit(2000);
  const rows = (data as { strategy_version_id: string; proposed_action: string | null; unresolved_reason: string | null; reason_codes: string[]; state: string }[] | null) ?? [];
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort();
  return {
    strategies: uniq(rows.map((r) => r.strategy_version_id)),
    actions: uniq(rows.map((r) => r.proposed_action)),
    failReasons: uniq(rows.flatMap((r) => (FAILED_STATES.includes(r.state) ? [r.unresolved_reason, ...(r.reason_codes ?? [])] : []))),
  };
}

// Inspector ---------------------------------------------------------------------------------------

export interface RunView {
  id: string;
  role: string;
  provider: string;
  model: string;
  prompt_version: string;
  cutoff_version: number;
  cutoff_at: string;
  structured_output: Record<string, unknown> | null;
  input_evidence_ids: string[];
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  schema_validation: Record<string, unknown>;
  created_at: string;
}

export interface ProposalView {
  id: string;
  source: string;
  proposal: Record<string, unknown> & { actionType?: string; thesis?: string; confidence?: number; invalidation?: string; reasoningSummary?: string; evidenceCutoffVersion?: number; supportingEvidenceIds?: string[]; contradictingEvidenceIds?: string[]; expiresAt?: string; urgency?: string };
  created_at: string;
  expires_at: string;
}

export interface ReviewView {
  id: string;
  agent_run_id: string | null;
  deterministic_gate: boolean;
  verdict: string;
  objections: { code: string; detail: string; evidenceIds?: string[] }[];
  confidence: number | null;
  cutoff_version: number;
  latency_ms: number;
  blocking: boolean;
  created_at: string;
}

export interface RiskEvaluationView {
  id: string;
  policy_version: string;
  allowed: boolean;
  reason_codes: string[];
  computed_position_amount: string | null;
  computed_max_loss_base_units: string | null;
  max_slippage_bps: number;
  max_price_impact_bps: number;
  stop_policy: Record<string, unknown> | null;
  target_policy: Record<string, unknown> | null;
  daily_drawdown_fraction: number;
  circuit_breaker_tripped: boolean;
  stale_data_checks: { dataClass: string; fresh: boolean; ageMs: number | null; limitMs: number }[];
  created_at: string;
}

export interface IntentView {
  id: string;
  action: string;
  side: string;
  input_mint: string;
  output_mint: string;
  max_input_amount: string;
  lifecycle_state: string;
  approval_required: boolean;
  created_at: string;
  expires_at: string;
}

export interface AttemptView {
  id: string;
  attempt_number: number;
  state: string;
  router: string | null;
  expected_tx_signature: string | null;
  signed_at: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  finalized_at: string | null;
  not_landed_reason: string | null;
  execution_path: string | null;
}

export interface FillView {
  id: string;
  tx_signature: string;
  commitment: string;
  input_amount: string;
  output_amount: string;
  execution_shortfall_bps: number | null;
  execution_path: string;
  filled_at: string;
}

export interface ToolCallView {
  tool_name: string;
  tool_version: string;
  classification: string;
  cutoff_version: number;
  latency_ms: number;
  error: string | null;
  created_at: string;
}

export interface ToolRefusalView {
  requested_tool: string;
  reason: string;
  detail: string;
  created_at: string;
}

export interface BaselineView {
  cycle: CycleView;
  intent: IntentView | null;
  fills: FillView[];
  /** Realized P&L of the lot this baseline intent opened, when it has closed. */
  realized_pnl_base_units: string | null;
  lot_status: string | null;
}

export interface CycleInspectorView {
  cycle: CycleView;
  proposals: ProposalView[];
  reviews: ReviewView[];
  runs: RunView[];
  toolCalls: ToolCallView[];
  toolRefusals: ToolRefusalView[];
  risk: RiskEvaluationView | null;
  intent: IntentView | null;
  authorizationHash: string | null;
  attempts: AttemptView[];
  fills: FillView[];
  automationRun: { automation_version_id: string; disposition: string; trigger_event: Record<string, unknown>; created_at: string } | null;
  baselines: BaselineView[];
  position: { id: string; status: string; quantity: string; unrealized_pnl_base_units: string | null; realized_pnl_base_units: string; review_state: string; review_state_reason: string | null; closed_at: string | null } | null;
}

export async function loadCycleInspector(id: string): Promise<CycleInspectorView | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: raw } = await supabase
    .schema('agents')
    .from('action_cycles')
    .select('id, candidate_id, position_id, strategy_version_id, skill_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, automation_run_id, started_at, terminal_at')
    .eq('id', id)
    .maybeSingle();
  if (!raw) return null;
  const [cycle] = await hydrate([normalise(raw as unknown as CycleRow)]);
  if (!cycle) return null;

  const [proposals, reviews, runs, toolCalls, toolRefusals, risk, intent, automationRun, position] = await Promise.all([
    supabase.schema('trading').from('proposals').select('id, source, proposal, created_at, expires_at').eq('action_cycle_id', id).order('created_at', { ascending: true }),
    supabase.schema('agents').from('adversarial_reviews').select('id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at').eq('action_cycle_id', id).order('created_at', { ascending: true }),
    supabase.schema('agents').from('runs').select('id, role, provider, model, prompt_version, cutoff_version, cutoff_at, structured_output, input_evidence_ids, cost_usd, latency_ms, success, schema_validation, created_at').eq('action_cycle_id', id).order('created_at', { ascending: true }),
    supabase.schema('agents').from('tool_invocations').select('tool_name, tool_version, classification, cutoff_version, latency_ms, error, created_at').eq('action_cycle_id', id).order('created_at', { ascending: true }),
    supabase.schema('agents').from('tool_refusals').select('requested_tool, reason, detail, created_at').eq('action_cycle_id', id).order('created_at', { ascending: true }),
    cycle.risk_evaluation_id
      ? supabase.schema('trading').from('risk_evaluations').select('id, policy_version, allowed, reason_codes, computed_position_amount, computed_max_loss_base_units, max_slippage_bps, max_price_impact_bps, stop_policy, target_policy, daily_drawdown_fraction, circuit_breaker_tripped, stale_data_checks, created_at').eq('id', cycle.risk_evaluation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    cycle.intent_id ? loadIntent(supabase, cycle.intent_id) : Promise.resolve(null),
    cycle.automation_run_id ? supabase.schema('agents').from('automation_runs').select('automation_version_id, disposition, trigger_event, created_at').eq('id', cycle.automation_run_id).maybeSingle() : Promise.resolve({ data: null }),
    cycle.position_id ? supabase.schema('trading').from('positions').select('id, status, quantity, unrealized_pnl_base_units, realized_pnl_base_units, review_state, review_state_reason, closed_at').eq('id', cycle.position_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const execution = intent ? await loadExecution(supabase, intent.id) : { authorizationHash: null, attempts: [], fills: [] };
  const baselines = await loadBaselines(supabase, cycle);

  return {
    cycle,
    proposals: ((proposals.data as unknown as ProposalView[] | null) ?? []),
    reviews: ((reviews.data as unknown as ReviewView[] | null) ?? []),
    runs: ((runs.data as unknown as RunView[] | null) ?? []),
    toolCalls: ((toolCalls.data as unknown as ToolCallView[] | null) ?? []),
    toolRefusals: ((toolRefusals.data as unknown as ToolRefusalView[] | null) ?? []),
    risk: (risk.data as unknown as RiskEvaluationView | null) ?? null,
    intent,
    ...execution,
    automationRun: (automationRun.data as unknown as CycleInspectorView['automationRun']) ?? null,
    baselines,
    position: (position.data as unknown as CycleInspectorView['position']) ?? null,
  };
}

// Internals --------------------------------------------------------------------------------------

type Client = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

function normalise(r: CycleRow): CycleRow {
  return { ...r, proposer_run_ids: r.proposer_run_ids ?? [], adversary_run_ids: r.adversary_run_ids ?? [], reason_codes: r.reason_codes ?? [], cutoffs: Array.isArray(r.cutoffs) ? r.cutoffs : [] };
}

async function loadAssets(supabase: Client, ids: string[]): Promise<Map<string, AssetRef>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const { data } = await supabase.schema('core').from('assets').select('id, symbol, mint_address, decimals').in('id', uniq);
  return new Map(((data as { id: string; symbol: string; mint_address: string; decimals: number }[] | null) ?? []).map((a) => [a.id, { id: a.id, symbol: a.symbol, mint: a.mint_address, decimals: a.decimals }]));
}

async function hydrate(rows: CycleRow[]): Promise<CycleView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase || rows.length === 0) return [];
  const candidateIds = [...new Set(rows.map((r) => r.candidate_id).filter((x): x is string => !!x))];
  const positionIds = [...new Set(rows.map((r) => r.position_id).filter((x): x is string => !!x))];
  const cycleIds = rows.map((r) => r.id);
  const strategyIds = [...new Set(rows.map((r) => r.strategy_version_id))];
  const [candidates, positions, strategies, proposals, reviews] = await Promise.all([
    candidateIds.length ? supabase.schema('signals').from('candidates').select('id, asset_id, trigger_family, discovered_at').in('id', candidateIds) : Promise.resolve({ data: [] }),
    positionIds.length ? supabase.schema('trading').from('positions').select('id, asset_id, review_state, review_state_reason, review_state_since').in('id', positionIds) : Promise.resolve({ data: [] }),
    supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, variant').in('version_id', strategyIds),
    supabase.schema('trading').from('proposals').select('action_cycle_id, source, proposal, expires_at, created_at').in('action_cycle_id', cycleIds).order('created_at', { ascending: false }),
    supabase.schema('agents').from('adversarial_reviews').select('action_cycle_id, verdict, deterministic_gate, objections, blocking, created_at').in('action_cycle_id', cycleIds).order('created_at', { ascending: false }),
  ]);
  const cands = new Map(((candidates.data as { id: string; asset_id: string; trigger_family: string; discovered_at: string }[] | null) ?? []).map((c) => [c.id, c]));
  const poss = new Map(((positions.data as { id: string; asset_id: string; review_state: string; review_state_reason: string | null; review_state_since: string }[] | null) ?? []).map((p) => [p.id, p]));
  const strats = new Map(((strategies.data as { version_id: string; strategy_id: string; variant: string }[] | null) ?? []).map((s) => [s.version_id, s]));
  const assets = await loadAssets(supabase, [...[...cands.values()].map((c) => c.asset_id), ...[...poss.values()].map((p) => p.asset_id)]);
  const latestProposal = new Map<string, { source: string; proposal: { confidence?: number; thesis?: string }; expires_at: string }>();
  for (const p of (proposals.data as { action_cycle_id: string; source: string; proposal: { confidence?: number; thesis?: string }; expires_at: string }[] | null) ?? []) if (!latestProposal.has(p.action_cycle_id)) latestProposal.set(p.action_cycle_id, p);
  const latestReview = new Map<string, { verdict: string; deterministic_gate: boolean; objections: { code: string; detail: string }[]; blocking: boolean }>();
  for (const r of (reviews.data as { action_cycle_id: string; verdict: string; deterministic_gate: boolean; objections: { code: string; detail: string }[]; blocking: boolean }[] | null) ?? []) if (!latestReview.has(r.action_cycle_id)) latestReview.set(r.action_cycle_id, r);
  return rows.map((r) => {
    const cand = r.candidate_id ? cands.get(r.candidate_id) : undefined;
    const pos = r.position_id ? poss.get(r.position_id) : undefined;
    const assetId = cand?.asset_id ?? pos?.asset_id;
    const s = strats.get(r.strategy_version_id);
    const p = latestProposal.get(r.id);
    const rv = latestReview.get(r.id);
    return {
      ...r,
      asset: assetId ? (assets.get(assetId) ?? null) : null,
      strategy: s ? { strategy_id: s.strategy_id, variant: s.variant } : null,
      trigger: cand ? { family: cand.trigger_family, discovered_at: cand.discovered_at } : null,
      proposal: p ? { source: p.source, confidence: Number(p.proposal?.confidence ?? NaN), thesis: p.proposal?.thesis ?? '', expires_at: p.expires_at } : null,
      review: rv ? { verdict: rv.verdict, deterministic_gate: rv.deterministic_gate, objections: rv.objections ?? [], blocking: rv.blocking } : null,
      position_review: pos ? { review_state: pos.review_state, review_state_reason: pos.review_state_reason, review_state_since: pos.review_state_since } : null,
    };
  });
}

async function loadIntent(supabase: Client, intentId: string): Promise<IntentView | null> {
  const { data } = await supabase.schema('trading').from('intents').select('id, action, side, input_mint, output_mint, max_input_amount, lifecycle_state, approval_required, created_at, expires_at').eq('id', intentId).maybeSingle();
  return (data as unknown as IntentView | null) ?? null;
}

async function loadExecution(supabase: Client, intentId: string): Promise<{ authorizationHash: string | null; attempts: AttemptView[]; fills: FillView[] }> {
  const [auth, orders, attempts] = await Promise.all([
    supabase.schema('trading').from('risk_authorizations').select('authorization_hash').eq('intent_id', intentId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('trading').from('orders').select('id, execution_path').eq('intent_id', intentId),
    supabase.schema('trading').from('order_attempts').select('id, order_id, attempt_number, state, router, expected_tx_signature, signed_at, submitted_at, confirmed_at, finalized_at, not_landed_reason').eq('intent_id', intentId).order('attempt_number', { ascending: true }),
  ]);
  const paths = new Map(((orders.data as { id: string; execution_path: string }[] | null) ?? []).map((o) => [o.id, o.execution_path]));
  const attemptRows = ((attempts.data as unknown as (AttemptView & { order_id: string })[] | null) ?? []).map((a) => ({ ...a, execution_path: paths.get(a.order_id) ?? null }));
  const attemptIds = attemptRows.map((a) => a.id);
  const fills = attemptIds.length
    ? await supabase.schema('trading').from('fills').select('id, tx_signature, commitment, input_amount, output_amount, execution_shortfall_bps, execution_path, filled_at').in('order_attempt_id', attemptIds).order('filled_at', { ascending: true })
    : { data: [] };
  return {
    authorizationHash: (auth.data as { authorization_hash: string } | null)?.authorization_hash ?? null,
    attempts: attemptRows,
    fills: ((fills.data as unknown as FillView[] | null) ?? []),
  };
}

/**
 * §20.7 baseline counterfactual: what S0_RAW and S0_SAFE decided for the same candidate (or the
 * same position), and the realized outcome of the lot a baseline entry opened. The two S0 labels
 * are never collapsed (§12.1).
 */
async function loadBaselines(supabase: Client, cycle: CycleView): Promise<BaselineView[]> {
  let q = supabase
    .schema('agents')
    .from('action_cycles')
    .select('id, candidate_id, position_id, strategy_version_id, skill_version_id, speed_tier, decision_budget_ms, proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, automation_run_id, started_at, terminal_at')
    .neq('id', cycle.id)
    .order('started_at', { ascending: false })
    .limit(10);
  if (cycle.candidate_id) q = q.eq('candidate_id', cycle.candidate_id);
  else if (cycle.position_id) q = q.eq('position_id', cycle.position_id);
  else return [];
  const { data } = await q;
  const rows = await hydrate(((data as unknown as CycleRow[] | null) ?? []).map(normalise));
  const baselines = rows.filter((r) => r.strategy?.strategy_id === 'S0_RAW' || r.strategy?.strategy_id === 'S0_SAFE' || r.strategy_version_id.startsWith('S0_'));
  return Promise.all(
    baselines.map(async (b) => {
      const intent = b.intent_id ? await loadIntent(supabase, b.intent_id) : null;
      const execution = intent ? await loadExecution(supabase, intent.id) : { fills: [] };
      const lot = intent
        ? await supabase.schema('trading').from('position_lots').select('realized_pnl_base_units, status').eq('entry_intent_id', intent.id).limit(1).maybeSingle()
        : { data: null };
      const lotRow = lot.data as { realized_pnl_base_units: string; status: string } | null;
      return { cycle: b, intent, fills: execution.fills, realized_pnl_base_units: lotRow?.realized_pnl_base_units ?? null, lot_status: lotRow?.status ?? null };
    }),
  );
}
