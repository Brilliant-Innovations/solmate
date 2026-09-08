import { DEFAULT_EMERGENCY_ROUTE_POLICY } from '@sol-agent-trader/contracts';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Scanner, Watchlist and Asset Workspace read models (§20.4, §20.5, §20.27). `signals.scanner` is
 * a security-invoker view over the latest eligibility, market snapshot, feature snapshot and
 * emergency-route snapshot per asset plus open candidates, the active cycle, cohort tags, watch
 * state and any open position; the operator's RLS applies underneath. Everything is a read of
 * ledger state; a missing value stays null and the pages say so (§20.21).
 */

export interface ScannerRow {
  asset_id: string;
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  asset_status: string;
  first_observed_at: string;
  research_refresh_requested_at: string | null;
  eligibility_id: string | null;
  eligibility_at: string | null;
  eligible: boolean | null;
  hard_reject: boolean | null;
  rejection_reasons: string[] | null;
  grade: number | null;
  eligibility_liquidity_usd: number | null;
  holder_count: number | null;
  concentration: { top1?: number; top5?: number; top10?: number; top20?: number; analyticsMismatch?: boolean; source?: string } | null;
  mint_authority: string | null;
  freeze_authority: string | null;
  security_flags: string[] | null;
  transfer_restrictions: string[] | null;
  jupiter_route_available: boolean | null;
  settlement_route_confirmed: boolean | null;
  price_impact_probes: { sizeUsd: number; impactBps: number | null; routeFound: boolean; probedAt: string }[] | null;
  insider_metrics: Record<string, unknown> | null;
  eligibility_freshness: Record<string, unknown> | null;
  route_id: string | null;
  route_refreshed_at: string | null;
  route_hops: { program?: string; pool?: string; inputMint?: string; outputMint?: string }[] | null;
  route_dry_run: { at: string; ok: boolean; error: string | null; simulatedOutputAmount: string | null } | null;
  snapshot_at: string | null;
  price_usd: number | null;
  liquidity_usd: number | null;
  returns: { s15?: number | null; m1?: number | null; m5?: number | null; m15?: number | null; h1?: number | null; h4?: number | null } | null;
  relative_volume: number | null;
  realized_volatility: number | null;
  atr: number | null;
  volume_usd: { m5?: number | null; h1?: number | null; h24?: number | null } | null;
  buy_volume_usd: { m5?: number | null; h1?: number | null; h24?: number | null } | null;
  sell_volume_usd: { m5?: number | null; h1?: number | null; h24?: number | null } | null;
  buy_count: { m5?: number | null; h1?: number | null } | null;
  sell_count: { m5?: number | null; h1?: number | null } | null;
  sol_relative_return: number | null;
  universe_relative_strength: number | null;
  route_probes: { sizeUsd: number; impactBps: number | null }[] | null;
  market_cap_usd: number | null;
  features_at: string | null;
  features: Record<string, number | null> | null;
  regime: string | null;
  self_influence_suppressed: boolean | null;
  open_candidates: { id: string; triggerFamily: string; scannerScore: number; status: string; discoveredAt: string; expiresAt: string; strategyVersionIds: string[]; rejection: string | null }[];
  cycle_state: string | null;
  cycle_action: string | null;
  cycle_strategy: string | null;
  cycle_id: string | null;
  cohorts: string[];
  watch_id: string | null;
  watch_reason: string | null;
  position_id: string | null;
  position_status: string | null;
  event_count_24h: number | null;
}

export type ExitableState = 'EXITABLE' | 'STALE' | 'FAILED' | 'NO_ROUTE';

/** §14.6: a route is emergency-exitable when its last dry-run passed inside the policy window. */
export function exitable(r: Pick<ScannerRow, 'route_dry_run' | 'route_id'>, nowMs: number): ExitableState {
  if (!r.route_id) return 'NO_ROUTE';
  const d = r.route_dry_run;
  if (!d) return 'STALE';
  if (nowMs - Date.parse(d.at) > DEFAULT_EMERGENCY_ROUTE_POLICY.maxDryRunAgeMs) return 'STALE';
  return d.ok ? 'EXITABLE' : 'FAILED';
}

export function eligibilityLabel(r: Pick<ScannerRow, 'asset_status' | 'eligible' | 'hard_reject' | 'eligibility_at'>): { text: string; tone: 'ok' | 'degraded' | 'failed' | 'unknown' } {
  if (r.eligibility_at === null) return { text: r.asset_status, tone: 'unknown' };
  if (r.eligible) return { text: 'ELIGIBLE', tone: 'ok' };
  return r.hard_reject ? { text: 'BLOCKED', tone: 'failed' } : { text: 'NOT ELIGIBLE', tone: 'degraded' };
}

