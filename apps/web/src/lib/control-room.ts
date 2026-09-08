import { DEFAULT_RISK_POLICY, DEFAULT_SPEND_LIMITS } from '@sol-agent-trader/contracts';
import { loadCycles, type CycleView } from './cycles';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Control Room read models (§20.2): Agent Now, Opportunity Queue, Upcoming, sleeve utilisation,
 * spend today, recent actions and the session widget's extra fields. Every value is an RLS-scoped
 * projection; anything the ledger has not recorded is null and the page says so (§20.21).
 */

export interface SessionExtras {
  scheduled_start_at: string | null;
  intended_end_at: string | null;
  market_sessions: string[];
  regime: string | null;
  event_window: { catalystEventId: string; sourceTimeT0: string; deadline: string; extensionsUsed: number } | null;
  exposure_at_last_transition: { managedCount: number; offlineProtectedCount: number; unmanagedCount: number; unmanagedUsd: number | null } | null;
  in_flight_execution_ids: string[];
  offline_resume_deadline: string | null;
  resume_watchdog: { expectedCheckAt: string | null; lastCheckAt: string | null; status: string } | null;
}

export async function loadSessionExtras(sessionId: string): Promise<SessionExtras | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.schema('ops').from('runtime_sessions').select('scheduled_start_at, intended_end_at, market_sessions, regime, event_window, exposure_at_last_transition, in_flight_execution_ids, offline_resume_deadline, resume_watchdog').eq('id', sessionId).maybeSingle();
  if (!data) return null;
  const row = data as unknown as SessionExtras;
  return { ...row, market_sessions: row.market_sessions ?? [], in_flight_execution_ids: row.in_flight_execution_ids ?? [] };
}

export async function loadAgentNow(): Promise<CycleView[]> {
  return loadCycles({ status: 'active', limit: 8 });
}

export async function loadRecentActions(): Promise<CycleView[]> {
  const rows = await loadCycles({ limit: 40 });
  return rows.filter((c) => c.terminal_at !== null).slice(0, 10);
}

export interface OpportunityView {
  id: string;
  symbol: string;
  trigger_family: string;
  scanner_score: number;
  status: string;
  discovered_at: string;
  expires_at: string;
  strategy_version_ids: string[];
  deterministic_rejection_reason: string | null;
}

export async function loadOpportunityQueue(nowIso: string): Promise<OpportunityView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase
    .schema('signals')
    .from('candidates')
    .select('id, asset_id, trigger_family, scanner_score, status, discovered_at, expires_at, strategy_version_ids, deterministic_rejection_reason')
    .in('status', ['DETECTED', 'ENRICHING', 'AGENT_REVIEW', 'QUALIFIED'] as never[])
    .gte('expires_at', nowIso)
    .order('scanner_score', { ascending: false })
    .limit(12);
  const rows = (data as { id: string; asset_id: string; trigger_family: string; scanner_score: number; status: string; discovered_at: string; expires_at: string; strategy_version_ids: string[]; deterministic_rejection_reason: string | null }[] | null) ?? [];
  const ids = [...new Set(rows.map((r) => r.asset_id))];
  const assets = ids.length ? await supabase.schema('core').from('assets').select('id, symbol').in('id', ids) : { data: [] };
  const symbol = new Map(((assets.data as { id: string; symbol: string }[] | null) ?? []).map((a) => [a.id, a.symbol]));
  return rows.map((r) => ({ ...r, symbol: symbol.get(r.asset_id) ?? 'unknown', strategy_version_ids: r.strategy_version_ids ?? [] }));
}

export interface UpcomingItem {
  at: string;
  kind: 'REASSESSMENT' | 'CANDIDATE_EXPIRY' | 'AUTOMATION_ELIGIBLE' | 'READINESS_EXPIRY' | 'SESSION_END' | 'EVENT_WINDOW_DEADLINE' | 'OFFLINE_RESUME_DEADLINE';
  label: string;
  href: string | null;
}

