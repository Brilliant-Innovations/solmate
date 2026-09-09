import { createSupabaseServerClient } from './supabase/server';
import { listReplayRuns, listStrategyVersionOptions, type CalibrationRow, type DisagreementRow, type IncrementalRow, type LatencyRow, type LeaderboardRow, type ReplayRunRow, type StrategyVersionOption } from './replay';

/**
 * Strategy Lab read models (§20.11). S0_RAW and S0_SAFE are separate rows everywhere. Versions
 * and their bindings are ledger facts; the paper leaderboard comes from closed strategy lots; the
 * replay leaderboard, baseline comparison, calibration, disagreement and latency views come from
 * the latest completed replay run; promotion and retirement history from research.releases.
 * Nothing is editable: a change is a new version (§31 immutable strategy versions).
 */

export interface PaperLeaderboardRow {
  strategyVersionId: string;
  closedLots: number;
  openLots: number;
  wins: number;
  realizedUsdc: number;
  costBasisUsdc: number;
  expectancyUsdc: number | null;
  firstOpenedAt: string | null;
  lastClosedAt: string | null;
}

export interface ReleaseRow {
  id: string;
  digest: string;
  status: string;
  binding: Record<string, unknown>;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
}

export interface VersionDiff {
  strategyId: string;
  current: StrategyVersionOption;
  prior: StrategyVersionOption | null;
  changes: { field: string; before: string; after: string }[];
}

export interface StrategyLabView {
  versions: StrategyVersionOption[];
  paper: PaperLeaderboardRow[];
  releases: ReleaseRow[];
  latestRun: ReplayRunRow | null;
  leaderboard: LeaderboardRow[];
  incremental: IncrementalRow[];
  calibration: CalibrationRow[];
  disagreement: DisagreementRow[];
  latency: LatencyRow[];
  attributionByRegime: { strategy_version_id: string; group_key: string; trades: number; net_pnl: number | null; win_rate: number | null; sample_supported: boolean }[];
  diffs: VersionDiff[];
}

const flat = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function diffVersions(versions: readonly StrategyVersionOption[]): VersionDiff[] {
  const byStrategy = new Map<string, StrategyVersionOption[]>();
  for (const v of versions) byStrategy.set(v.strategy_id, [...(byStrategy.get(v.strategy_id) ?? []), v]);
  const out: VersionDiff[] = [];
  for (const [strategyId, list] of byStrategy) {
    const sorted = [...list].sort((a, b) => Date.parse(b.active_from) - Date.parse(a.active_from));
    const current = sorted[0]!;
    const prior = sorted[1] ?? null;
    const changes: VersionDiff['changes'] = [];
    if (prior) {
      const fields: (keyof StrategyVersionOption)[] = ['speed_tier', 'max_decision_latency_ms', 'skill_version_id', 'guideline_version_id', 'automation_set_version_id', 'risk_policy_version', 'feature_version', 'git_sha', 'status'];
      for (const f of fields) if (flat(current[f]) !== flat(prior[f])) changes.push({ field: f, before: flat(prior[f]), after: flat(current[f]) });
      const keys = new Set([...Object.keys(current.thresholds ?? {}), ...Object.keys(prior.thresholds ?? {})]);
      for (const k of [...keys].sort()) if (flat(current.thresholds?.[k]) !== flat(prior.thresholds?.[k])) changes.push({ field: `thresholds.${k}`, before: flat(prior.thresholds?.[k]), after: flat(current.thresholds?.[k]) });
    }
    out.push({ strategyId, current, prior, changes });
  }
  return out.sort((a, b) => (a.strategyId < b.strategyId ? -1 : 1));
}