/** Why an asset is not tradeable right now, in the operator's words (§20.4 "why not tradeable"). */
export function whyNotTradeable(r: ScannerRow, nowMs: number): string[] {
  const out: string[] = [];
  if (r.eligibility_at === null) out.push('not evaluated yet');
  else if (!r.eligible) out.push(...(r.rejection_reasons ?? []).map((x) => x.toLowerCase().replace(/_/g, ' ')));
  if (r.jupiter_route_available === false) out.push('no Jupiter route');
  if (r.settlement_route_confirmed === false) out.push('settlement route unconfirmed');
  if (r.self_influence_suppressed) out.push('own-fill influence suppressed (D26)');
  const ex = exitable(r, nowMs);
  if (ex === 'NO_ROUTE') out.push('no emergency exit route');
  else if (ex === 'STALE') out.push('emergency route dry-run stale');
  else if (ex === 'FAILED') out.push(`emergency route dry-run failed${r.route_dry_run?.error ? ` (${r.route_dry_run.error.split(':')[0]})` : ''}`);
  if (r.snapshot_at === null) out.push('no market snapshot');
  return out;
}

export interface ScannerFilters {
  eligibility?: '' | 'eligible' | 'blocked' | 'evaluating';
  exitable?: '' | '1';
  strategy?: string;
  tier?: string;
  candidates?: '' | '1';
  cycle?: '' | '1';
  watched?: '' | '1';
  q?: string;
  sort?: 'score' | 'ret15' | 'ret1h' | 'liquidity' | 'relvol' | 'observed';
  limit?: number;
}

export interface ScannerView {
  rows: ScannerRow[];
  strategies: { version_id: string; strategy_id: string; speed_tier: string }[];
  total: number;
}

export async function loadScanner(f: ScannerFilters, nowMs: number): Promise<ScannerView> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { rows: [], strategies: [], total: 0 };
  let q = supabase.schema('signals').from('scanner').select('*').neq('asset_status', 'RETIRED' as never).limit(f.limit ?? 300);
  if (f.eligibility === 'eligible') q = q.eq('eligible', true);
  else if (f.eligibility === 'blocked') q = q.eq('hard_reject', true);
  else if (f.eligibility === 'evaluating') q = q.is('eligibility_at', null);
  if (f.watched === '1') q = q.not('watch_id', 'is', null);
  if (f.cycle === '1') q = q.not('cycle_state', 'is', null);
  const [{ data }, strategies] = await Promise.all([q, supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, speed_tier').order('version_id')]);
  let rows = ((data as unknown as ScannerRow[] | null) ?? []).map(normalise);
  const strats = (strategies.data as { version_id: string; strategy_id: string; speed_tier: string }[] | null) ?? [];
  const tierOf = new Map(strats.map((s) => [s.version_id, s.speed_tier]));
  if (f.exitable === '1') rows = rows.filter((r) => exitable(r, nowMs) === 'EXITABLE');
  if (f.candidates === '1') rows = rows.filter((r) => r.open_candidates.length > 0);
  if (f.strategy) rows = rows.filter((r) => r.open_candidates.some((c) => c.strategyVersionIds.some((s) => s === f.strategy || s.split('@')[0] === f.strategy)));
  if (f.tier) rows = rows.filter((r) => r.open_candidates.some((c) => c.strategyVersionIds.some((s) => tierOf.get(s) === f.tier)));
  if (f.q) {
    const t = f.q.trim().toLowerCase();
    rows = rows.filter((r) => r.symbol.toLowerCase().includes(t) || r.name.toLowerCase().includes(t) || r.mint === f.q!.trim());
  }
  const score = (r: ScannerRow) => (r.open_candidates[0]?.scannerScore ?? -1);
  const sorters: Record<NonNullable<ScannerFilters['sort']>, (a: ScannerRow, b: ScannerRow) => number> = {
    score: (a, b) => score(b) - score(a) || (b.grade ?? -1) - (a.grade ?? -1),
    ret15: (a, b) => (b.returns?.m15 ?? -Infinity) - (a.returns?.m15 ?? -Infinity),
    ret1h: (a, b) => (b.returns?.h1 ?? -Infinity) - (a.returns?.h1 ?? -Infinity),
    liquidity: (a, b) => (b.liquidity_usd ?? b.eligibility_liquidity_usd ?? -1) - (a.liquidity_usd ?? a.eligibility_liquidity_usd ?? -1),
    relvol: (a, b) => (b.relative_volume ?? -1) - (a.relative_volume ?? -1),
    observed: (a, b) => b.first_observed_at.localeCompare(a.first_observed_at),
  };
  rows.sort(sorters[f.sort ?? 'score']);
  return { rows, strategies: strats, total: rows.length };
}

export async function loadAsset(assetId: string): Promise<ScannerRow | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.schema('signals').from('scanner').select('*').eq('asset_id', assetId).maybeSingle();
  return data ? normalise(data as unknown as ScannerRow) : null;
}

