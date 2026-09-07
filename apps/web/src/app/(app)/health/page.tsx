import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { ago, loadHealth } from '../../../lib/paper';

export const dynamic = 'force-dynamic';

/**
 * System Health (§20.19, §21.1A): provider freshness with its effect on entries and exits, worker
 * role leases with heartbeats, the latest chain/custody reconciliation per LIVE account, and this
 * deployment's contract-set digest. A missing row is reported as missing, never as healthy.
 */
export default async function Health() {
  const digest = await getContractSetDigest();
  const health = await loadHealth();
  const now = Date.now();
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const };
  const tone = (state: string) => (state === 'HEALTHY' || state === 'CLEAN' ? 'ok' : state === 'DEGRADED' || state === 'UNAVAILABLE' ? 'degraded' : 'failed');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>System Health</h1>
      <section className="panel">
        <h2>Provider feeds</h2>
        {!health || health.providers.length === 0 ? (
          <p className="muted">No provider health rows: ingestion has not reported.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['provider', 'state', 'entries', 'freshness', 'latency', 'updated', 'last error'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {health.providers.map((p) => (
                  <tr key={p.provider}>
                    <td style={cell}>{p.provider}</td>
                    <td style={cell}><span className="chip" data-tone={tone(p.state)}><span className="v">{p.state}</span></span></td>
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
      <section className="panel">
        <h2>Worker roles</h2>
        {!health || health.leases.length === 0 ? (
          <p className="muted">No worker lease held: no worker is running.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {health.leases.map((l) => {
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
        <h2>Chain / custody reconciliation (LIVE accounts)</h2>
        {!health || health.reconciliations.length === 0 ? (
          <p className="muted">No reconciliation recorded. Paper accounts have virtual custody and are not reconciled.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {health.reconciliations.map((r, i) => (
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
        <h2>This deployment</h2>
        <p className="mono">contract set {digest.digest.slice(0, 16)}… · {digest.schemaCount} schemas · {digest.format}</p>
      </section>
    </>
  );
}
