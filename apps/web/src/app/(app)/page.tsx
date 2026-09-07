import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { ago, baseToUsd, loadEquity, loadOpenAlerts, loadPaperAccount, loadPositions, loadRecentCycleCounts, loadSessionView, usd } from '../../lib/paper';
import { createSupabaseServerClient, getOperatorSession } from '../../lib/supabase/server';
import { requestStartSession } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Control Room (§20.2): session widget, positions summary, open alerts, pending control requests.
 * Everything shown is a read of ledger state; what does not exist is labelled absent, never zero
 * (§20.21). PAPER and LIVE are never collapsed: the account mode and capital authority are named.
 */
export default async function ControlRoom() {
  const digest = await getContractSetDigest();
  const supabase = await createSupabaseServerClient();
  const operator = await getOperatorSession();
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const account = await loadPaperAccount();
  const [session, equity, positions, alerts, cycles] = account
    ? await Promise.all([loadSessionView(account.id), loadEquity(account.id), loadPositions(account.id, { includeClosed: false, limit: 20 }), loadOpenAlerts(10), loadRecentCycleCounts()])
    : [null, { latest: null, dayStart: null }, [], await loadOpenAlerts(10), await loadRecentCycleCounts()];
  const pending = supabase ? (await supabase.schema('ops').from('control_requests').select('kind, state, created_at').eq('state', 'PENDING').order('created_at', { ascending: false }).limit(10)).data ?? [] : [];
  const gatesFailed = session?.cold_start_gates.filter((g) => !g.passed) ?? [];
  const latestEquity = baseToUsd(equity.latest?.equity_base_units);
  const dayStartEquity = baseToUsd(equity.dayStart?.equity_base_units);
  const dayPnl = latestEquity !== null && dayStartEquity !== null && dayStartEquity > 0 ? latestEquity - dayStartEquity : null;
  const unrealized = positions.reduce<number | null>((acc, p) => (p.unrealized_pnl_base_units === null ? acc : (acc ?? 0) + Number(p.unrealized_pnl_base_units) / 1e6), null);

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Control Room</h1>
      <section className="panel">
        <h2>Trading session</h2>
        {!account ? (
          <p className="muted">No paper account exists yet: the worker creates one when the paper-entry role starts.</p>
        ) : !session ? (
          <>
            <p className="muted">
              Paper account <span className="mono">{account.name}</span> has no runtime session. Start one to enter STARTING; cold-start gates must pass before WATCH (D63).
            </p>
            <form action={requestStartSession}>
              <button className="btn" type="submit" disabled={!canControl} title="Requests START_SESSION; the worker validates and starts the PAPER session">
                START SESSION
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="mono">
              <span className="chip" data-tone={session.activity_state.toLowerCase().replace('_', '-')}><span className="k">activity</span><span className="v">{session.activity_state}</span></span>{' '}
              <span className="chip" data-tone={session.capital_authority === 'PAPER' ? 'paper' : 'observe'}><span className="k">authority</span><span className="v">{session.capital_authority}</span></span>{' '}
              {session.paused?.active && <span className="chip" data-tone="paused"><span className="k">override</span><span className="v">PAUSED · {session.paused.reason ?? 'no reason'} · by {session.paused.by ?? '?'}</span></span>}{' '}
              <span className="chip" data-tone={session.attended ? (session.last_presence_heartbeat_at && Date.now() - Date.parse(session.last_presence_heartbeat_at) < 180_000 ? 'ok' : 'failed') : 'unknown'}>
                <span className="k">presence</span><span className="v">{session.attended ? `attended · heartbeat ${ago(session.last_presence_heartbeat_at)}` : 'unattended profile'}</span>
              </span>
            </p>
            <p className="muted">
              Profile {session.profile} · account <span className="mono">{account.name}</span> ({account.cluster}) · started {ago(session.actual_start_at)} · session <span className="mono">{session.id.slice(0, 8)}</span>
            </p>
            {session.activity_state === 'STARTING' && (
              <>
                <h3>Cold-start gates (D63)</h3>
                <table className="mono" style={{ borderCollapse: 'collapse' }}>
                  <tbody>
                    {session.cold_start_gates.map((g) => (
                      <tr key={g.name}>
                        <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{g.passed ? '✓' : '✗'}</td>
                        <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{g.name}</td>
                        <td style={{ padding: '0.2rem 0' }} className="muted">{g.detail ?? ''}</td>
                      </tr>
                    ))}
                    {session.cold_start_gates.length === 0 && (
                      <tr><td className="muted">No gate evaluated yet.</td></tr>
                    )}
                  </tbody>
                </table>
                {gatesFailed.length > 0 && <p className="muted">Entries stay blocked until every gate passes; the worker re-evaluates each tick.</p>}
              </>
            )}
            {session.activity_state === 'WIND_DOWN' && (
              <p className="muted">Winding down: {session.wind_down_blockers.length ? session.wind_down_blockers.join('; ') : 'closing lots and draining in-flight execution'}. OFF follows only at zero unmanaged exposure (D61).</p>
            )}
            {session.transitions.length > 0 && (
              <p className="muted mono" style={{ fontSize: '0.8rem' }}>
                {session.transitions.slice(-5).map((t, i) => (
                  <span key={i}>
                    {t.from}→{t.to} by {t.actor} {ago(t.at)}{i < Math.min(5, session.transitions.length) - 1 ? ' · ' : ''}
                  </span>
                ))}
              </p>
            )}
            {session.activity_state === 'OFF' && (
              <form action={requestStartSession}>
                <button className="btn" type="submit" disabled={!canControl}>
                  START SESSION
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Paper book</h2>
        {!equity.latest ? (
          <p className="muted">No portfolio snapshot yet.</p>
        ) : (
          <p className="mono">
            equity {usd(latestEquity)} · exposure {(equity.latest.exposure_fraction * 100).toFixed(1)}% ({usd(baseToUsd(equity.latest.exposure_base_units))}) · day P&amp;L {dayPnl === null ? '—' : usd(dayPnl)} · unrealized {unrealized === null ? '—' : usd(unrealized)} · drawdown day {((equity.latest.drawdown?.dailyFraction ?? 0) * 100).toFixed(2)}% / rolling {((equity.latest.drawdown?.rollingFraction ?? 0) * 100).toFixed(2)}% · as of {ago(equity.latest.as_of)}
          </p>
        )}
        <p className="muted">
          Open positions: {positions.length}.{' '}
          {positions.length > 0 && (
            <span className="mono">
              {positions.map((p) => `${p.symbol} (${p.strategies.join('/') || 'no lot'}, ${p.safety_state}${p.unrealized_pnl_base_units === null ? '' : `, ${usd(Number(p.unrealized_pnl_base_units) / 1e6)}`})`).join(' · ')}
            </span>
          )}{' '}
          <a href="/positions">Positions table</a>
        </p>
        <p className="muted">
          Action cycles in the last 24 h: {cycles.total} ({cycles.cleared} cleared, {cycles.rejected} rejected){Object.keys(cycles.byStrategy).length ? ' · ' : ''}
          <span className="mono">{Object.entries(cycles.byStrategy).map(([k, v]) => `${k}: ${v.cleared}/${v.rejected}`).join(' · ')}</span>
        </p>
      </section>

      <section className="panel">
        <h2>Open alerts</h2>
        {alerts.length === 0 ? (
          <p className="muted">None open.</p>
        ) : (
          <ul className="mono">
            {alerts.map((a) => (
              <li key={a.id}>
                <span className="chip" data-tone={a.severity === 'CRITICAL' ? 'failed' : a.severity === 'HIGH' ? 'degraded' : 'unknown'}><span className="v">{a.severity}</span></span> {a.alert_class} · {a.summary} · {ago(a.raised_at)}
                {a.automated_response ? ` · auto: ${a.automated_response}` : ''}{a.acknowledged_at ? ' · acknowledged' : ' · unacknowledged'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Pending control requests</h2>
        {pending.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {pending.map((r, i) => (
              <li key={i}>
                {r.kind} · {r.state} · {ago(r.created_at)}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">Requests are acted on by the worker's session role after role, step-up and state checks; the browser never executes a control itself.</p>
      </section>

      <section className="panel">
        <h2>This deployment</h2>
        <p className="mono">
          contract set {digest.digest.slice(0, 16)}… · {digest.schemaCount} schemas · {digest.format}
        </p>
      </section>
    </>
  );
}
