import type { ActivityState, AlertSeverity, CapitalAuthority, ProviderHealth } from '@sol-agent-trader/contracts';
import { requestEndSession, requestPauseNewEntries } from '../app/(app)/actions';
import { activityTone, alertsLabel, authorityTone, entriesLabel, freshnessLabel, healthTone, valueOrMissing, worstHealth, type Tone } from '../lib/status';
import { baseToUsd, loadEquity, loadPaperAccount } from '../lib/paper';
import { createSupabaseServerClient } from '../lib/supabase/server';
import { PauseControl } from './pause-control';
import { ScopeSelector } from './scope-selector';

/**
 * Persistent status bar (§20.1). Activity and capital authority are separate chips; PAUSED is a
 * sticky third channel; every data chip knows whether it has data (§20.21). Reads are RLS-scoped
 * projections of ledger state, never authority (§20.0 principle 10).
 */
function Chip({ k, v, tone }: { k: string; v: string; tone: Tone }) {
  return (
    <span className="chip" data-tone={tone}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </span>
  );
}

export interface StatusSnapshot {
  activity: ActivityState | null;
  authority: CapitalAuthority | null;
  paused: boolean;
  attended: boolean | null;
  profile: string | null;
  presenceAgeMs: number | null;
  feedsAgeMs: number | null;
  worstProvider: ProviderHealth | null;
  db: 'ok' | 'failed' | 'unconfigured';
  openAlerts: AlertSeverity[];
  equityUsd: number | null;
  exposureFraction: number | null;
  dayPnlFraction: number | null;
  canControl: boolean;
}

export async function loadStatusSnapshot(): Promise<StatusSnapshot> {
  const empty: StatusSnapshot = {
    activity: null, authority: null, paused: false, attended: null, profile: null, presenceAgeMs: null, feedsAgeMs: null,
    worstProvider: null, db: 'unconfigured', openAlerts: [], equityUsd: null, exposureFraction: null, dayPnlFraction: null, canControl: false,
  };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return empty;
  try {
    const [session, providers, alerts, operator] = await Promise.all([
      supabase.schema('ops').from('runtime_sessions').select('activity_state, capital_authority, paused, attended, profile, last_presence_heartbeat_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.schema('ops').from('provider_health').select('state, freshness_age_ms'),
      supabase.schema('ops').from('notifications').select('severity').is('resolved_at', null),
      supabase.auth.getUser().then(async ({ data }) => (data.user ? supabase.schema('ops').from('operators').select('role').eq('user_id', data.user.id).maybeSingle() : { data: null })),
    ]);
    const account = await loadPaperAccount();
    const equity = account ? await loadEquity(account.id) : { latest: null, dayStart: null };
    const latestEquity = baseToUsd(equity.latest?.equity_base_units);
    const dayStartEquity = baseToUsd(equity.dayStart?.equity_base_units);
    const paused = (session.data?.paused as { active?: boolean } | null)?.active ?? false;
    const heartbeat = session.data?.last_presence_heartbeat_at ? Date.now() - Date.parse(session.data.last_presence_heartbeat_at) : null;
    const ages = (providers.data ?? []).map((p) => p.freshness_age_ms).filter((a): a is number => a !== null);
    const role = operator.data?.role ?? null;
    return {
      activity: session.data?.activity_state ?? null,
      authority: session.data?.capital_authority ?? null,
      paused,
      attended: session.data?.attended ?? null,
      profile: session.data?.profile ?? null,
      presenceAgeMs: heartbeat,
      feedsAgeMs: ages.length ? Math.max(...ages) : null,
      worstProvider: worstHealth((providers.data ?? []).map((p) => p.state)),
      db: session.error || providers.error ? 'failed' : 'ok',
      openAlerts: (alerts.data ?? []).map((a) => a.severity),
      // Paper book, settlement is USDC so base units read as USD (§20.1); absent until the first snapshot.
      equityUsd: latestEquity,
      exposureFraction: equity.latest?.exposure_fraction ?? null,
      dayPnlFraction: latestEquity !== null && dayStartEquity !== null && dayStartEquity > 0 ? (latestEquity - dayStartEquity) / dayStartEquity : null,
      canControl: role === 'operator' || role === 'admin',
    };
  } catch {
    return { ...empty, db: 'failed' };
  }
}

export async function StatusBar() {
  const s = await loadStatusSnapshot();
  const activity = s.activity ? { text: s.activity, tone: activityTone(s.activity) } : { text: 'NO SESSION', tone: 'unknown' as Tone };
  const authority = s.authority ? { text: s.authority, tone: authorityTone(s.authority) } : { text: 'UNKNOWN', tone: 'unknown' as Tone };
  const entries = s.activity && s.authority ? entriesLabel({ activity: s.activity, authority: s.authority, paused: s.paused }) : { text: 'NO SESSION', tone: 'unknown' as Tone };
  const feeds = freshnessLabel(s.feedsAgeMs, 5_000);
  const alerts = alertsLabel(s.openAlerts);
  return (
    <header className="statusbar" role="status" aria-label="Runtime status">
      <Chip k="activity" v={activity.text} tone={activity.tone} />
      <Chip k="authority" v={authority.text} tone={authority.tone} />
      {s.paused && <Chip k="override" v="PAUSED" tone="paused" />}
      <Chip k="entries" v={entries.text} tone={entries.tone} />
      <Chip k="attended" v={s.attended === null ? '—' : s.attended ? `YES ${freshnessLabel(s.presenceAgeMs, 60_000).text}` : 'NO'} tone={s.attended === null ? 'unknown' : 'ok'} />
      <Chip k="feeds" v={feeds.text} tone={feeds.tone} />
      <Chip k="providers" v={s.worstProvider ?? 'NO DATA'} tone={healthTone(s.worstProvider)} />
      <Chip k="db" v={s.db.toUpperCase()} tone={s.db === 'ok' ? 'ok' : s.db === 'failed' ? 'failed' : 'unknown'} />
      <Chip k="equity" v={valueOrMissing(s.equityUsd, (n) => `$${n.toLocaleString()}`).text} tone={valueOrMissing(s.equityUsd, String).tone} />
      <Chip k="exposure" v={valueOrMissing(s.exposureFraction, (n) => `${(n * 100).toFixed(0)}%`).text} tone={valueOrMissing(s.exposureFraction, String).tone} />
      <Chip k="day p&l" v={valueOrMissing(s.dayPnlFraction, (n) => `${(n * 100).toFixed(1)}%`).text} tone={valueOrMissing(s.dayPnlFraction, String).tone} />
      <Chip k="alerts" v={alerts.text} tone={alerts.tone} />
      <span className="spacer" />
      <ScopeSelector current="LIVE" />
      <PauseControl action={requestPauseNewEntries} disabled={!s.canControl} />
      <form action={requestEndSession}>
        <button className="btn" type="submit" disabled={!s.canControl} title="Transitions to WIND_DOWN, never straight to OFF (D61)">
          END SESSION
        </button>
      </form>
    </header>
  );
}