export interface WatchView {
  id: string;
  asset_id: string;
  reason: string;
  note: string | null;
  alert_rules: Record<string, unknown>;
  added_by: string;
  added_at: string;
  row: ScannerRow | null;
  candidatesEver: number;
}

export async function loadWatchlist(): Promise<WatchView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('intelligence').from('watchlist').select('id, asset_id, reason, note, alert_rules, added_by, added_at').is('removed_at', null).order('added_at', { ascending: false }).limit(200);
  const watches = (data as unknown as Omit<WatchView, 'row' | 'candidatesEver'>[] | null) ?? [];
  if (watches.length === 0) return [];
  const ids = watches.map((w) => w.asset_id);
  const [rows, cands] = await Promise.all([
    supabase.schema('signals').from('scanner').select('*').in('asset_id', ids),
    supabase.schema('signals').from('candidates').select('asset_id').in('asset_id', ids).limit(2000),
  ]);
  const byAsset = new Map(((rows.data as unknown as ScannerRow[] | null) ?? []).map((r) => [r.asset_id, normalise(r)]));
  const counts = new Map<string, number>();
  for (const c of (cands.data as { asset_id: string }[] | null) ?? []) counts.set(c.asset_id, (counts.get(c.asset_id) ?? 0) + 1);
  return watches.map((w) => ({ ...w, alert_rules: w.alert_rules ?? {}, row: byAsset.get(w.asset_id) ?? null, candidatesEver: counts.get(w.asset_id) ?? 0 }));
}

// Asset Workspace -----------------------------------------------------------------------------

