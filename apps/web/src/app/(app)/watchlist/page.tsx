import { ago } from '../../../lib/paper';
import { eligibilityLabel, exitable, loadWatchlist, pct, price } from '../../../lib/scanner';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestResearchRefresh, requestUnwatchAsset, requestWatchAsset } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Watchlist (§20.27): manually watched mints with reason/note, who added them, alert rules,
 * eligibility state, the last emergency-route snapshot, whether any strategy has ever produced a
 * candidate, and `Request research refresh`. Membership improves attention only; it never grants
 * eligibility or execution permission, and the worker's watchlist role validates every request.
 */
export default async function Watchlist() {
  const now = Date.now();
  const [watches, operator] = await Promise.all([loadWatchlist(), getOperatorSession()]);
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const cell = { padding: '0.3rem 0.8rem 0.3rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Watchlist</h1>
      <section className="panel">
        <h2>Watch a mint</h2>
        <form action={requestWatchAsset} className="controls" style={{ gap: '0.5rem' }}>
          <input className="mono" name="mint" placeholder="mint address (must already be a discovered asset)" aria-label="mint" style={{ minWidth: '26rem' }} required disabled={!canControl} />
          <input className="mono" name="reason" placeholder="reason (required)" aria-label="reason" maxLength={128} required disabled={!canControl} />
          <input className="mono" name="note" placeholder="note" aria-label="note" maxLength={1024} disabled={!canControl} />
          <input type="hidden" name="back" value="/watchlist" />
          <button className="btn" type="submit" disabled={!canControl}>Watch</button>
        </form>
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>Watching changes attention, never eligibility or execution permission. Assets the scanner has not discovered cannot be watched yet; discovery is the ingest role's job.</p>
      </section>

      <section className="panel">
        <h2>Watched ({watches.length})</h2>
        {watches.length === 0 ? (
          <p className="muted">Nothing watched.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['token', 'reason / note', 'added', 'alert rules', 'eligibility', 'exit route', 'price', '15m', '1h', 'candidates ever', 'open candidates', 'cycle', ''].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr>
              </thead>
              <tbody>
                {watches.map((w) => {
                  const r = w.row;
                  const el = r ? eligibilityLabel(r) : null;
                  const ex = r ? exitable(r, now) : null;
                  return (
                    <tr key={w.id} style={{ borderTop: '1px solid var(--rule)' }}>
                      <td style={cell}>{r ? <a href={`/assets/${r.asset_id}`}><strong>{r.symbol}</strong></a> : <span className="muted">unknown asset</span>}{r ? <div className="muted" title={r.mint}>{r.mint.slice(0, 4)}…{r.mint.slice(-4)}</div> : null}</td>
                      <td style={{ ...cell, whiteSpace: 'normal', minWidth: '14rem' }}>{w.reason}{w.note ? <div className="muted">{w.note}</div> : null}</td>
                      <td style={cell}>{ago(w.added_at, now)}<div className="muted">by {w.added_by.slice(0, 8)}</div></td>
                      <td style={cell} className="muted">{Object.keys(w.alert_rules).length ? JSON.stringify(w.alert_rules) : 'none'}</td>
                      <td style={cell}>{el ? <span className="chip" data-tone={el.tone}><span className="v">{el.text}</span></span> : '—'}</td>
                      <td style={cell}>{ex ? <><span className="chip" data-tone={ex === 'EXITABLE' ? 'ok' : ex === 'STALE' ? 'degraded' : ex === 'FAILED' ? 'failed' : 'unknown'}><span className="v">{ex.replace('_', ' ')}</span></span>{r?.route_dry_run ? <div className="muted">{ago(r.route_dry_run.at, now)}</div> : null}</> : '—'}</td>
                      <td style={cell}>{price(r?.price_usd)}</td>
                      <td style={cell}>{pct(r?.returns?.m15)}</td>
                      <td style={cell}>{pct(r?.returns?.h1)}</td>
                      <td style={cell}>{w.candidatesEver}</td>
                      <td style={cell}>{r && r.open_candidates.length ? r.open_candidates.map((c) => `${c.strategyVersionIds.map((s) => s.split('@')[0]).join('/') || c.triggerFamily}:${c.scannerScore.toFixed(0)}`).join(' ') : '—'}</td>
                      <td style={cell}>{r?.cycle_state ? <a href={`/agent-activity/${r.cycle_id}`}>{r.cycle_state}</a> : '—'}</td>
                      <td style={cell}>
                        <div className="controls" style={{ gap: '0.3rem' }}>
                          {r && (
                            <form action={requestResearchRefresh}>
                              <input type="hidden" name="assetId" value={r.asset_id} />
                              <input type="hidden" name="back" value="/watchlist" />
                              <button className="btn" type="submit" disabled={!canControl}>Request research refresh</button>
                            </form>
                          )}
                          <form action={requestUnwatchAsset}>
                            <input type="hidden" name="watchId" value={w.id} />
                            <input type="hidden" name="back" value="/watchlist" />
                            <button className="btn" type="submit" disabled={!canControl}>Unwatch</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
