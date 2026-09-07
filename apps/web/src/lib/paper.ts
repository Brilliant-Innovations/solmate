import { createSupabaseServerClient } from './supabase/server';

/**
 * Read models for the thin operational UI (blueprint §20.1, §20.2, §20.19, §20.21; plan M5a).
 * Every loader is an RLS-scoped projection of ledger state: the browser never derives authority
 * from what it reads, and a missing value is returned as null so pages show "no data" rather
 * than zero. Amounts arrive as base-unit strings; the settlement mint is USDC (6 decimals).
 */

const USDC_DECIMALS = 6;
export const baseToUsd = (baseUnits: string | number | null | undefined): number | null => (baseUnits === null || baseUnits === undefined ? null : Number(baseUnits) / 10 ** USDC_DECIMALS);

export interface PaperAccountRow {
  id: string;
  name: string;
  cluster: string;
  settlement_mint: string;
}

export interface SnapshotRow {
  as_of: string;
  equity_base_units: string;
  exposure_base_units: string;
  exposure_fraction: number;
  drawdown: { dailyFraction?: number; rollingFraction?: number } | null;
}

export interface SessionView {
  id: string;
  profile: string;
  activity_state: string;
  capital_authority: string;
  paused: { active?: boolean; reason?: string | null; since?: string | null; by?: string | null } | null;
  attended: boolean;
  last_presence_heartbeat_at: string | null;
  actual_start_at: string | null;
  cold_start_gates: { name: string; passed: boolean; checkedAt: string; detail: string | null }[];
  transitions: { from: string; to: string; at: string; actor: string; reason: string | null }[];
  wind_down_blockers: string[];
}

export interface PositionView {
  id: string;
  symbol: string;
  mint: string;
  decimals: number;
  quantity: string;
  average_entry_price: number | null;
  cost_basis_base_units: string;
  unrealized_pnl_base_units: string | null;
  realized_pnl_base_units: string;
  stop: { level?: number | null; model?: string; distanceFraction?: number } | null;
  unreviewed_stop: number | null;
  status: string;
  review_state: string;
  safety_state: string;
  opened_at: string;
  closed_at: string | null;
  strategies: string[];
}

export interface AlertView {
  id: string;
  severity: string;
  alert_class: string;
  summary: string;
  raised_at: string;
  acknowledged_at: string | null;
  automated_response: string | null;
}

export async function loadPaperAccount(): Promise<PaperAccountRow | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.schema('trading').from('accounts').select('id, name, cluster, settlement_mint').eq('mode', 'PAPER').order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as PaperAccountRow | null) ?? null;
}

/** Latest snapshot plus the first of the UTC day, for equity, exposure and day P&L chips. */
export async function loadEquity(accountId: string): Promise<{ latest: SnapshotRow | null; dayStart: SnapshotRow | null }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { latest: null, dayStart: null };
  const dayStartIso = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [latest, dayStart] = await Promise.all([
    supabase.schema('trading').from('portfolio_snapshots').select('as_of, equity_base_units, exposure_base_units, exposure_fraction, drawdown').eq('account_id', accountId).order('as_of', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('trading').from('portfolio_snapshots').select('as_of, equity_base_units, exposure_base_units, exposure_fraction, drawdown').eq('account_id', accountId).gte('as_of', dayStartIso).order('as_of', { ascending: true }).limit(1).maybeSingle(),
  ]);
  return { latest: (latest.data as SnapshotRow | null) ?? null, dayStart: (dayStart.data as SnapshotRow | null) ?? null };
}

export async function loadSessionView(accountId: string): Promise<SessionView | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase
    .schema('ops')
    .from('runtime_sessions')
    .select('id, profile, activity_state, capital_authority, paused, attended, last_presence_heartbeat_at, actual_start_at, cold_start_gates, transitions, wind_down_blockers')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as SessionView;
  return { ...row, cold_start_gates: row.cold_start_gates ?? [], transitions: row.transitions ?? [], wind_down_blockers: row.wind_down_blockers ?? [] };
}