export async function loadUpcoming(accountId: string | null, extras: SessionExtras | null, nowIso: string): Promise<UpcomingItem[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const [positions, candidates, automations, readiness] = await Promise.all([
    accountId ? supabase.schema('trading').from('positions').select('id, asset_id, next_reassessment_at').eq('account_id', accountId).eq('status', 'OPEN' as never).not('next_reassessment_at', 'is', null).order('next_reassessment_at', { ascending: true }).limit(10) : Promise.resolve({ data: [] }),
    supabase.schema('signals').from('candidates').select('id, asset_id, expires_at').in('status', ['DETECTED', 'ENRICHING', 'AGENT_REVIEW', 'QUALIFIED'] as never[]).gte('expires_at', nowIso).order('expires_at', { ascending: true }).limit(10),
    supabase.schema('agents').from('automation_definitions').select('name, version_id, next_eligible_at').eq('enabled', true).not('next_eligible_at', 'is', null).gte('next_eligible_at', nowIso).order('next_eligible_at', { ascending: true }).limit(10),
    supabase.schema('ops').from('readiness_rows').select('row_id, expires_at').not('expires_at', 'is', null).gte('expires_at', nowIso).order('expires_at', { ascending: true }).limit(5),
  ]);
  const assetIds = [...new Set([...((positions.data as { asset_id: string }[] | null) ?? []).map((p) => p.asset_id), ...((candidates.data as { asset_id: string }[] | null) ?? []).map((c) => c.asset_id)])];
  const assets = assetIds.length ? await supabase.schema('core').from('assets').select('id, symbol').in('id', assetIds) : { data: [] };
  const symbol = new Map(((assets.data as { id: string; symbol: string }[] | null) ?? []).map((a) => [a.id, a.symbol]));
  const items: UpcomingItem[] = [];
  for (const p of (positions.data as { id: string; asset_id: string; next_reassessment_at: string }[] | null) ?? []) items.push({ at: p.next_reassessment_at, kind: 'REASSESSMENT', label: `${symbol.get(p.asset_id) ?? 'unknown'} reassessment`, href: '/positions' });
  for (const c of (candidates.data as { id: string; asset_id: string; expires_at: string }[] | null) ?? []) items.push({ at: c.expires_at, kind: 'CANDIDATE_EXPIRY', label: `${symbol.get(c.asset_id) ?? 'unknown'} candidate expires`, href: '/scanner' });
  for (const a of (automations.data as { name: string; version_id: string; next_eligible_at: string }[] | null) ?? []) items.push({ at: a.next_eligible_at, kind: 'AUTOMATION_ELIGIBLE', label: `${a.name}@${a.version_id} cooldown ends`, href: '/autonomy' });
  for (const r of (readiness.data as { row_id: string; expires_at: string }[] | null) ?? []) items.push({ at: r.expires_at, kind: 'READINESS_EXPIRY', label: `readiness ${r.row_id} expires`, href: '/readiness' });
  if (extras?.intended_end_at && extras.intended_end_at >= nowIso) items.push({ at: extras.intended_end_at, kind: 'SESSION_END', label: 'intended session end → WIND_DOWN', href: null });
  if (extras?.event_window) items.push({ at: extras.event_window.deadline, kind: 'EVENT_WINDOW_DEADLINE', label: 'EVENT_WINDOW deterministic expiry', href: null });
  if (extras?.offline_resume_deadline) items.push({ at: extras.offline_resume_deadline, kind: 'OFFLINE_RESUME_DEADLINE', label: 'OFFLINE_PROTECTED resume deadline', href: null });
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 12);
}

export interface SleeveView {
  strategy_version_id: string;
  capital_cap_base_units: string;
  committed_base_units: string;
  risk_budget_base_units: string;
  risk_used_base_units: string;
  utilisation: number | null;
}

export async function loadSleeves(accountId: string): Promise<SleeveView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('trading').from('strategy_sleeves').select('strategy_version_id, capital_cap_base_units, committed_base_units, risk_budget_base_units, risk_used_base_units').eq('account_id', accountId).eq('active', true).order('strategy_version_id');
  return ((data as unknown as Omit<SleeveView, 'utilisation'>[] | null) ?? []).map((s) => {
    const cap = Number(s.capital_cap_base_units);
    return { ...s, utilisation: cap > 0 ? Number(s.committed_base_units) / cap : null };
  });
}

export interface SpendView {
  scope: string;
  scope_id: string | null;
  version_id: string;
  limits: { cyclesPerHour: number | null; modelUsdPerDay: number | null; providerRequestsPerMinute: number | null };
  usage: { cycles: number; model_usd: number; provider_requests: number; state: string; window_start: string; window_end: string } | null;
}

