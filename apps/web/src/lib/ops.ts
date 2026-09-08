import { createSupabaseServerClient } from './supabase/server';

/**
 * Read models for the minimum live operator surface (blueprint §20.8 Approval Queue, §20.20 alert
 * center, §20.28 Live Readiness, §12.4 Releases; execution plan M8a). Every loader is an RLS-scoped
 * projection of ledger state under the operator's own session; the browser never derives authority
 * from what it reads (§20.0 principle 10) and a missing value stays missing (§20.21).
 */

export interface ReadinessRowOutcomeView {
  rowId: string;
  kind: string;
  required: boolean;
  verdict: string;
  reason: string | null;
  evaluatedAt: string | null;
  rowRef: string | null;
}

export interface ReadinessVerdictView {
  id: string;
  name: string;
  profile: string;
  strategy_class: string;
  release_id: string | null;
  verdict: 'READY' | 'NOT_READY';
  rows: ReadinessRowOutcomeView[];
  missing: string[];
  stale: string[];
  failed: string[];
  not_applicable: string[];
  enabled_capabilities: string[];
  binding: { gitSha?: string; contractSetDigest?: string; tradingWallet?: string | null; cluster?: string; profile?: string; releaseDigest?: string | null; policyDigests?: Record<string, string> };
  policy_version: string;
  computed_at: string;
}

export interface ReadinessRowView {
  id: string;
  row_id: string;
  kind: string;
  verdict: string;
  strategy_class: string;
  profile: string;
  detail: Record<string, unknown>;
  evidence_ref: string | null;
  recorded_by: string;
  evaluated_at: string;
  expires_at: string | null;
}

export interface ControlRequestView {
  id: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

export async function loadControlRequests(kinds: string[], limit = 20): Promise<ControlRequestView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('ops').from('control_requests').select('id, kind, state, payload, resolution, created_at, resolved_at').in('kind', kinds as never[]).order('created_at', { ascending: false }).limit(limit);
  return (data ?? []) as unknown as ControlRequestView[];
}

export async function loadReadiness(): Promise<{ verdict: ReadinessVerdictView | null; rows: ReadinessRowView[] }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { verdict: null, rows: [] };
  const [verdict, rows] = await Promise.all([
    supabase.schema('ops').from('readiness_verdicts').select('*').order('computed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('ops').from('readiness_rows').select('id, row_id, kind, verdict, strategy_class, profile, detail, evidence_ref, recorded_by, evaluated_at, expires_at').order('evaluated_at', { ascending: false }).limit(300),
  ]);
  // newest row per row id, for the profile and class the verdict was computed for
  const v = (verdict.data as unknown as ReadinessVerdictView | null) ?? null;
  const seen = new Set<string>();
  const latest: ReadinessRowView[] = [];
  for (const r of (rows.data ?? []) as unknown as ReadinessRowView[]) {
    if (v && (r.profile !== v.profile || r.strategy_class !== v.strategy_class)) continue;
    if (seen.has(r.row_id)) continue;
    seen.add(r.row_id);
    latest.push(r);
  }
  return { verdict: v, rows: latest };
}

export interface NotificationView {
  id: string;
  severity: 'INFO' | 'NOTICE' | 'HIGH' | 'CRITICAL';
  alert_class: string;
  summary: string;
  affected: Record<string, unknown>;
  raised_at: string;
  automated_response: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  escalation_level: number;
  dead_man_deadline: string | null;
  dead_man_action_taken: string | null;
}

export interface DeliveryView {
  notification_id: string;
  channel: string;
  escalation_level: number;
  attempted_at: string;
  confirmed_at: string | null;
  error: string | null;
}

export async function loadAlerts(): Promise<{ open: NotificationView[]; recent: NotificationView[]; deliveries: DeliveryView[] }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { open: [], recent: [], deliveries: [] };
  const cols = 'id, severity, alert_class, summary, affected, raised_at, automated_response, acknowledged_at, acknowledged_by, resolved_at, escalation_level, dead_man_deadline, dead_man_action_taken';
  const [open, recent] = await Promise.all([
    supabase.schema('ops').from('notifications').select(cols).is('resolved_at', null).order('raised_at', { ascending: false }).limit(100),
    supabase.schema('ops').from('notifications').select(cols).not('resolved_at', 'is', null).neq('alert_class', 'SYSTEM_ALIVE').order('resolved_at', { ascending: false }).limit(20),
  ]);
  const openRows = (open.data ?? []) as unknown as NotificationView[];
  const ids = openRows.map((n) => n.id);
  const deliveries = ids.length ? ((await supabase.schema('ops').from('notification_deliveries').select('notification_id, channel, escalation_level, attempted_at, confirmed_at, error').in('notification_id', ids).order('attempted_at', { ascending: false })).data ?? []) : [];
  return { open: openRows, recent: (recent.data ?? []) as unknown as NotificationView[], deliveries: deliveries as unknown as DeliveryView[] };
}

