import { DEFAULT_EMERGENCY_ROUTE_POLICY } from '@sol-agent-trader/contracts';
import { loadHealth, type HealthView } from './paper';
import { createSupabaseServerClient } from './supabase/server';

/**
 * System Health read model (§20.19): every critical dependency shown independently with state,
 * last success, latency, freshness, rate-limit state, effect on entries/exits and last error. The
 * catalogue below is fixed by the blueprint; each row names the ledger fact it is derived from. A
 * dependency with no observation, not configured for this profile, or not applicable to v1 says
 * so explicitly and is never rendered as healthy (§20.21).
 */

export type DependencyState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'NO_OBSERVATION' | 'NOT_CONFIGURED' | 'NOT_APPLICABLE';

export interface DependencyView {
  key: string;
  label: string;
  state: DependencyState;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  freshnessAgeMs: number | null;
  rateLimitState: string | null;
  effectOnEntries: string;
  effectOnExits: string;
  lastError: string | null;
  /** Where the verdict comes from and what it means, in one line. */
  source: string;
}

export interface SystemHealthView {
  dependencies: DependencyView[];
  raw: HealthView | null;
  chain: { observed_at: string; state: string; head_slot: number | null; confirmed_finalized_lag_slots: number | null; view_divergence_slots: number | null; effect_on_entries: string; reasons: string[] } | null;
  deliveries: { channel: string; attempts: number; lastConfirmedAt: string | null; lastAttemptAt: string | null; lastError: string | null }[];
  routes: { total: number; ranWithinMaxAge: number; okWithinMaxAge: number; latestAt: string | null; classes: Record<string, number> };
  readiness: Map<string, ReadinessRowLite>;
}

export interface ReadinessRowLite {
  row_id: string;
  verdict: string;
  kind: string;
  evaluated_at: string;
  expires_at: string | null;
  detail: Record<string, unknown>;
}

type ProviderRow = HealthView['providers'][number] & { rate_limit_state?: string | null; effect_on_exits?: string | null; last_success_at?: string | null };