/** Spend today (D43): active budgets with the usage window that contains now; no window means no spend recorded. */
export async function loadSpendToday(nowIso: string): Promise<{ budgets: SpendView[]; defaults: typeof DEFAULT_SPEND_LIMITS }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { budgets: [], defaults: DEFAULT_SPEND_LIMITS };
  const { data: budgets } = await supabase.schema('ops').from('spend_budgets').select('id, version_id, scope, scope_id, limits').eq('active', true).order('scope');
  const rows = (budgets as { id: string; version_id: string; scope: string; scope_id: string | null; limits: SpendView['limits'] }[] | null) ?? [];
  if (rows.length === 0) return { budgets: [], defaults: DEFAULT_SPEND_LIMITS };
  const { data: usage } = await supabase.schema('ops').from('spend_usage').select('budget_id, cycles, model_usd, provider_requests, state, window_start, window_end').in('budget_id', rows.map((r) => r.id)).lte('window_start', nowIso).gte('window_end', nowIso);
  const byBudget = new Map(((usage as { budget_id: string; cycles: number; model_usd: number; provider_requests: number; state: string; window_start: string; window_end: string }[] | null) ?? []).map((u) => [u.budget_id, u]));
  return {
    budgets: rows.map((r) => ({ scope: r.scope, scope_id: r.scope_id, version_id: r.version_id, limits: r.limits, usage: byBudget.get(r.id) ?? null })),
    defaults: DEFAULT_SPEND_LIMITS,
  };
}

export interface DrawdownView {
  dailyFraction: number | null;
  rollingFraction: number | null;
  dailyLimit: number;
  rollingLimit: number;
  breakerTripped: boolean | null;
  breakerSince: string | null;
}

/** Drawdown against policy limits; the breaker state is the latest risk evaluation's flag, or null when none exists. */
export async function loadDrawdown(accountId: string, snapshotDrawdown: { dailyFraction?: number; rollingFraction?: number } | null): Promise<DrawdownView> {
  const supabase = await createSupabaseServerClient();
  const base: DrawdownView = { dailyFraction: snapshotDrawdown?.dailyFraction ?? null, rollingFraction: snapshotDrawdown?.rollingFraction ?? null, dailyLimit: DEFAULT_RISK_POLICY.maxDailyDrawdownFraction, rollingLimit: DEFAULT_RISK_POLICY.maxRollingDrawdownFraction, breakerTripped: null, breakerSince: null };
  if (!supabase) return base;
  const { data } = await supabase.schema('trading').from('risk_evaluations').select('circuit_breaker_tripped, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  void accountId;
  const row = data as { circuit_breaker_tripped: boolean; created_at: string } | null;
  return row ? { ...base, breakerTripped: row.circuit_breaker_tripped, breakerSince: row.circuit_breaker_tripped ? row.created_at : null } : base;
}

export interface HealthSummary {
  providers: { healthy: number; degraded: number; failed: number; total: number };
  staleRoles: string[];
  roles: number;
  reconciliation: { status: string; evaluated_at: string } | null;
  executor: { healthy: boolean | null; checked_at: string | null };
}

export async function loadHealthSummary(nowMs: number): Promise<HealthSummary> {
  const supabase = await createSupabaseServerClient();
  const empty: HealthSummary = { providers: { healthy: 0, degraded: 0, failed: 0, total: 0 }, staleRoles: [], roles: 0, reconciliation: null, executor: { healthy: null, checked_at: null } };
  if (!supabase) return empty;
  const [providers, leases, recon] = await Promise.all([
    supabase.schema('ops').from('provider_health').select('provider, state'),
    supabase.schema('ops').from('worker_leases').select('role, heartbeat_at, expires_at'),
    supabase.schema('trading').from('custody_reconciliations').select('status, evaluated_at').order('evaluated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const p = (providers.data as { provider: string; state: string }[] | null) ?? [];
  const l = (leases.data as { role: string; heartbeat_at: string; expires_at: string }[] | null) ?? [];
  // The executor is probed by the notifications role; its verdict reaches the ledger as a provider-health row when the executor is configured.
  const ex = p.find((x) => /executor|execution/i.test(x.provider)) ?? null;
  return {
    providers: { healthy: p.filter((x) => x.state === 'HEALTHY').length, degraded: p.filter((x) => x.state === 'DEGRADED').length, failed: p.filter((x) => x.state === 'FAILED').length, total: p.length },
    staleRoles: l.filter((x) => Date.parse(x.expires_at) < nowMs).map((x) => x.role),
    roles: l.length,
    reconciliation: (recon.data as { status: string; evaluated_at: string } | null) ?? null,
    executor: ex ? { healthy: ex.state === 'HEALTHY', checked_at: null } : { healthy: null, checked_at: null },
  };
}
