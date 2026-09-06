import type { ActivityState, AlertSeverity, CapitalAuthority, ProviderHealth } from '@sol-agent-trader/contracts';

/**
 * Pure presentation helpers for the status bar (blueprint §20.1, §20.21). No IO. These decide how
 * a value is *labelled*, never what it is. Missing data is shown as missing, never as zero.
 */

export type Tone =
  | 'observe' | 'paper' | 'live-approval' | 'live-auto' | 'paused'
  | 'off' | 'starting' | 'watch' | 'active' | 'event-window' | 'wind-down'
  | 'ok' | 'degraded' | 'failed' | 'unknown';

export function authorityTone(a: CapitalAuthority): Tone {
  return a === 'OBSERVE' ? 'observe' : a === 'PAPER' ? 'paper' : a === 'LIVE_APPROVAL' ? 'live-approval' : 'live-auto';
}

export function activityTone(s: ActivityState): Tone {
  switch (s) {
    case 'OFF': return 'off';
    case 'STARTING': return 'starting';
    case 'WATCH': return 'watch';
    case 'ACTIVE': return 'active';
    case 'EVENT_WINDOW': return 'event-window';
    case 'WIND_DOWN': return 'wind-down';
  }
}

export function healthTone(h: ProviderHealth | null | undefined): Tone {
  return h === 'HEALTHY' ? 'ok' : h === 'DEGRADED' ? 'degraded' : h === 'FAILED' ? 'failed' : 'unknown';
}

/** Worst-case across providers; unknown (no rows) is reported as unknown, not healthy. */
export function worstHealth(states: readonly (ProviderHealth | null)[]): ProviderHealth | null {
  if (states.length === 0) return null;
  if (states.some((s) => s === 'FAILED' || s === null)) return states.some((s) => s === 'FAILED') ? 'FAILED' : null;
  if (states.some((s) => s === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

/**
 * Freshness label. `null` age means no observation yet and must never read as "0s" or fresh.
 * Breaching the limit shows STALE with the age (§20.1 Feeds chip).
 */
export function freshnessLabel(ageMs: number | null, limitMs: number): { text: string; tone: Tone } {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return { text: 'NO DATA', tone: 'unknown' };
  const text = ageMs < 1000 ? `${ageMs}ms` : ageMs < 60_000 ? `${(ageMs / 1000).toFixed(1)}s` : `${Math.floor(ageMs / 60_000)}m`;
  return ageMs > limitMs ? { text: `STALE ${text}`, tone: 'failed' } : { text: `FRESH ${text}`, tone: 'ok' };
}

/** Numbers shown in the chrome: absent stays absent (§20.21 "never render 0 as a fallback"). */
export function valueOrMissing(value: number | null | undefined, format: (n: number) => string): { text: string; tone: Tone } {
  return value === null || value === undefined || !Number.isFinite(value) ? { text: '—', tone: 'unknown' } : { text: format(value), tone: 'ok' };
}

/** "ENTRIES: ARMED / BLOCKED" from the D60 gate: not paused, activity permits, authority not OBSERVE. */
export function entriesLabel(s: { activity: ActivityState; authority: CapitalAuthority; paused: boolean }): { text: string; tone: Tone } {
  if (s.paused) return { text: 'PAUSED', tone: 'paused' };
  const activityPermits = s.activity === 'ACTIVE' || s.activity === 'EVENT_WINDOW';
  if (!activityPermits || s.authority === 'OBSERVE') return { text: 'BLOCKED', tone: 'off' };
  return { text: 'ARMED', tone: s.authority === 'PAPER' ? 'paper' : authorityTone(s.authority) };
}

export function severityRank(s: AlertSeverity): number {
  return { INFO: 0, NOTICE: 1, HIGH: 2, CRITICAL: 3 }[s];
}

export function alertsLabel(open: readonly AlertSeverity[]): { text: string; tone: Tone } {
  if (open.length === 0) return { text: '0', tone: 'ok' };
  const worst = open.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a), 'INFO' as AlertSeverity);
  return { text: `${open.length} (${worst})`, tone: worst === 'CRITICAL' ? 'failed' : worst === 'HIGH' ? 'degraded' : 'ok' };
}
