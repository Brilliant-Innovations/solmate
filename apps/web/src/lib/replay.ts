import { createSupabaseServerClient } from './supabase/server';

/**
 * Replay Lab read models (§20.15, §18.5, §30). Everything is the immutable replay record under
 * RLS: runs with their version record and digests, the §30 views computed from stored results,
 * and the decision timeline. Simulated time throughout; nothing here is or resembles live trading.
 */

export interface ReplayRunRow {
  id: string;
  name: string;
  fidelity: 'A_HISTORICAL' | 'B_CAPTURED' | 'C_LIVE_PAPER';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  requested_by: string | null;
  window_from: string;
  window_to: string;
  dataset_cutoff: string;
  in_sample_until: string | null;
  strategy_version_ids: string[];
  baseline_strategy_version_id: string;
  versions: Record<string, unknown>;
  models: { role: string; model: string; trainingCutoff: string | null; lookAhead: 'WITHIN_WINDOW' | 'POST_WINDOW' | 'UNKNOWN' }[];
  seed: number;
  latency_matched_baseline: boolean;
  proposer_only_shadow: boolean;
  calibration_target: { kind: string; horizonMs: number };
  asset_ids: string[] | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  decisions_digest: string | null;
  results_digest: string | null;
  error: string | null;
  results: Record<string, unknown> | null;
}

export interface LeaderboardRow {
  strategy_version_id: string;
  variant: string;
  sample: string;
  trades: number;
  net_pnl: number | null;
  gross_pnl: number | null;
  fees: number | null;
  slippage_cost: number | null;
  execution_shortfall_bps: number | null;
  win_rate: number | null;
  expectancy: number | null;
  profit_factor: number | null;
  max_drawdown: number | null;
  max_drawdown_fraction: number | null;
  time_in_market_fraction: number | null;
  turnover: number | null;
  sharpe: number | null;
  sortino: number | null;
  tail_loss: number | null;
  failed_execution_rate: number | null;
  average_decision_to_fill_ms: number | null;
  /** SOL-denominated network and priority fees, in lamports, and their settlement value when a SOL price was available (M-14). */
  fees_lamports: number | null;
  fees_lamports_as_settlement: number | null;
  net_includes_sol_fees: boolean | null;
  /** What the dataset could support, measured (H-1, M-10); null on runs recorded before the measurement existed. */
  observation_discipline: string | null;
  dataset_candles: number | null;
  dataset_candles_late_observed: number | null;
  dataset_max_observation_lag_ms: number | null;
  universe_selected: number | null;
  universe_available: number | null;
  universe_truncated: boolean | null;
}

export interface IncrementalRow {
  baseline_strategy_version_id: string;
  strategy_version_id: string;
  candidates: number;
  both_traded: number;
  filtered_losers: number;
  filtered_losers_baseline_net: number | null;
  rejected_winners: number;
  rejected_winners_baseline_net: number | null;
  admitted_not_baseline: number;
  admitted_not_baseline_net: number | null;
  both_passed: number;
  /** Candidates the deterministic risk core refused, excluded from every AI-filtering bucket (M-12). */
  risk_blocked: number | null;
  risk_blocked_ai: number | null;
  risk_blocked_baseline: number | null;
  risk_blocked_both: number | null;
  baseline_net_total: number | null;
  strategy_net_total: number | null;
  model_cost: number | null;
  incremental_net_expectancy: number | null;
}

export interface DisagreementRow {
  strategy_version_id: string;
  reviewed: number;
  confirmed: number;
  challenged: number;
  rejected: number;
  disagreement_rate: number | null;
  expectancy_after_confirm: number | null;
  expectancy_after_challenge: number | null;
  rejected_with_counterfactual: number;
  rejected_counterfactual_net: number | null;
  proposer_only_net: number | null;
  full_net: number | null;
  top_objections: { code: string; count: number }[];
}

export interface LatencyRow {
  strategy_version_id: string;
  decisions: number;
  expired_by_latency: number;
  chase_rejected: number;
  stale_quote_rejected: number;
  missed_baseline_net: number | null;
  average_decision_latency_ms: number | null;
  edge_lost_to_latency: number | null;
  /** Counters this run's data resolution cannot produce; a zero in them is an artefact, not a measurement (M-8, M-9). */
  structurally_unreachable: string[] | null;
}

export interface CalibrationRow {
  strategy_version_id: string;
  target_kind: string;
  scored: number;
  brier_score: number | null;
  bin: string;
  bin_count: number;
  mean_confidence: number | null;
  hit_rate: number | null;
  realized_expectancy: number | null;
}

export interface AttributionRow {
  dimension: string;
  strategy_version_id: string;
  group_key: string;
  sample_supported: boolean;
  trades: number;
  net_pnl: number | null;
  win_rate: number | null;
  expectancy: number | null;
  max_drawdown: number | null;
  execution_shortfall_bps: number | null;
}

export interface EconomicRow {
  window_days: number;
  platform_cost_for_window_usd: number;
  allocation: string;
  strategy_version_id: string;
  trading_net_usd: number;
  direct_cost_usd: number;
  strategy_economic_usd: number;
  platform_share_usd: number;
  platform_economic_usd: number;
  cost_to_edge_ratio: number | null;
}

export interface ExitRow {
  strategy_version_id: string;
  variant: string;
  sample: string;
  exit_reason: string;
  trades: number;
  net_pnl: number | null;
  expectancy: number | null;
  average_hold_ms: number | null;
  average_execution_shortfall_bps: number | null;
}

