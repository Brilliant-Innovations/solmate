import { DEFAULT_COHORT_TAXONOMY, DEFAULT_CORRELATION_CLUSTER_POLICY, DEFAULT_EMERGENCY_ROUTE_POLICY, DEFAULT_PAPER_FILL_POLICY, DEFAULT_RISK_POLICY, DEFAULT_SAFETY_POLICY } from '@sol-agent-trader/contracts';
import { loadReleases } from './ops';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Risk & Policy read model (§20.17). Policies are versioned data pinned in `/libs/contracts` and
 * bound into Releases (D38); this page shows them, never edits them: changing live risk policy is
 * a new version plus re-arming (§31 "live configuration is immutable Release-bound and step-up
 * attested"). Hard settings (the risk-authorizer enforces them) are labelled apart from research
 * or soft settings (paper fill model, cohort taxonomy confidence).
 */

export interface RiskPolicyView {
  risk: typeof DEFAULT_RISK_POLICY;
  safety: typeof DEFAULT_SAFETY_POLICY;
  emergency: typeof DEFAULT_EMERGENCY_ROUTE_POLICY;
  paperFill: typeof DEFAULT_PAPER_FILL_POLICY;
  cohorts: typeof DEFAULT_COHORT_TAXONOMY;
  clusters: typeof DEFAULT_CORRELATION_CLUSTER_POLICY;
  sleeves: { account_id: string; strategy_version_id: string; version_id: string; capital_cap_base_units: string; risk_budget_base_units: string; committed_base_units: string; risk_used_base_units: string; active: boolean }[];
  strategies: { version_id: string; strategy_id: string; status: string; risk_policy_version: string; chase_tolerance_bps: number; max_quote_age_ms: number; live_intent_expiry_ms: number; eligible_capital_authorities: string[]; active_from: string; active_to: string | null }[];
  cohortRows: { name: string; version_id: string; active: boolean; members: number }[];
  clusterVersions: { version_id: string; calculated_at: string; window_start: string; window_end: string; clusters: unknown }[];
  releases: Awaited<ReturnType<typeof loadReleases>>;
  latestProjection: { as_of: string; sequence: number; chain_slot: number; key_id: string } | null;
  latestEvaluation: { policy_version: string; allowed: boolean; reason_codes: string[]; daily_drawdown_fraction: number; circuit_breaker_tripped: boolean; created_at: string } | null;
}

export async function loadRiskPolicy(): Promise<RiskPolicyView> {
  const supabase = await createSupabaseServerClient();
  const base: RiskPolicyView = { risk: DEFAULT_RISK_POLICY, safety: DEFAULT_SAFETY_POLICY, emergency: DEFAULT_EMERGENCY_ROUTE_POLICY, paperFill: DEFAULT_PAPER_FILL_POLICY, cohorts: DEFAULT_COHORT_TAXONOMY, clusters: DEFAULT_CORRELATION_CLUSTER_POLICY, sleeves: [], strategies: [], cohortRows: [], clusterVersions: [], releases: { releases: [], attestations: [], capital: [], accounts: [] }, latestProjection: null, latestEvaluation: null };
  if (!supabase) return base;
  const [sleeves, strategies, cohorts, memberships, clusters, releases, projection, evaluation] = await Promise.all([
    supabase.schema('trading').from('strategy_sleeves').select('account_id, strategy_version_id, version_id, capital_cap_base_units, risk_budget_base_units, committed_base_units, risk_used_base_units, active').order('strategy_version_id'),
    supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, status, risk_policy_version, chase_tolerance_bps, max_quote_age_ms, live_intent_expiry_ms, eligible_capital_authorities, active_from, active_to').order('version_id'),
    supabase.schema('core').from('risk_cohorts').select('id, name, version_id, active').order('name'),
    supabase.schema('core').from('asset_cohort_memberships').select('cohort_id').eq('approval_state', 'ACTIVE').limit(2000),
    supabase.schema('risk').from('correlation_clusters').select('version_id, calculated_at, window_start, window_end, clusters').order('calculated_at', { ascending: false }).limit(3),
    loadReleases(),
    supabase.schema('risk').from('state_projections').select('as_of, sequence, chain_slot, key_id').order('as_of', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('trading').from('risk_evaluations').select('policy_version, allowed, reason_codes, daily_drawdown_fraction, circuit_breaker_tripped, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const memberCount = new Map<string, number>();
  for (const m of (memberships.data as { cohort_id: string }[] | null) ?? []) memberCount.set(m.cohort_id, (memberCount.get(m.cohort_id) ?? 0) + 1);
  return {
    ...base,
    sleeves: (sleeves.data as unknown as RiskPolicyView['sleeves'] | null) ?? [],
    strategies: ((strategies.data as unknown as RiskPolicyView['strategies'] | null) ?? []).map((s) => ({ ...s, eligible_capital_authorities: s.eligible_capital_authorities ?? [] })),
    cohortRows: ((cohorts.data as { id: string; name: string; version_id: string; active: boolean }[] | null) ?? []).map((c) => ({ name: c.name, version_id: c.version_id, active: c.active, members: memberCount.get(c.id) ?? 0 })),
    clusterVersions: (clusters.data as unknown as RiskPolicyView['clusterVersions'] | null) ?? [],
    releases,
    latestProjection: projection.data ? { ...(projection.data as { as_of: string; sequence: number | string; chain_slot: number | string; key_id: string }), sequence: Number((projection.data as { sequence: unknown }).sequence), chain_slot: Number((projection.data as { chain_slot: unknown }).chain_slot) } : null,
    latestEvaluation: (evaluation.data as unknown as RiskPolicyView['latestEvaluation']) ?? null,
  };
}