export interface PendingApprovalView {
  intent_id: string;
  authorization_hash: string;
  expires_at: string;
  created_at: string;
  intents: { id: string; action: string; side: string; asset_id: string; strategy_version_id: string; max_input_amount: string; lifecycle_state: string; approval_required: boolean; expires_at: string; account_id: string } | null;
}

/** Authorizations awaiting a LIVE_APPROVAL grant: signed by the risk-authorizer, unexpired, intent still AUTHORIZED. */
export async function loadApprovalQueue(): Promise<PendingApprovalView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .schema('trading')
    .from('risk_authorizations')
    .select('intent_id, authorization_hash, expires_at, created_at, intents!inner(id, action, side, asset_id, strategy_version_id, max_input_amount, lifecycle_state, approval_required, expires_at, account_id)')
    .gt('expires_at', nowIso)
    .eq('intents.approval_required', true)
    .in('intents.lifecycle_state', ['AUTHORIZED'])
    .order('expires_at', { ascending: true })
    .limit(50);
  return (data ?? []) as unknown as PendingApprovalView[];
}

export interface ReleaseView {
  id: string;
  digest: string;
  binding: { strategyVersionId?: string; skillVersionId?: string | null; guidelineVersionId?: string | null; automationSetVersionId?: string | null; proposerModelPolicyVersion?: string | null; adversaryModelPolicyVersion?: string; riskPolicyVersion?: string; cohortPolicyVersion?: string; freshnessPolicyVersion?: string; executorPolicyRef?: string; contractSetDigest?: string };
  status: string;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
}

export interface AttestationView {
  id: string;
  release_id: string;
  purpose: string;
  operator_role: string;
  verification_result: boolean;
  attested_at: string;
  expires_at: string | null;
}

export interface CapitalAttestationView {
  id: string;
  account_id: string;
  release_id: string;
  ceiling_usd: number;
  recognized_usd_at_attestation: number | null;
  attested_at: string;
}

export async function loadReleases(): Promise<{ releases: ReleaseView[]; attestations: AttestationView[]; capital: CapitalAttestationView[]; accounts: { id: string; name: string; mode: string }[] }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { releases: [], attestations: [], capital: [], accounts: [] };
  const [releases, attestations, capital, accounts] = await Promise.all([
    supabase.schema('research').from('releases').select('id, digest, binding, status, created_at, promoted_at, retired_at').order('created_at', { ascending: false }).limit(30),
    supabase.schema('research').from('release_attestations').select('id, release_id, purpose, operator_role, verification_result, attested_at, expires_at').order('attested_at', { ascending: false }).limit(60),
    supabase.schema('ops').from('capital_attestations').select('id, account_id, release_id, ceiling_usd, recognized_usd_at_attestation, attested_at').order('attested_at', { ascending: false }).limit(30),
    supabase.schema('trading').from('accounts').select('id, name, mode').order('created_at', { ascending: false }).limit(10),
  ]);
  return {
    releases: (releases.data ?? []) as unknown as ReleaseView[],
    attestations: (attestations.data ?? []) as unknown as AttestationView[],
    capital: (capital.data ?? []) as unknown as CapitalAttestationView[],
    accounts: (accounts.data ?? []) as unknown as { id: string; name: string; mode: string }[],
  };
}

/** Human-readable time remaining; negative is "expired". Never a bare number (§20.21). */
export function remaining(iso: string, now = Date.now()): { text: string; expired: boolean } {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return { text: 'unknown', expired: true };
  if (ms <= 0) return { text: 'expired', expired: true };
  return { text: ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`, expired: false };
}

/** §20.28: distinct READY FOR LIVE_APPROVAL / LIVE_AUTO verdicts. Latest verdict per name, for the newest profile/strategy class each was computed for. */
export async function loadReadinessVerdicts(): Promise<ReadinessVerdictView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data } = await supabase.schema('ops').from('readiness_verdicts').select('*').order('computed_at', { ascending: false }).limit(60);
  const seen = new Set<string>();
  const out: ReadinessVerdictView[] = [];
  for (const v of (data as unknown as ReadinessVerdictView[] | null) ?? []) {
    const key = `${v.name}:${v.strategy_class}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
