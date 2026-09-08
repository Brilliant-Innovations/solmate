import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { ago } from '../../../lib/paper';
import { loadSystemHealth, type DependencyState } from '../../../lib/health';

export const dynamic = 'force-dynamic';

/**
 * System Health (§20.19, §21.1A): every critical dependency independently, with state, last
 * success, latency, freshness, rate-limit state, effect on entries and exits, and last error.
 * Below the catalogue: the raw provider feed rows per data class, worker role leases, notification
 * channels, the chain-health snapshot and the latest custody reconciliation. A missing row is
 * reported as missing, never as healthy. The browser Wallet Standard connector is deliberately not
 * a dependency here: autonomous trading must stay healthy with no operator wallet connected.
 */
export default async function Health() {
  const now = Date.now();
  const [digest, health] = await Promise.all([getContractSetDigest(), loadSystemHealth(now)]);
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const tone = (s: DependencyState | string) => (s === 'HEALTHY' || s === 'CLEAN' ? 'ok' : s === 'DEGRADED' || s === 'UNAVAILABLE' || s === 'LAGGING' ? 'degraded' : s === 'FAILED' || s === 'MISMATCH' || s === 'STALLED' || s === 'DIVERGENT' ? 'failed' : 'unknown');
  const failed = health.dependencies.filter((d) => d.state === 'FAILED');
  const degraded = health.dependencies.filter((d) => d.state === 'DEGRADED');
  const age = (ms: number | null) => (ms === null ? 'no data' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
  return (
    <>
      <h1 style={{ marginTop: 0 }}>System Health</h1>

      {(failed.length > 0 || degraded.length > 0) && (
        <div className="notice" data-tone={failed.length > 0 ? 'failed' : undefined} role="alert">
          {failed.length > 0 ? `FAILED: ${failed.map((d) => d.label).join(', ')}. ` : ''}
          {degraded.length > 0 ? `DEGRADED: ${degraded.map((d) => d.label).join(', ')}. ` : ''}
          Effects on entries and exits are listed per dependency below; a blocking effect is enforced by the worker and risk-authorizer, not by this page.
        </div>
      )}

      <section className="panel">
        <h2>Critical dependencies ({health.dependencies.length})</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['dependency', 'state', 'last success', 'latency', 'freshness', 'rate limit', 'effect on entries', 'effect on exits', 'last probe / error', 'source'].map((h) => (
                  <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {health.dependencies.map((d) => (
                <tr key={d.key} style={{ borderTop: '1px solid var(--rule)' }}>
                  <td style={cell}>{d.label}</td>
                  <td style={cell}><span className="chip" data-tone={tone(d.state)}><span className="v">{d.state.replace('_', ' ')}</span></span></td>
                  <td style={cell}>{d.lastSuccessAt ? ago(d.lastSuccessAt, now) : 'never'}</td>
                  <td style={cell}>{d.latencyMs === null ? '—' : `${d.latencyMs}ms`}</td>
                  <td style={cell}>{age(d.freshnessAgeMs)}</td>
                  <td style={cell}>{d.rateLimitState ?? '—'}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', minWidth: '10rem' }}>{d.effectOnEntries}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', minWidth: '10rem' }}>{d.effectOnExits}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', minWidth: '12rem' }} className={d.lastError ? undefined : 'muted'}>{d.lastError ?? '—'}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', minWidth: '16rem' }} className="muted">{d.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: '0.5rem 0 0' }}>
          NO OBSERVATION: the dependency exists in this deployment but nothing has reported yet. NOT CONFIGURED: the profile does not run it (paper profiles have no executor, signer or model keys). NOT APPLICABLE: not part of v1.
        </p>
      </section>

      <section className="panel">
        <h2>Provider feeds by data class</h2>
        {!health.raw || health.raw.providers.length === 0 ? (
          <p className="muted">No provider health rows: ingestion has not reported.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['provider : data class', 'state', 'entries', 'freshness', 'latency', 'updated', 'last error'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {health.raw.providers.map((p) => (
                  <tr key={p.provider}>
                    <td style={cell}>{p.provider}</td>
                    <td style={cell}><span className="chip" data-tone={tone(p.state)}><span className="v">{p.state}</span></span>{p.freshness_age_ms === null && p.state === 'FAILED' ? <span className="muted"> (never observed)</span> : null}</td>
                    <td style={cell}>{p.effect_on_entries ?? '—'}</td>
                    <td style={cell}>{p.freshness_age_ms === null ? 'no data' : `${(p.freshness_age_ms / 1000).toFixed(1)}s`}</td>
                    <td style={cell}>{p.latency_ms === null ? '—' : `${p.latency_ms}ms`}</td>
                    <td style={cell}>{ago(p.updated_at, now)}</td>
                    <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{p.last_error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Worker roles</h2>
          {!health.raw || health.raw.leases.length === 0 ? (
            <p className="muted">No worker lease held: no worker is running.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                {health.raw.leases.map((l) => {
                  const stale = Date.parse(l.expires_at) < now;
                  return (
                    <tr key={l.role}>
                      <td style={cell}>{l.role}</td>
                      <td style={cell}>{l.holder}</td>
                      <td style={cell}><span className="chip" data-tone={stale ? 'failed' : 'ok'}><span className="v">{stale ? 'LEASE EXPIRED' : 'ALIVE'}</span></span></td>
                      <td style={cell} className="muted">heartbeat {ago(l.heartbeat_at, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Chain view</h2>
          {!health.chain ? (
            <p className="muted">No chain-health snapshot recorded.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={cell} className="muted">state</td><td style={cell}><span className="chip" data-tone={tone(health.chain.state)}><span className="v">{health.chain.state}</span></span> {ago(health.chain.observed_at, now)}</td></tr>
                <tr><td style={cell} className="muted">head slot</td><td style={cell}>{health.chain.head_slot ?? '—'}</td></tr>
                <tr><td style={cell} className="muted">confirmed → finalized lag</td><td style={cell}>{health.chain.confirmed_finalized_lag_slots === null ? '—' : `${health.chain.confirmed_finalized_lag_slots} slots`}</td></tr>
                <tr><td style={cell} className="muted">view divergence</td><td style={cell}>{health.chain.view_divergence_slots === null ? '—' : `${health.chain.view_divergence_slots} slots`}</td></tr>
                <tr><td style={cell} className="muted">effect on entries</td><td style={cell}>{health.chain.effect_on_entries}{health.chain.reasons.length ? ` (${health.chain.reasons.join(', ')})` : ''}</td></tr>
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Notification channels</h2>
          {health.deliveries.length === 0 ? (
            <p className="muted">No delivery attempted yet.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                {health.deliveries.map((c) => (
                  <tr key={c.channel}>
                    <td style={cell}>{c.channel}</td>
                    <td style={cell}><span className="chip" data-tone={c.lastConfirmedAt ? 'ok' : 'failed'}><span className="v">{c.lastConfirmedAt ? 'CONFIRMED' : 'UNCONFIRMED'}</span></span></td>
                    <td style={cell} className="muted">{c.attempts} attempt(s) · last confirmed {c.lastConfirmedAt ? ago(c.lastConfirmedAt, now) : 'never'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{c.lastError ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>CRITICAL alerts need two confirmed channels (§21.8). <a href="/alerts">Alert center</a></p>
        </section>

        <section className="panel">
          <h2>Chain / custody reconciliation (LIVE accounts)</h2>
          {!health.raw || health.raw.reconciliations.length === 0 ? (
            <p className="muted">No reconciliation recorded. Paper accounts have virtual custody and are not reconciled.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                {health.raw.reconciliations.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td style={cell}>{r.account_id.slice(0, 8)}</td>
                    <td style={cell}><span className="chip" data-tone={tone(r.status)}><span className="v">{r.status}</span></span></td>
                    <td style={cell}>{ago(r.evaluated_at, now)}</td>
                    <td style={cell} className="muted">{(r.reasons ?? []).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Emergency-route dry-runs</h2>
          <p className="mono" style={{ margin: 0 }}>
            {health.routes.total} route snapshot(s) · {health.routes.okWithinMaxAge}/{health.routes.ranWithinMaxAge} OK within the policy window · latest {health.routes.latestAt ? ago(health.routes.latestAt, now) : 'never'}
          </p>
          {Object.keys(health.routes.classes).length > 0 && (
            <p className="mono muted" style={{ margin: '0.3rem 0 0' }}>{Object.entries(health.routes.classes).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>A stale or failed dry-run blocks LIVE_AUTO entries for that asset (§14.6); it never blocks an exit. <a href="/readiness">Live Readiness</a></p>
        </section>

        <section className="panel">
          <h2>This deployment</h2>
          <p className="mono">contract set {digest.digest.slice(0, 16)}… · {digest.schemaCount} schemas · {digest.format}</p>
        </section>
      </div>
    </>
  );
}