export async function loadPositions(accountId: string, opts: { includeClosed: boolean; limit: number }): Promise<PositionView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  let query = supabase
    .schema('trading')
    .from('positions')
    .select('id, mint, quantity, average_entry_price, cost_basis_base_units, unrealized_pnl_base_units, realized_pnl_base_units, stop, unreviewed_stop, status, review_state, safety_state, opened_at, closed_at, asset_id')
    .eq('account_id', accountId)
    .order('opened_at', { ascending: false })
    .limit(opts.limit);
  if (!opts.includeClosed) query = query.neq('status', 'CLOSED');
  const { data } = await query;
  const rows = (data ?? []) as unknown as (Omit<PositionView, 'symbol' | 'decimals' | 'strategies'> & { asset_id: string })[];
  if (rows.length === 0) return [];
  const assetIds = [...new Set(rows.map((r) => r.asset_id))];
  const [assets, lots] = await Promise.all([
    supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', assetIds),
    supabase.schema('trading').from('position_lots').select('position_id, strategy_version_id').in('position_id', rows.map((r) => r.id)),
  ]);
  const assetById = new Map(((assets.data ?? []) as { id: string; symbol: string; decimals: number }[]).map((a) => [a.id, a]));
  const strategiesByPosition = new Map<string, Set<string>>();
  for (const l of (lots.data ?? []) as { position_id: string; strategy_version_id: string }[]) {
    if (!strategiesByPosition.has(l.position_id)) strategiesByPosition.set(l.position_id, new Set());
    strategiesByPosition.get(l.position_id)!.add(l.strategy_version_id);
  }
  return rows.map((r) => ({ ...r, symbol: assetById.get(r.asset_id)?.symbol ?? '?', decimals: assetById.get(r.asset_id)?.decimals ?? 0, strategies: [...(strategiesByPosition.get(r.id) ?? [])] }));
}

export async function loadOpenAlerts(limit: number): Promise<AlertView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('ops').from('notifications').select('id, severity, alert_class, summary, raised_at, acknowledged_at, automated_response').is('resolved_at', null).order('raised_at', { ascending: false }).limit(limit);
  return (data ?? []) as unknown as AlertView[];
}

export interface CycleCounts {
  total: number;
  cleared: number;
  rejected: number;
  byStrategy: Record<string, { cleared: number; rejected: number }>;
}

/** Action cycles decided in the last 24 hours, by strategy: the ledger the exit gate asks for. */
export async function loadRecentCycleCounts(): Promise<CycleCounts> {
  const supabase = await createSupabaseServerClient();
  const empty: CycleCounts = { total: 0, cleared: 0, rejected: 0, byStrategy: {} };
  if (!supabase) return empty;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data } = await supabase.schema('agents').from('action_cycles').select('strategy_version_id, state').gte('started_at', since).limit(2000);
  const counts: CycleCounts = { ...empty, byStrategy: {} };
  for (const c of (data ?? []) as { strategy_version_id: string; state: string }[]) {
    counts.total++;
    const s = (counts.byStrategy[c.strategy_version_id] ??= { cleared: 0, rejected: 0 });
    if (c.state === 'CLEARED') {
      counts.cleared++;
      s.cleared++;
    } else if (c.state === 'REJECTED') {
      counts.rejected++;
      s.rejected++;
    }
  }
  return counts;
}

export interface HealthView {
  providers: { provider: string; state: string; effect_on_entries: string | null; freshness_age_ms: number | null; latency_ms: number | null; last_error: string | null; updated_at: string }[];
  leases: { role: string; holder: string; heartbeat_at: string; expires_at: string }[];
  reconciliations: { account_id: string; status: string; evaluated_at: string; reasons: string[] | null }[];
}

export async function loadHealth(): Promise<HealthView | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const [providers, leases, recon] = await Promise.all([
    supabase.schema('ops').from('provider_health').select('provider, state, effect_on_entries, freshness_age_ms, latency_ms, last_error, updated_at').order('provider'),
    supabase.schema('ops').from('worker_leases').select('role, holder, heartbeat_at, expires_at').order('role'),
    supabase.schema('trading').from('custody_reconciliations').select('account_id, status, evaluated_at, reasons').order('evaluated_at', { ascending: false }).limit(20),
  ]);
  return {
    providers: (providers.data ?? []) as HealthView['providers'],
    leases: (leases.data ?? []) as HealthView['leases'],
    reconciliations: (recon.data ?? []) as HealthView['reconciliations'],
  };
}

export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return 'never';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
};

export const usd = (n: number | null): string => (n === null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
export const tokens = (baseUnits: string, decimals: number): string => {
  const n = Number(baseUnits) / 10 ** decimals;
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : baseUnits;
};