export async function loadSystemHealth(nowMs: number): Promise<SystemHealthView> {
  const supabase = await createSupabaseServerClient();
  const nowIso = new Date(nowMs).toISOString();
  const empty: SystemHealthView = { dependencies: [], raw: null, chain: null, deliveries: [], routes: { total: 0, ranWithinMaxAge: 0, okWithinMaxAge: 0, latestAt: null, classes: {} }, readiness: new Map() };
  if (!supabase) return empty;
  const [raw, providersFull, chain, deliveries, routes, readiness, runs, spend] = await Promise.all([
    loadHealth(),
    supabase.schema('ops').from('provider_health').select('provider, state, last_success_at, latency_ms, freshness_age_ms, rate_limit_state, effect_on_entries, effect_on_exits, last_error, updated_at').order('provider'),
    supabase.schema('ops').from('chain_health').select('observed_at, state, head_slot, confirmed_finalized_lag_slots, view_divergence_slots, effect_on_entries, reasons').order('observed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('ops').from('notification_deliveries').select('channel, attempted_at, confirmed_at, error').order('attempted_at', { ascending: false }).limit(200),
    supabase.schema('core').from('emergency_exit_route_snapshots').select('last_dry_run, created_at').order('created_at', { ascending: false }).limit(400),
    supabase.schema('ops').from('readiness_rows').select('row_id, verdict, kind, evaluated_at, expires_at, detail').order('evaluated_at', { ascending: false }).limit(300),
    supabase.schema('agents').from('runs').select('role, provider, model, success, latency_ms, created_at').order('created_at', { ascending: false }).limit(50),
    supabase.schema('ops').from('spend_usage').select('state, window_start, window_end, updated_at').lte('window_start', nowIso).gte('window_end', nowIso),
  ]);

  const providers = ((providersFull.data as unknown as ProviderRow[] | null) ?? []);
  const chainRow = (chain.data as unknown as SystemHealthView['chain']) ?? null;

  // Latest readiness row per row_id.
  const readinessMap = new Map<string, ReadinessRowLite>();
  for (const r of (readiness.data as unknown as ReadinessRowLite[] | null) ?? []) if (!readinessMap.has(r.row_id)) readinessMap.set(r.row_id, r);

  // Notification channels.
  const byChannel = new Map<string, SystemHealthView['deliveries'][number]>();
  for (const d of (deliveries.data as { channel: string; attempted_at: string; confirmed_at: string | null; error: string | null }[] | null) ?? []) {
    const c = byChannel.get(d.channel) ?? { channel: d.channel, attempts: 0, lastConfirmedAt: null, lastAttemptAt: null, lastError: null };
    c.attempts++;
    if (!c.lastAttemptAt) c.lastAttemptAt = d.attempted_at;
    if (d.confirmed_at && (!c.lastConfirmedAt || d.confirmed_at > c.lastConfirmedAt)) c.lastConfirmedAt = d.confirmed_at;
    if (d.error && !c.lastError) c.lastError = d.error;
    byChannel.set(d.channel, c);
  }

  // Direct-pool dry-run health.
  const maxAge = DEFAULT_EMERGENCY_ROUTE_POLICY.maxDryRunAgeMs;
  const routeRows = (routes.data as { last_dry_run: { at: string; ok: boolean; error: string | null } | null; created_at: string }[] | null) ?? [];
  const classes: Record<string, number> = {};
  let ran = 0;
  let ok = 0;
  let latestAt: string | null = null;
  for (const r of routeRows) {
    const d = r.last_dry_run;
    if (!d) continue;
    if (!latestAt || d.at > latestAt) latestAt = d.at;
    if (nowMs - Date.parse(d.at) > maxAge) continue;
    ran++;
    if (d.ok) ok++;
    const cls = d.ok ? 'OK' : (d.error ?? 'UNKNOWN').split(':')[0]!;
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  const routeSummary = { total: routeRows.length, ranWithinMaxAge: ran, okWithinMaxAge: ok, latestAt, classes };

  // Model providers by role.
  const runRows = (runs.data as { role: string; provider: string; model: string; success: boolean; latency_ms: number; created_at: string }[] | null) ?? [];
  const lastRun = (role: string) => runRows.find((r) => r.role === role) ?? null;
  const lastSuccessRun = (role: string) => runRows.find((r) => r.role === role && r.success) ?? null;

  const spendRows = (spend.data as { state: string; window_end: string; updated_at: string }[] | null) ?? [];

  const deps: DependencyView[] = [];
  const push = (d: DependencyView) => deps.push(d);
  const aggregate = (key: string, label: string, prefix: string, source: string) => {
    const rows = providers.filter((p) => p.provider === prefix || p.provider.startsWith(`${prefix}:`));
    if (rows.length === 0) {
      push({ key, label, state: 'NO_OBSERVATION', lastSuccessAt: null, latencyMs: null, freshnessAgeMs: null, rateLimitState: null, effectOnEntries: '—', effectOnExits: '—', lastError: null, source: `${source}; no ops.provider_health row yet` });
      return;
    }
    const observed = rows.filter((r) => r.last_success_at !== null);
    const worst = rows.some((r) => r.state === 'FAILED' && r.last_success_at !== null) ? 'FAILED' : rows.some((r) => r.state === 'DEGRADED') ? 'DEGRADED' : observed.length > 0 ? 'HEALTHY' : 'NO_OBSERVATION';
    const never = rows.filter((r) => r.last_success_at === null).map((r) => r.provider.slice(prefix.length + 1) || r.provider);
    const lastSuccess = observed.map((r) => r.last_success_at!).sort().at(-1) ?? null;
    const latencies = observed.map((r) => r.latency_ms).filter((x): x is number => x !== null);
    const ages = observed.map((r) => r.freshness_age_ms).filter((x): x is number => x !== null);
    push({
      key,
      label,
      state: worst,
      lastSuccessAt: lastSuccess,
      latencyMs: latencies.length ? Math.max(...latencies) : null,
      freshnessAgeMs: ages.length ? Math.max(...ages) : null,
      rateLimitState: rows.map((r) => r.rate_limit_state).find((x) => x && x !== 'OK') ?? rows[0]?.rate_limit_state ?? null,
      effectOnEntries: rows.some((r) => r.effect_on_entries === 'BLOCK') ? 'BLOCK' : rows.some((r) => r.effect_on_entries === 'DEGRADE') ? 'DEGRADE' : 'NONE',
      effectOnExits: rows.some((r) => r.effect_on_exits && r.effect_on_exits !== 'NONE') ? (rows.find((r) => r.effect_on_exits && r.effect_on_exits !== 'NONE')!.effect_on_exits as string) : 'NONE',
      lastError: rows.map((r) => r.last_error).find((e) => !!e) ?? null,
      source: `${source}; ${rows.length} data class(es)${never.length ? `, never observed: ${never.join(', ')}` : ''}`,
    });
  };
  const fromReadiness = (key: string, label: string, rowIds: string[], entries: string, exits: string, source: string) => {
    const rows = rowIds.map((id) => readinessMap.get(id)).filter((r): r is ReadinessRowLite => !!r);
    if (rows.length === 0) {
      push({ key, label, state: 'NO_OBSERVATION', lastSuccessAt: null, latencyMs: null, freshnessAgeMs: null, rateLimitState: null, effectOnEntries: entries, effectOnExits: exits, lastError: null, source: `${source}; readiness row(s) ${rowIds.join(', ')} not run` });
      return;
    }
    const stale = rows.some((r) => r.expires_at && Date.parse(r.expires_at) < nowMs);
    const state: DependencyState = rows.some((r) => r.verdict === 'FAIL') ? 'FAILED' : rows.every((r) => r.verdict === 'NOT_APPLICABLE') ? 'NOT_APPLICABLE' : rows.some((r) => r.verdict === 'UNKNOWN') ? 'NO_OBSERVATION' : stale ? 'DEGRADED' : 'HEALTHY';
    const latest = rows.map((r) => r.evaluated_at).sort().at(-1) ?? null;
    push({
      key,
      label,
      state,
      lastSuccessAt: rows.filter((r) => r.verdict === 'PASS').map((r) => r.evaluated_at).sort().at(-1) ?? null,
      latencyMs: null,
      freshnessAgeMs: latest ? nowMs - Date.parse(latest) : null,
      rateLimitState: null,
      effectOnEntries: entries,
      effectOnExits: exits,
      lastError: rows.filter((r) => r.verdict === 'FAIL').map((r) => `${r.row_id}: ${typeof r.detail?.['reason'] === 'string' ? (r.detail['reason'] as string) : 'FAIL'}`).join('; ') || (stale ? 'STALE: past expiry' : null),
      source: `${source}; readiness ${rows.map((r) => `${r.row_id}=${r.verdict}${r.expires_at && Date.parse(r.expires_at) < nowMs ? ' (stale)' : ''}`).join(', ')}`,
    });
  };

  aggregate('birdeye', 'Birdeye', 'BIRDEYE', 'market-ingest feed health per data class');
  {
    const rpc = providers.find((p) => p.provider === 'SOLANA_CHAIN') ?? null;
    const state: DependencyState = !rpc ? 'NO_OBSERVATION' : rpc.state === 'HEALTHY' ? 'HEALTHY' : rpc.state === 'DEGRADED' ? 'DEGRADED' : 'FAILED';
    push({ key: 'rpc', label: 'Helius / primary Solana RPC', state, lastSuccessAt: rpc?.last_success_at ?? null, latencyMs: rpc?.latency_ms ?? null, freshnessAgeMs: rpc?.freshness_age_ms ?? null, rateLimitState: rpc?.rate_limit_state ?? null, effectOnEntries: chainRow?.effect_on_entries ?? rpc?.effect_on_entries ?? '—', effectOnExits: rpc?.effect_on_exits ?? 'NONE', lastError: rpc?.last_error ?? (chainRow?.reasons?.length ? chainRow.reasons.join(', ') : null), source: chainRow ? `chain-health snapshot ${chainRow.state}${chainRow.head_slot !== null ? ` head ${chainRow.head_slot}` : ''}${chainRow.confirmed_finalized_lag_slots !== null ? `, confirmed→finalized lag ${chainRow.confirmed_finalized_lag_slots} slots` : ''}${chainRow.view_divergence_slots !== null ? `, view divergence ${chainRow.view_divergence_slots}` : ''}` : 'chain-health role has not written a snapshot' });
  }
  {
    const rpcErrors = classes['RPC_ERROR'] ?? 0;
    const state: DependencyState = ran === 0 ? 'NO_OBSERVATION' : rpcErrors === ran ? 'FAILED' : rpcErrors > 0 ? 'DEGRADED' : 'HEALTHY';
    push({ key: 'sim-rpc', label: 'Independent simulation RPC', state, lastSuccessAt: latestAt, latencyMs: null, freshnessAgeMs: latestAt ? nowMs - Date.parse(latestAt) : null, rateLimitState: null, effectOnEntries: 'NONE (paper); LIVE_AUTO entries need a fresh dry-run', effectOnExits: 'NONE', lastError: rpcErrors ? `${rpcErrors} dry-run(s) ended in RPC_ERROR` : null, source: `observed through emergency dry-runs: ${ran} within ${maxAge / 3_600_000}h, ${rpcErrors} RPC errors` });
  }
  aggregate('jupiter', 'Jupiter swap (quote / price)', 'JUPITER', 'quote and price feed health');
  fromReadiness('jupiter-trigger', 'Jupiter Trigger', ['TRIGGER_LIFECYCLE'], 'NONE (paper)', 'provider protection unavailable → deterministic protection only', 'probe from the isolated environment');
  {
    const dp = providers.find((p) => p.provider === 'DIRECT_POOL' || p.provider.startsWith('DIRECT_POOL:')) ?? null;
    const state: DependencyState = dp ? (dp.state === 'HEALTHY' ? 'HEALTHY' : dp.state === 'DEGRADED' ? 'DEGRADED' : 'FAILED') : 'NOT_CONFIGURED';
    push({ key: 'emergency-adapter', label: 'Emergency-exit adapter (executor direct-pool)', state, lastSuccessAt: dp?.last_success_at ?? null, latencyMs: dp?.latency_ms ?? null, freshnessAgeMs: dp?.freshness_age_ms ?? null, rateLimitState: null, effectOnEntries: 'LIVE_AUTO arming requires it', effectOnExits: dp ? (dp.effect_on_exits ?? 'NONE') : 'fallback unavailable in this profile', lastError: dp?.last_error ?? null, source: dp ? 'execution-service emergency adapter health' : 'no execution-service configured in this profile (P1A paper)' });
  }
  {
    const rows = providers.filter((p) => p.provider.startsWith('CRYPTOPANIC') || p.provider.startsWith('LUNARCRUSH'));
    if (rows.length === 0) push({ key: 'news', label: 'News / social providers', state: 'NOT_CONFIGURED', lastSuccessAt: null, latencyMs: null, freshnessAgeMs: null, rateLimitState: null, effectOnEntries: 'catalyst strategies unavailable', effectOnExits: 'NONE', lastError: null, source: 'CRYPTOPANIC / LUNARCRUSH keys not set (intel-ingest disabled)' });
    else aggregate('news', 'News / social providers', rows[0]!.provider.split(':')[0]!, 'intel-ingest feed health');
  }
  for (const [key, label, role] of [['proposer', 'Model proposer provider', 'TRADING_PROPOSER'], ['adversary', 'Model adversary provider', 'ACTION_ADVERSARY']] as const) {
    const last = lastRun(role);
    const lastOk = lastSuccessRun(role);
    const state: DependencyState = !last ? 'NOT_CONFIGURED' : last.success ? 'HEALTHY' : lastOk && nowMs - Date.parse(lastOk.created_at) < 3_600_000 ? 'DEGRADED' : 'FAILED';
    push({ key, label, state, lastSuccessAt: lastOk?.created_at ?? null, latencyMs: last?.latency_ms ?? null, freshnessAgeMs: last ? nowMs - Date.parse(last.created_at) : null, rateLimitState: null, effectOnEntries: 'discretionary cycles unavailable → deterministic strategies only', effectOnExits: 'NONE (mandatory exits never wait for a model)', lastError: last && !last.success ? 'last run failed schema validation or errored' : null, source: last ? `latest agents.runs row ${last.provider}/${last.model}` : 'no model run recorded (agents role disabled without provider keys)' });
  }
  push({ key: 'postgres', label: 'Postgres (Supabase)', state: providersFull.error || readiness.error ? 'FAILED' : 'HEALTHY', lastSuccessAt: nowIso, latencyMs: null, freshnessAgeMs: 0, rateLimitState: null, effectOnEntries: 'DB down → no new entries', effectOnExits: 'DB down → executor emergency close from journal only', lastError: providersFull.error?.message ?? readiness.error?.message ?? null, source: 'this page loaded through the operator RLS session' });
  push({ key: 'queue', label: 'Queue', state: 'NOT_APPLICABLE', lastSuccessAt: null, latencyMs: null, freshnessAgeMs: null, rateLimitState: null, effectOnEntries: '—', effectOnExits: '—', lastError: null, source: 'v1 schedules work through Postgres role leases; there is no separate queue' });
  {
    const leases = raw?.leases ?? [];
    const stale = leases.filter((l) => Date.parse(l.expires_at) < nowMs);
    const latestBeat = leases.map((l) => l.heartbeat_at).sort().at(-1) ?? null;
    push({ key: 'worker', label: 'Worker role heartbeats', state: leases.length === 0 ? 'NO_OBSERVATION' : stale.length === leases.length ? 'FAILED' : stale.length > 0 ? 'DEGRADED' : 'HEALTHY', lastSuccessAt: latestBeat, latencyMs: null, freshnessAgeMs: latestBeat ? nowMs - Date.parse(latestBeat) : null, rateLimitState: null, effectOnEntries: stale.some((l) => ['paper-entry', 'session', 'trading-actions'].includes(l.role)) ? 'BLOCK (entry roles not running)' : 'NONE', effectOnExits: stale.some((l) => ['position-monitor', 'held-asset-safety'].includes(l.role)) ? 'DEGRADED (monitor role not running)' : 'NONE', lastError: stale.length ? `expired: ${stale.map((l) => l.role).join(', ')}` : null, source: `${leases.length} lease(s) in ops.worker_leases` });
  }
  {
    const ex = providers.find((p) => /^EXECUT/i.test(p.provider)) ?? null;
    push({ key: 'executor', label: 'Executor (execution-service)', state: ex ? (ex.state === 'HEALTHY' ? 'HEALTHY' : ex.state === 'DEGRADED' ? 'DEGRADED' : 'FAILED') : 'NOT_CONFIGURED', lastSuccessAt: ex?.last_success_at ?? null, latencyMs: ex?.latency_ms ?? null, freshnessAgeMs: ex?.freshness_age_ms ?? null, rateLimitState: null, effectOnEntries: 'live entries impossible', effectOnExits: 'live exits impossible → EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS', lastError: ex?.last_error ?? null, source: ex ? 'notifications role executor probe' : 'EXECUTION_SERVICE_URL not set in this profile (paper adapter in the worker)' });
  }
  fromReadiness('signer', 'Production signer backend + policy gateway', ['SIGNER_CONTRACT_PROBE_C', 'SIGNER_DENY_EXPORT_PINNED'], 'blocks LIVE arming', 'signer outage → SIGNER_UNAVAILABLE_WITH_EXPOSURE', 'Turnkey probes from the isolated environment');
  fromReadiness('signer-identity', 'Autonomous signer workload identity / policy digest', ['PROBE_A_SIGNER_POLICY'], 'blocks LIVE arming', 'NONE', 'Probe A policy digest');
  fromReadiness('break-glass', 'Break-glass control readiness', ['BREAK_GLASS_SWEEP_DRILL'], 'blocks LIVE_AUTO arming', 'recovery sweep unavailable', 'status only; never routinely activated');
  {
    const recon = raw?.reconciliations[0] ?? null;
    const state: DependencyState = !recon ? 'NO_OBSERVATION' : recon.status === 'CLEAN' ? 'HEALTHY' : recon.status === 'UNAVAILABLE' ? 'DEGRADED' : 'FAILED';
    push({ key: 'reconciliation', label: 'Wallet reconciliation', state, lastSuccessAt: recon?.status === 'CLEAN' ? recon.evaluated_at : null, latencyMs: null, freshnessAgeMs: recon ? nowMs - Date.parse(recon.evaluated_at) : null, rateLimitState: null, effectOnEntries: recon?.status === 'MISMATCH' ? 'BLOCK (entry pause)' : 'NONE', effectOnExits: 'NONE', lastError: recon && recon.status !== 'CLEAN' ? (recon.reasons ?? []).join(', ') || recon.status : null, source: recon ? `latest trading.custody_reconciliations for account ${recon.account_id.slice(0, 8)}` : 'paper accounts have virtual custody; no LIVE account reconciled' });
  }
  fromReadiness('oob', 'Out-of-band control path', ['OUT_OF_BAND_CONTROLS'], 'NONE', 'kill / emergency-close path must not depend on web or DB', 'drill evidence');
  fromReadiness('risk-authorizer', 'Risk-authorizer + Release attestation', ['RISK_AUTHORIZER_ISOLATION_TAMPER', 'TINY_LIVE_RELEASE_BOUND', 'ARTIFACT_EGRESS_DIGEST'], 'live entries need a cleared authorization', 'NONE', 'CI evidence + computed release binding');
  {
    const channels = [...byChannel.values()];
    const drill = readinessMap.get('CRITICAL_ALERT_DELIVERY');
    const failing = channels.filter((c) => c.lastError && (!c.lastConfirmedAt || c.lastConfirmedAt < (c.lastAttemptAt ?? '')));
    const state: DependencyState = channels.length === 0 ? 'NO_OBSERVATION' : channels.length < 2 ? 'DEGRADED' : failing.length ? 'DEGRADED' : 'HEALTHY';
    push({ key: 'notifications', label: 'Notification delivery channels / escalation', state, lastSuccessAt: channels.map((c) => c.lastConfirmedAt).filter((x): x is string => !!x).sort().at(-1) ?? null, latencyMs: null, freshnessAgeMs: null, rateLimitState: null, effectOnEntries: 'NONE', effectOnExits: 'NONE', lastError: failing.map((c) => `${c.channel}: ${c.lastError}`).join('; ') || (channels.length < 2 ? 'CRITICAL needs two confirmed channels; only ' + (channels.map((c) => c.channel).join(', ') || 'none') + ' configured' : null), source: `${channels.length} channel(s) with deliveries${drill ? `; drill CRITICAL_ALERT_DELIVERY=${drill.verdict}` : ''}` });
  }
  {
    const paused = spendRows.filter((s) => s.state === 'BUDGET_PAUSED');
    push({ key: 'spend', label: 'Spend / rate budget state', state: spendRows.length === 0 ? 'NO_OBSERVATION' : paused.length ? 'DEGRADED' : 'HEALTHY', lastSuccessAt: spendRows.map((s) => s.updated_at).sort().at(-1) ?? null, latencyMs: null, freshnessAgeMs: null, rateLimitState: paused.length ? 'BUDGET_PAUSED' : spendRows.length ? 'OK' : null, effectOnEntries: paused.length ? 'discretionary cycles paused' : 'NONE', effectOnExits: 'NONE (hard exits never wait on budget)', lastError: null, source: `${spendRows.length} usage window(s) containing now` });
  }
  {
    const state: DependencyState = routeSummary.total === 0 ? 'NO_OBSERVATION' : ran === 0 ? 'FAILED' : ok === 0 ? 'FAILED' : ok < ran ? 'DEGRADED' : 'HEALTHY';
    push({ key: 'dry-run', label: 'Direct-pool emergency-route dry-run health', state, lastSuccessAt: latestAt, latencyMs: null, freshnessAgeMs: latestAt ? nowMs - Date.parse(latestAt) : null, rateLimitState: null, effectOnEntries: 'LIVE_AUTO entry per asset needs a fresh OK dry-run', effectOnExits: 'stale → fallback quality unknown', lastError: ran === 0 && routeSummary.total > 0 ? `no dry-run within ${maxAge / 3_600_000}h` : null, source: `${routeSummary.total} route snapshot(s); ${ok}/${ran} OK within ${maxAge / 3_600_000}h${Object.keys(classes).length ? `; ${Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}` });
  }

  return { dependencies: deps, raw, chain: chainRow, deliveries: [...byChannel.values()], routes: routeSummary, readiness: readinessMap };
}
