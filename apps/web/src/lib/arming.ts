import { loadHealthSummary, loadSleeves, loadSpendToday } from './control-room';
import { loadSystemHealth } from './health';
import { loadAlerts, loadReadinessVerdicts, loadReleases, type ReleaseView } from './ops';
import { loadPositionsWorkspace } from './positions';
import { createSupabaseServerClient } from './supabase/server';
import { loadWalletView, reserveStatus } from './wallet';

/**
 * Arming review read model (§20.3, §20.29). Everything the operator must see before arming a
 * Release or setting a live authority, bound to that immutable Release and diffed against the
 * previously armed one: wallet balance and blast radius, executor cap, risk policy version, live
 * strategies and sleeve caps, skill/guideline/automation/adversary versions, open positions,
 * protection modes, reserves, primary and emergency adapter status, unresolved critical/high
 * alerts, provider freshness, last reconciliation, deployment live capability, notification
 * channel health, dry-run freshness and spend-budget health. The page renders; the worker decides.
 */

export interface ArmingReview {
  release: ReleaseView;
  previousArmed: ReleaseView | null;
  diff: { key: string; before: string; after: string; changed: boolean }[];
  account: { id: string; name: string; cluster: string; trading_wallet: string; settlement_mint: string; mode: string } | null;
  accounts: { id: string; name: string; mode: string }[];
  wallet: Awaited<ReturnType<typeof loadWalletView>>;
  reserve: ReturnType<typeof reserveStatus> | null;
  sleeves: Awaited<ReturnType<typeof loadSleeves>>;
  positions: Awaited<ReturnType<typeof loadPositionsWorkspace>>;
  alerts: { open: { severity: string; alert_class: string; summary: string; raised_at: string; acknowledged_at: string | null }[] };
  health: Awaited<ReturnType<typeof loadHealthSummary>>;
  system: Awaited<ReturnType<typeof loadSystemHealth>>;
  spend: Awaited<ReturnType<typeof loadSpendToday>>;
  verdicts: Awaited<ReturnType<typeof loadReadinessVerdicts>>;
  profile: { profile: string; live_capital_allowed: boolean; physical_isolation: boolean } | null;
  attestations: Awaited<ReturnType<typeof loadReleases>>['attestations'];
  capital: Awaited<ReturnType<typeof loadReleases>>['capital'];
  session: { id: string; capital_authority: string; activity_state: string; paused: { active?: boolean } | null; profile: string } | null;
  strategy: { version_id: string; strategy_id: string; speed_tier: string; live_intent_expiry_ms: number; human_reaction_floor_ms: number; eligible_capital_authorities: string[]; status: string } | null;
}

const BINDING_KEYS = ['strategyVersionId', 'skillVersionId', 'guidelineVersionId', 'automationSetVersionId', 'proposerModelPolicyVersion', 'adversaryModelPolicyVersion', 'riskPolicyVersion', 'cohortPolicyVersion', 'freshnessPolicyVersion', 'executorPolicyRef', 'contractSetDigest'] as const;

export function diffBindings(a: ReleaseView['binding'] | null, b: ReleaseView['binding']): ArmingReview['diff'] {
  const rec = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
  const ra = rec(a);
  const rb = rec(b);
  return BINDING_KEYS.map((k) => {
    const before = ra[k] === undefined || ra[k] === null ? '—' : String(ra[k]);
    const after = rb[k] === undefined || rb[k] === null ? '—' : String(rb[k]);
    return { key: k, before, after, changed: before !== after };
  });
}

export async function loadArmingReview(releaseId: string, accountId: string | null, nowMs: number): Promise<ArmingReview | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const releasesView = await loadReleases();
  const release = releasesView.releases.find((r) => r.id === releaseId) ?? null;
  if (!release) return null;
  const previousArmed = releasesView.releases.find((r) => r.id !== releaseId && r.status === 'ARMED') ?? releasesView.releases.find((r) => r.id !== releaseId && r.status === 'RETIRED' && r.promoted_at) ?? null;
  const accounts = releasesView.accounts;
  const chosen = accountId ? accounts.find((a) => a.id === accountId) : (accounts.find((a) => a.mode === 'LIVE') ?? accounts[0]);
  const accountRow = chosen ? (await supabase.schema('trading').from('accounts').select('id, name, cluster, trading_wallet, settlement_mint, mode').eq('id', chosen.id).maybeSingle()).data : null;
  const account = (accountRow as ArmingReview['account']) ?? null;
  const strategyId = release.binding.strategyVersionId ?? null;
  const [wallet, sleeves, positions, alerts, health, system, spend, verdicts, session, strategy, profile] = await Promise.all([
    loadWalletView(),
    account ? loadSleeves(account.id) : Promise.resolve([]),
    account ? loadPositionsWorkspace(account.id, { includeClosed: false, limit: 50 }) : Promise.resolve([]),
    loadAlerts(),
    loadHealthSummary(nowMs),
    loadSystemHealth(nowMs),
    loadSpendToday(new Date(nowMs).toISOString()),
    loadReadinessVerdicts(),
    account ? supabase.schema('ops').from('runtime_sessions').select('id, capital_authority, activity_state, paused, profile').eq('account_id', account.id).order('created_at', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    strategyId ? supabase.schema('research').from('strategy_versions').select('version_id, strategy_id, speed_tier, live_intent_expiry_ms, human_reaction_floor_ms, eligible_capital_authorities, status').eq('version_id', strategyId).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema('ops').from('deployment_profiles').select('profile, live_capital_allowed, physical_isolation').order('profile'),
  ]);
  const sessionRow = (session.data as ArmingReview['session']) ?? null;
  const profiles = (profile.data as { profile: string; live_capital_allowed: boolean; physical_isolation: boolean }[] | null) ?? [];
  return {
    release,
    previousArmed,
    diff: diffBindings(previousArmed?.binding ?? null, release.binding),
    account,
    accounts,
    wallet,
    reserve: wallet.account ? reserveStatus(wallet.reconciliation, wallet.account.settlement_mint) : null,
    sleeves,
    positions,
    alerts: { open: alerts.open.map((n) => ({ severity: n.severity, alert_class: n.alert_class, summary: n.summary, raised_at: n.raised_at, acknowledged_at: n.acknowledged_at })) },
    health,
    system,
    spend,
    verdicts,
    profile: profiles.find((p) => p.profile === sessionRow?.profile) ?? null,
    attestations: releasesView.attestations.filter((a) => a.release_id === releaseId),
    capital: releasesView.capital.filter((c) => c.release_id === releaseId),
    session: sessionRow,
    strategy: strategy.data ? { ...(strategy.data as NonNullable<ArmingReview['strategy']>), eligible_capital_authorities: (strategy.data as { eligible_capital_authorities: string[] | null }).eligible_capital_authorities ?? [] } : null,
  };
}
