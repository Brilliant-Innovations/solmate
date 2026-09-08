import { ago } from '../../../lib/paper';
import { eligibilityLabel, exitable, loadScanner, pct, price, usdc, whyNotTradeable, type ScannerFilters, type ScannerRow } from '../../../lib/scanner';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestResearchRefresh, requestWatchAsset } from '../ops-actions';

export const dynamic = 'force-dynamic';

type Search = { eligibility?: string; exitable?: string; strategy?: string; tier?: string; candidates?: string; cycle?: string; watched?: string; q?: string; sort?: string };

/**
 * Scanner (§20.4): the operator's live market triage surface. One row per asset with identity,
 * eligibility/safety state, emergency-exit route age and result, strategy candidate badges,
 * scanner score, price and 1m/5m/15m/1h returns, relative volume, liquidity, SOL-relative
 * strength, volatility, buy/sell flow, holder and concentration state, news count, cohort tags,
 * the active action-cycle state, candidate age/expiry, the self-influence marker and route/impact
 * health. "Why not tradeable" reasons are inline. Watch and research refresh file control requests;
 * nothing here can bypass hard eligibility or place a trade.
 */
export default async function Scanner({ searchParams }: { searchParams: Promise<Search> }) {
  const p = await searchParams;
  const now = Date.now();
  const operator = await getOperatorSession();
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const filters: ScannerFilters = {
    eligibility: (['eligible', 'blocked', 'evaluating'].includes(p.eligibility ?? '') ? p.eligibility : '') as ScannerFilters['eligibility'],
    exitable: p.exitable === '1' ? '1' : '',
    strategy: p.strategy || undefined,
    tier: p.tier || undefined,
    candidates: p.candidates === '1' ? '1' : '',
    cycle: p.cycle === '1' ? '1' : '',
    watched: p.watched === '1' ? '1' : '',
    q: p.q || undefined,
    sort: (['score', 'ret15', 'ret1h', 'liquidity', 'relvol', 'observed'].includes(p.sort ?? '') ? p.sort : 'score') as ScannerFilters['sort'],
  };
  const view = await loadScanner(filters, now);
  const strategyIds = [...new Set(view.strategies.map((s) => s.strategy_id))].sort();
  const tiers = [...new Set(view.strategies.map((s) => s.speed_tier))].sort();
  const cell = { padding: '0.25rem 0.6rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const back = `/scanner${Object.keys(p).length ? `?${new URLSearchParams(p as Record<string, string>).toString()}` : ''}`;
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Scanner</h1>
      <section className="panel">
        <form method="get" action="/scanner" className="controls" style={{ gap: '0.5rem' }}>
          <select name="eligibility" defaultValue={filters.eligibility} aria-label="eligibility">
            <option value="">any eligibility</option>
            <option value="eligible">ELIGIBLE</option>
            <option value="blocked">BLOCKED (hard reject)</option>
            <option value="evaluating">not evaluated yet</option>
          </select>
          <select name="strategy" defaultValue={filters.strategy ?? ''} aria-label="strategy"><option value="">any strategy</option>{strategyIds.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <select name="tier" defaultValue={filters.tier ?? ''} aria-label="speed tier"><option value="">any speed tier</option>{tiers.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select name="sort" defaultValue={filters.sort} aria-label="sort">
            <option value="score">sort: scanner score</option>
            <option value="ret15">sort: 15m return</option>
            <option value="ret1h">sort: 1h return</option>
            <option value="liquidity">sort: liquidity</option>
            <option value="relvol">sort: relative volume</option>
            <option value="observed">sort: newest</option>
          </select>
          <label className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" name="exitable" value="1" defaultChecked={filters.exitable === '1'} /> emergency-exitable</label>
          <label className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" name="candidates" value="1" defaultChecked={filters.candidates === '1'} /> has candidate</label>
          <label className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" name="cycle" value="1" defaultChecked={filters.cycle === '1'} /> cycle in flight</label>
          <label className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" name="watched" value="1" defaultChecked={filters.watched === '1'} /> watched</label>
          <input className="mono" name="q" defaultValue={filters.q ?? ''} placeholder="symbol, name or mint" aria-label="search" />
          <button className="btn" type="submit">Apply</button>
          <a className="btn" href="/scanner">Clear</a>
        </form>
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>{view.total} asset(s). Values come from the latest stored snapshot per asset; a missing value is shown as missing, never as zero. <a href="/watchlist">Watchlist</a></p>
      </section>

      <section className="panel">
        {view.rows.length === 0 ? (
          <p className="muted">No asset matches.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  {['token', 'eligibility', 'exit route', 'candidates', 'score', 'price', '1m', '5m', '15m', '1h', 'rel vol', 'liquidity', 'vs SOL', 'vol', 'flow 5m', 'holders', 'top10', 'news 24h', 'cohorts', 'cycle', 'impact', 'fresh', 'why not tradeable', ''].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <Row key={r.asset_id} r={r} now={now} cell={cell} canControl={canControl} back={back} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Row({ r, now, cell, canControl, back }: { r: ScannerRow; now: number; cell: Record<string, string>; canControl: boolean; back: string }) {
  const el = eligibilityLabel(r);
  const ex = exitable(r, now);
  const exTone = ex === 'EXITABLE' ? 'ok' : ex === 'STALE' ? 'degraded' : ex === 'FAILED' ? 'failed' : 'unknown';
  const best = r.open_candidates[0] ?? null;
  const buy5 = r.buy_volume_usd?.m5 ?? null;
  const sell5 = r.sell_volume_usd?.m5 ?? null;
  const flow = buy5 !== null && sell5 !== null && buy5 + sell5 > 0 ? buy5 / (buy5 + sell5) : null;
  const impact = r.price_impact_probes?.find((x) => x.sizeUsd >= 250) ?? r.price_impact_probes?.at(-1) ?? null;
  const reasons = whyNotTradeable(r, now);
  const snapshotAge = r.snapshot_at ? now - Date.parse(r.snapshot_at) : null;
  const stale = snapshotAge === null || snapshotAge > 5 * 60_000;
  return (
    <tr style={{ borderTop: '1px solid var(--rule)' }}>
      <td style={cell}>
        <a href={`/assets/${r.asset_id}`}><strong>{r.symbol}</strong></a>{r.watch_id ? <span title={r.watch_reason ?? 'watched'}> ★</span> : ''}{r.position_id ? <span className="muted"> · held</span> : ''}
        <div className="muted" title={r.mint}>{r.mint.slice(0, 4)}…{r.mint.slice(-4)}{r.self_influence_suppressed ? ' · own-fill suppressed' : ''}</div>
      </td>
      <td style={cell}><span className="chip" data-tone={el.tone}><span className="v">{el.text}</span></span>{r.grade !== null ? <div className="muted">grade {r.grade.toFixed(0)}</div> : null}</td>
      <td style={cell}><span className="chip" data-tone={exTone}><span className="v">{ex.replace('_', ' ')}</span></span>{r.route_dry_run ? <div className="muted">{ago(r.route_dry_run.at, now)}</div> : null}</td>
      <td style={cell}>
        {r.open_candidates.length === 0 ? <span className="muted">—</span> : r.open_candidates.map((c) => (
          <div key={c.id}>
            {c.strategyVersionIds.length ? c.strategyVersionIds.map((s) => s.split('@')[0]).join('/') : c.triggerFamily.toLowerCase()}:{c.scannerScore.toFixed(0)} <span className="muted">{c.status.toLowerCase()} · {ago(c.discoveredAt, now)} · exp {Math.max(0, Math.round((Date.parse(c.expiresAt) - now) / 60_000))}m</span>
          </div>
        ))}
      </td>
      <td style={cell}>{best ? best.scannerScore.toFixed(0) : '—'}</td>
      <td style={cell}>{price(r.price_usd)}</td>
      <td style={{ ...cell, color: (r.returns?.m1 ?? 0) < 0 ? 'var(--failed)' : undefined }}>{pct(r.returns?.m1)}</td>
      <td style={{ ...cell, color: (r.returns?.m5 ?? 0) < 0 ? 'var(--failed)' : undefined }}>{pct(r.returns?.m5)}</td>
      <td style={{ ...cell, color: (r.returns?.m15 ?? 0) < 0 ? 'var(--failed)' : undefined }}>{pct(r.returns?.m15)}</td>
      <td style={{ ...cell, color: (r.returns?.h1 ?? 0) < 0 ? 'var(--failed)' : undefined }}>{pct(r.returns?.h1)}</td>
      <td style={cell}>{r.relative_volume === null ? '—' : `${r.relative_volume.toFixed(2)}×`}</td>
      <td style={cell}>{usdc(r.liquidity_usd ?? r.eligibility_liquidity_usd)}</td>
      <td style={cell}>{pct(r.sol_relative_return)}{r.universe_relative_strength !== null ? <div className="muted">univ {r.universe_relative_strength.toFixed(2)}</div> : null}</td>
      <td style={cell}>{r.realized_volatility === null ? '—' : pct(r.realized_volatility, 1)}</td>
      <td style={cell}>{flow === null ? '—' : <span style={{ color: flow < 0.45 ? 'var(--failed)' : flow > 0.55 ? 'var(--ok)' : undefined }}>{(flow * 100).toFixed(0)}% buy</span>}</td>
      <td style={cell}>{r.holder_count ?? '—'}</td>
      <td style={cell}>{r.concentration?.top10 !== undefined ? pct(r.concentration.top10, 0).replace('+', '') : '—'}{r.concentration?.analyticsMismatch ? <div className="muted">mismatch</div> : null}</td>
      <td style={cell}>{r.event_count_24h ?? 0}</td>
      <td style={cell}>{r.cohorts.length ? r.cohorts.join(', ') : '—'}</td>
      <td style={cell}>{r.cycle_state ? <a href={`/agent-activity/${r.cycle_id}`}>{r.cycle_state}{r.cycle_action ? ` ${r.cycle_action}` : ''}</a> : '—'}</td>
      <td style={cell}>{impact ? (impact.routeFound ? (impact.impactBps === null ? 'route, no impact' : `${impact.impactBps} bp @ ${usdc(impact.sizeUsd)}`) : 'no route') : '—'}</td>
      <td style={cell}><span className="chip" data-tone={stale ? 'failed' : 'ok'}><span className="v">{snapshotAge === null ? 'NO DATA' : snapshotAge < 60_000 ? `${Math.round(snapshotAge / 1000)}s` : `${Math.round(snapshotAge / 60_000)}m`}</span></span></td>
      <td style={{ ...cell, whiteSpace: 'normal', minWidth: '12rem' }} className="muted">{reasons.length === 0 ? <span style={{ color: 'var(--ok)' }}>tradeable by policy</span> : reasons.join('; ')}</td>
      <td style={cell}>
        <div className="controls" style={{ gap: '0.3rem' }}>
          {!r.watch_id && (
            <form action={requestWatchAsset}>
              <input type="hidden" name="assetId" value={r.asset_id} />
              <input type="hidden" name="reason" value="scanner" />
              <input type="hidden" name="back" value={back} />
              <button className="btn" type="submit" disabled={!canControl} title="WATCH_ASSET: attention only">Watch</button>
            </form>
          )}
          <form action={requestResearchRefresh}>
            <input type="hidden" name="assetId" value={r.asset_id} />
            <input type="hidden" name="back" value={back} />
            <button className="btn" type="submit" disabled={!canControl} title="REQUEST_RESEARCH_REFRESH: re-run eligibility on the next cycle; cannot bypass hard eligibility">{r.research_refresh_requested_at && (!r.eligibility_at || r.research_refresh_requested_at > r.eligibility_at) ? 'Refresh queued' : 'Refresh'}</button>
          </form>
        </div>
      </td>
    </tr>
  );
}