export interface DecisionRow {
  id: string;
  strategy_version_id: string;
  variant: string;
  at: string;
  candidate_id: string;
  asset_id: string;
  sample: string;
  cycle_state: string;
  action: string | null;
  proposer_confidence: number | null;
  adversary_verdict: string | null;
  reason_codes: string[];
  decision_latency_ms: number;
  rejection: string | null;
  fill: { inputAmount: string; outputAmount: string; executionShortfallBps: number | null; feesBaseUnits: string; executedAt: string } | null;
  outcome: { closedAt: string; realizedPnlBaseUnits: string; holdMs: number; exitReason: string; targetHit: boolean | null } | null;
}

export interface StrategyVersionOption {
  version_id: string;
  strategy_id: string;
  variant: string;
  status: string;
  speed_tier: string;
  max_decision_latency_ms: number;
  skill_version_id: string | null;
  guideline_version_id: string | null;
  automation_set_version_id: string | null;
  risk_policy_version: string;
  feature_version: string;
  git_sha: string;
  thresholds: Record<string, unknown>;
  active_from: string;
  active_to: string | null;
}

export interface ReplayRunDetail {
  run: ReplayRunRow;
  leaderboard: LeaderboardRow[];
  incremental: IncrementalRow[];
  disagreement: DisagreementRow[];
  latency: LatencyRow[];
  calibration: CalibrationRow[];
  attribution: AttributionRow[];
  economic: EconomicRow[];
  exits: ExitRow[];
  decisions: DecisionRow[];
  assets: Map<string, { symbol: string; decimals: number }>;
}

export const FIDELITY_LABEL: Record<ReplayRunRow['fidelity'], string> = {
  A_HISTORICAL: 'Level A · historical candles',
  B_CAPTURED: 'Level B · captured market',
  C_LIVE_PAPER: 'Level C · live paper/shadow',
};

export async function listReplayRuns(limit = 50): Promise<ReplayRunRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('research').from('replay_runs').select('*').order('created_at', { ascending: false }).limit(limit);
  return ((data as unknown as ReplayRunRow[] | null) ?? []).map((r) => ({ ...r, models: r.models ?? [] }));
}

export async function listStrategyVersionOptions(): Promise<StrategyVersionOption[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, variant, status, speed_tier, max_decision_latency_ms, skill_version_id, guideline_version_id, automation_set_version_id, risk_policy_version, feature_version, git_sha, thresholds, active_from, active_to').order('strategy_id').order('active_from', { ascending: false });
  return (data as unknown as StrategyVersionOption[] | null) ?? [];
}

export async function loadReplayRunDetail(id: string): Promise<ReplayRunDetail | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: run } = await supabase.schema('research').from('replay_runs').select('*').eq('id', id).maybeSingle();
  if (!run) return null;
  const views = supabase.schema('research');
  const [lb, iv, dg, lt, cb, at, ec, ex, dec] = await Promise.all([
    views.from('replay_leaderboard').select('*').eq('run_id', id).order('strategy_version_id').order('variant').order('sample'),
    views.from('replay_incremental_value').select('*').eq('run_id', id),
    views.from('replay_disagreement').select('*').eq('run_id', id),
    views.from('replay_latency_cost').select('*').eq('run_id', id),
    views.from('replay_calibration').select('*').eq('run_id', id).order('strategy_version_id').order('bin'),
    views.from('replay_attribution').select('*').eq('run_id', id).order('dimension').order('strategy_version_id').order('group_key'),
    views.from('replay_economic_pnl').select('*').eq('run_id', id),
    views.from('replay_exit_outcomes').select('*').eq('run_id', id).order('strategy_version_id').order('variant').order('exit_reason'),
    views.from('replay_decisions').select('*').eq('run_id', id).order('at').order('strategy_version_id').order('variant').limit(500),
  ]);
  const decisions = ((dec.data as unknown as DecisionRow[] | null) ?? []).map((d) => ({ ...d, reason_codes: d.reason_codes ?? [] }));
  const assetIds = [...new Set(decisions.map((d) => d.asset_id))];
  const { data: assets } = assetIds.length ? await supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', assetIds) : { data: [] };
  return {
    run: { ...(run as unknown as ReplayRunRow), models: (run as unknown as ReplayRunRow).models ?? [] },
    leaderboard: (lb.data as unknown as LeaderboardRow[] | null) ?? [],
    incremental: (iv.data as unknown as IncrementalRow[] | null) ?? [],
    disagreement: ((dg.data as unknown as DisagreementRow[] | null) ?? []).map((d) => ({ ...d, top_objections: d.top_objections ?? [] })),
    latency: (lt.data as unknown as LatencyRow[] | null) ?? [],
    calibration: (cb.data as unknown as CalibrationRow[] | null) ?? [],
    attribution: (at.data as unknown as AttributionRow[] | null) ?? [],
    economic: (ec.data as unknown as EconomicRow[] | null) ?? [],
    exits: (ex.data as unknown as ExitRow[] | null) ?? [],
    decisions,
    assets: new Map(((assets as { id: string; symbol: string; decimals: number }[] | null) ?? []).map((a) => [a.id, { symbol: a.symbol, decimals: a.decimals }])),
  };
}

export const num = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 ? Math.min(digits, 2) : 0 }));
export const pctOf = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(0)}%`);
export const durationOf = (ms: number | null | undefined): string => (ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(0)} min` : `${(ms / 1000).toFixed(1)} s`);
export const baseToUnits = (base: string | null | undefined, decimals: number): number | null => (base === null || base === undefined ? null : Number(base) / 10 ** decimals);
export const statusTone = (s: ReplayRunRow['status']): string => (s === 'COMPLETED' ? 'ok' : s === 'FAILED' ? 'failed' : s === 'RUNNING' ? 'starting' : 'watch');
export const lookAheadTone = (l: ReplayRunRow['models'][number]['lookAhead']): string => (l === 'WITHIN_WINDOW' ? 'ok' : l === 'POST_WINDOW' ? 'failed' : 'degraded');