export async function loadStrategyLab(): Promise<StrategyLabView> {
  const supabase = await createSupabaseServerClient();
  const empty: StrategyLabView = { versions: [], paper: [], releases: [], latestRun: null, leaderboard: [], incremental: [], calibration: [], disagreement: [], latency: [], attributionByRegime: [], diffs: [] };
  if (!supabase) return empty;
  const [versions, runs, lots, releases] = await Promise.all([
    listStrategyVersionOptions(),
    listReplayRuns(30),
    supabase.schema('trading').from('position_lots').select('strategy_version_id, status, realized_pnl_base_units, cost_basis_base_units, opened_at, closed_at').order('opened_at', { ascending: false }).limit(2000),
    supabase.schema('research').from('releases').select('id, digest, status, binding, created_at, promoted_at, retired_at').order('created_at', { ascending: false }).limit(50),
  ]);
  const paperBy = new Map<string, PaperLeaderboardRow>();
  for (const l of (lots.data as unknown as { strategy_version_id: string; status: string; realized_pnl_base_units: string; cost_basis_base_units: string; opened_at: string; closed_at: string | null }[] | null) ?? []) {
    const row = paperBy.get(l.strategy_version_id) ?? { strategyVersionId: l.strategy_version_id, closedLots: 0, openLots: 0, wins: 0, realizedUsdc: 0, costBasisUsdc: 0, expectancyUsdc: null, firstOpenedAt: null, lastClosedAt: null };
    if (l.status === 'CLOSED') {
      row.closedLots++;
      const realized = Number(l.realized_pnl_base_units) / 1e6;
      row.realizedUsdc += realized;
      row.costBasisUsdc += Number(l.cost_basis_base_units) / 1e6;
      if (realized > 0) row.wins++;
      if (l.closed_at && (!row.lastClosedAt || l.closed_at > row.lastClosedAt)) row.lastClosedAt = l.closed_at;
    } else row.openLots++;
    if (!row.firstOpenedAt || l.opened_at < row.firstOpenedAt) row.firstOpenedAt = l.opened_at;
    paperBy.set(l.strategy_version_id, row);
  }
  const paper = [...paperBy.values()].map((r) => ({ ...r, expectancyUsdc: r.closedLots ? r.realizedUsdc / r.closedLots : null })).sort((a, b) => (a.strategyVersionId < b.strategyVersionId ? -1 : 1));
  const latestRun = runs.find((r) => r.status === 'COMPLETED') ?? null;
  let leaderboard: LeaderboardRow[] = [];
  let incremental: IncrementalRow[] = [];
  let calibration: CalibrationRow[] = [];
  let disagreement: DisagreementRow[] = [];
  let latency: LatencyRow[] = [];
  let attributionByRegime: StrategyLabView['attributionByRegime'] = [];
  if (latestRun) {
    const views = supabase.schema('research');
    const [lb, iv, cb, dg, lt, at] = await Promise.all([
      views.from('replay_leaderboard').select('*').eq('run_id', latestRun.id).eq('sample', 'ALL').order('strategy_version_id').order('variant'),
      views.from('replay_incremental_value').select('*').eq('run_id', latestRun.id),
      views.from('replay_calibration').select('*').eq('run_id', latestRun.id).gt('bin_count', 0),
      views.from('replay_disagreement').select('*').eq('run_id', latestRun.id),
      views.from('replay_latency_cost').select('*').eq('run_id', latestRun.id),
      views.from('replay_attribution').select('strategy_version_id, group_key, trades, net_pnl, win_rate, sample_supported').eq('run_id', latestRun.id).eq('dimension', 'regime').order('strategy_version_id').order('group_key'),
    ]);
    leaderboard = (lb.data as unknown as LeaderboardRow[] | null) ?? [];
    incremental = (iv.data as unknown as IncrementalRow[] | null) ?? [];
    calibration = (cb.data as unknown as CalibrationRow[] | null) ?? [];
    disagreement = ((dg.data as unknown as DisagreementRow[] | null) ?? []).map((d) => ({ ...d, top_objections: d.top_objections ?? [] }));
    latency = (lt.data as unknown as LatencyRow[] | null) ?? [];
    attributionByRegime = (at.data as unknown as StrategyLabView['attributionByRegime'] | null) ?? [];
  }
  return { versions, paper, releases: (releases.data as unknown as ReleaseRow[] | null) ?? [], latestRun, leaderboard, incremental, calibration, disagreement, latency, attributionByRegime, diffs: diffVersions(versions) };
}