export interface CandleView {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AssetWorkspaceView {
  row: ScannerRow;
  candles: { resolution: string; rows: CandleView[] }[];
  candidates: { id: string; trigger_family: string; scanner_score: number; status: string; discovered_at: string; expires_at: string; deterministic_rejection_reason: string | null; strategy_version_ids: string[] }[];
  events: { id: string; kind: string; title: string | null; summary: string | null; source_provider: string; source_quality: string; source_published_at: string | null; first_seen_at: string; novelty_score: number | null; classification: string | null; cluster_id: string | null; corroborates_event_id: string | null; sentiment: Record<string, unknown> | null }[];
  positions: { id: string; status: string; quantity: string; average_entry_price: number | null; realized_pnl_base_units: string; unrealized_pnl_base_units: string | null; review_state: string; safety_state: string; opened_at: string; closed_at: string | null }[];
  fills: { id: string; tx_signature: string; commitment: string; input_mint: string; output_mint: string; input_amount: string; output_amount: string; execution_shortfall_bps: number | null; execution_path: string; filled_at: string }[];
  intents: { id: string; action: string; side: string; created_at: string }[];
  ownedAddresses: number;
  trackedWallets: { address: string; labels: { label?: string; kind?: string }[]; is_owned: boolean; win_rate: number | null; trade_count: number | null }[];
  /** Realized outcome after each horizon for every candidate, from 5m candles (research labels, §20.5 History). */
  outcomes: Map<string, { m15: number | null; h1: number | null; h4: number | null; h24: number | null }>;
}

export async function loadAssetWorkspace(assetId: string): Promise<AssetWorkspaceView | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const row = await loadAsset(assetId);
  if (!row) return null;
  const since1m = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const since5m = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const since1h = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [c1m, c5m, c1h, candidates, eventLinks, positions, intents, wallets, owned] = await Promise.all([
    supabase.schema('market').from('candles').select('bucket_time, open, high, low, close, volume_usd').eq('asset_id', assetId).eq('resolution', '1m' as never).gte('bucket_time', since1m).order('bucket_time', { ascending: true }).limit(400),
    supabase.schema('market').from('candles').select('bucket_time, open, high, low, close, volume_usd').eq('asset_id', assetId).eq('resolution', '5m' as never).gte('bucket_time', since5m).order('bucket_time', { ascending: true }).limit(1000),
    supabase.schema('market').from('candles').select('bucket_time, open, high, low, close, volume_usd').eq('asset_id', assetId).eq('resolution', '1h' as never).gte('bucket_time', since1h).order('bucket_time', { ascending: true }).limit(800),
    supabase.schema('signals').from('candidates').select('id, trigger_family, scanner_score, status, discovered_at, expires_at, deterministic_rejection_reason, strategy_version_ids').eq('asset_id', assetId).order('discovered_at', { ascending: false }).limit(50),
    supabase.schema('intelligence').from('event_assets').select('event_id').eq('asset_id', assetId).limit(200),
    supabase.schema('trading').from('positions').select('id, status, quantity, average_entry_price, realized_pnl_base_units, unrealized_pnl_base_units, review_state, safety_state, opened_at, closed_at').eq('asset_id', assetId).order('opened_at', { ascending: false }).limit(20),
    supabase.schema('trading').from('intents').select('id, action, side, created_at').eq('asset_id', assetId).order('created_at', { ascending: false }).limit(50),
    supabase.schema('intelligence').from('wallets').select('address, labels, is_owned, win_rate, trade_count').order('updated_at', { ascending: false }).limit(20),
    supabase.schema('intelligence').from('owned_addresses').select('address', { count: 'exact', head: true }).is('retired_at', null),
  ]);
  const toCandles = (d: unknown) => ((d as { bucket_time: string; open: number; high: number; low: number; close: number; volume_usd: number }[] | null) ?? []).map((c) => ({ time: Math.floor(Date.parse(c.bucket_time) / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume_usd }));
  const candles = [
    { resolution: '1m', rows: toCandles(c1m.data) },
    { resolution: '5m', rows: toCandles(c5m.data) },
    { resolution: '1h', rows: toCandles(c1h.data) },
  ];
  const eventIds = ((eventLinks.data as { event_id: string }[] | null) ?? []).map((e) => e.event_id);
  const events = eventIds.length
    ? await supabase.schema('intelligence').from('events').select('id, kind, title, summary, source_provider, source_quality, source_published_at, first_seen_at, novelty_score, classification, cluster_id, corroborates_event_id, sentiment').in('id', eventIds).order('first_seen_at', { ascending: false }).limit(100)
    : { data: [] };
  const intentRows = (intents.data as unknown as AssetWorkspaceView['intents'] | null) ?? [];
  let fills: AssetWorkspaceView['fills'] = [];
  if (intentRows.length > 0) {
    const attempts = await supabase.schema('trading').from('order_attempts').select('id').in('intent_id', intentRows.map((i) => i.id)).limit(200);
    const attemptIds = ((attempts.data as { id: string }[] | null) ?? []).map((a) => a.id);
    if (attemptIds.length > 0) {
      const f = await supabase.schema('trading').from('fills').select('id, tx_signature, commitment, input_mint, output_mint, input_amount, output_amount, execution_shortfall_bps, execution_path, filled_at').in('order_attempt_id', attemptIds).order('filled_at', { ascending: true }).limit(200);
      fills = (f.data as unknown as AssetWorkspaceView['fills'] | null) ?? [];
    }
  }
  const candRows = (candidates.data as unknown as AssetWorkspaceView['candidates'] | null) ?? [];
  const five = candles[1]!.rows;
  const outcomes = new Map<string, { m15: number | null; h1: number | null; h4: number | null; h24: number | null }>();
  for (const c of candRows) outcomes.set(c.id, outcomeLabels(five, Date.parse(c.discovered_at) / 1000));
  return {
    row,
    candles,
    candidates: candRows.map((c) => ({ ...c, strategy_version_ids: c.strategy_version_ids ?? [] })),
    events: (events.data as unknown as AssetWorkspaceView['events'] | null) ?? [],
    positions: (positions.data as unknown as AssetWorkspaceView['positions'] | null) ?? [],
    fills,
    intents: intentRows,
    ownedAddresses: owned.count ?? 0,
    trackedWallets: ((wallets.data as unknown as AssetWorkspaceView['trackedWallets'] | null) ?? []).map((w) => ({ ...w, labels: w.labels ?? [] })),
    outcomes,
  };
}

/** Return from the first close at/after t0 to the close nearest each horizon; null when the candles do not reach that far. */
export function outcomeLabels(candles: CandleView[], t0: number): { m15: number | null; h1: number | null; h4: number | null; h24: number | null } {
  const base = candles.find((c) => c.time >= t0);
  const at = (secs: number): number | null => {
    if (!base) return null;
    const target = t0 + secs;
    const last = candles.at(-1);
    if (!last || last.time < target - 300) return null;
    let best: CandleView | null = null;
    for (const c of candles) {
      if (c.time > target) break;
      best = c;
    }
    return best && base.close > 0 ? best.close / base.close - 1 : null;
  };
  return { m15: at(15 * 60), h1: at(3600), h4: at(4 * 3600), h24: at(24 * 3600) };
}

function normalise(r: ScannerRow): ScannerRow {
  return { ...r, open_candidates: Array.isArray(r.open_candidates) ? r.open_candidates : [], cohorts: r.cohorts ?? [], rejection_reasons: r.rejection_reasons ?? [], security_flags: r.security_flags ?? [], transfer_restrictions: r.transfer_restrictions ?? [] };
}

export const pct = (f: number | null | undefined, digits = 1): string => (f === null || f === undefined || !Number.isFinite(f) ? '—' : `${f >= 0 ? '+' : ''}${(f * 100).toFixed(digits)}%`);
export const usdc = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n < 1 ? 4 : 2)}`);
export const price = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(4)}`);
