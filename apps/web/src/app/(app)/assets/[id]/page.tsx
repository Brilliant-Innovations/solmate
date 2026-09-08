import { CandleChart, type ChartLevel, type ChartMarker } from '../../../../components/candle-chart';
import { loadCycles } from '../../../../lib/cycles';
import { ago, baseToUsd, tokens, usd } from '../../../../lib/paper';
import { eligibilityLabel, exitable, loadAssetWorkspace, pct, price, usdc, whyNotTradeable } from '../../../../lib/scanner';
import { getOperatorSession } from '../../../../lib/supabase/server';
import { requestResearchRefresh, requestUnwatchAsset, requestWatchAsset } from '../../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Asset Workspace (§20.5): one token's investigation surface. Header with eligibility, candidate
 * badges, price and 15m move, liquidity, impact, safety and freshness, plus Watch / Open decision
 * / Manual close. Panels: Market (multi-timeframe chart with candidate and fill markers, stop
 * levels, EMA/VWAP/volume overlays, impact curve, relative strength, flow), On-chain / ownership
 * (concentration, authorities, security flags, Token-2022, insider metrics, owned addresses
 * excluded, tracked wallets), Intelligence (deduplicated timeline with source quality, first-seen
 * versus source time, novelty and repeated-narrative warning), Agent (cycles for this asset) and
 * History (candidates with realized 15m/1h/4h/24h outcome labels, positions, fills).
 */
export default async function AssetWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = Date.now();
  const [view, operator] = await Promise.all([loadAssetWorkspace(id), getOperatorSession()]);
  if (!view) {
    return (
      <>
        <h1 style={{ marginTop: 0 }}>Asset Workspace</h1>
        <p className="muted">No asset with that id is readable from this session.</p>
        <p><a className="btn" href="/scanner">Back to Scanner</a></p>
      </>
    );
  }
  const { row: r } = view;
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const cycles = await loadCycles({ token: r.mint, limit: 30 });
  const el = eligibilityLabel(r);
  const ex = exitable(r, now);
  const reasons = whyNotTradeable(r, now);
  const openPosition = view.positions.find((p) => p.status !== 'CLOSED') ?? null;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const snapshotAge = r.snapshot_at ? now - Date.parse(r.snapshot_at) : null;
  const impact250 = r.price_impact_probes?.find((x) => x.sizeUsd >= 250) ?? null;
  const back = `/assets/${r.asset_id}`;

  const markers: ChartMarker[] = [
    ...view.candidates.map((c) => ({ time: Math.floor(Date.parse(c.discovered_at) / 1000), position: 'belowBar' as const, color: '#d9a62e', shape: 'circle' as const, text: `cand ${c.scanner_score.toFixed(0)}` })),
    ...view.fills.map((f) => ({ time: Math.floor(Date.parse(f.filled_at) / 1000), position: (f.output_mint === r.mint ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar', color: f.output_mint === r.mint ? '#2e9e6b' : '#c94f4f', shape: (f.output_mint === r.mint ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown', text: f.output_mint === r.mint ? 'buy' : 'sell' })),
  ];
  const levels: ChartLevel[] = [];
  for (const p of view.positions) {
    if (p.status === 'CLOSED') continue;
    if (p.average_entry_price) levels.push({ price: p.average_entry_price, color: '#4f7fc9', title: 'entry' });
  }
  const openCycleStop = cycles.find((c) => c.position_id && c.state !== 'CLEARED');
  void openCycleStop;

  return (
    <>
      <h1 style={{ marginTop: 0 }}>
        {r.symbol} <span className="muted" style={{ fontWeight: 400 }}>{r.name}</span>
      </h1>
      <section className="panel">
        <p className="mono" style={{ margin: '0 0 0.4rem' }}>
          <span className="chip" data-tone={el.tone}><span className="v">{el.text}</span></span>{' '}
          {r.open_candidates.map((c) => <span key={c.id} className="chip" data-tone="watch"><span className="k">candidate</span><span className="v">{c.strategyVersionIds.map((s) => s.split('@')[0]).join('/') || c.triggerFamily}:{c.scannerScore.toFixed(0)}</span></span>)}{' '}
          <strong>{price(r.price_usd)}</strong> <span style={{ color: (r.returns?.m15 ?? 0) < 0 ? 'var(--failed)' : 'var(--ok)' }}>{pct(r.returns?.m15)} 15m</span>
        </p>
        <p className="mono" style={{ margin: '0 0 0.4rem' }}>
          Liquidity {usdc(r.liquidity_usd ?? r.eligibility_liquidity_usd)} · Impact @ $250 {impact250 ? (impact250.routeFound ? (impact250.impactBps === null ? 'route' : `${impact250.impactBps} bp`) : 'no route') : '—'} · Safety {openPosition ? openPosition.safety_state : r.hard_reject ? 'BLOCKED' : r.security_flags?.length ? r.security_flags.join(',') : 'NORMAL'} ·{' '}
          Fresh <span className="chip" data-tone={snapshotAge === null ? 'unknown' : snapshotAge > 5 * 60_000 ? 'failed' : 'ok'}><span className="v">{snapshotAge === null ? 'NO DATA' : snapshotAge < 60_000 ? `${(snapshotAge / 1000).toFixed(1)}s` : `${Math.round(snapshotAge / 60_000)}m`}</span></span> ·{' '}
          Exit route <span className="chip" data-tone={ex === 'EXITABLE' ? 'ok' : ex === 'STALE' ? 'degraded' : ex === 'FAILED' ? 'failed' : 'unknown'}><span className="v">{ex.replace('_', ' ')}</span></span>
          {r.self_influence_suppressed ? <> · <span className="chip" data-tone="degraded"><span className="v">OWN-FILL SUPPRESSED</span></span></> : null}
        </p>
        <p className="muted mono" style={{ margin: '0 0 0.5rem' }} title={r.mint}>mint {r.mint} · decimals {r.decimals} · first observed {ago(r.first_observed_at, now)} · cohorts {r.cohorts.length ? r.cohorts.join(', ') : 'none'} · regime {r.regime ?? 'unclassified'}</p>
        {reasons.length > 0 && <p className="muted" style={{ margin: '0 0 0.5rem' }}>Not tradeable now: {reasons.join('; ')}.</p>}
        <div className="controls" style={{ gap: '0.4rem' }}>
          {r.watch_id ? (
            <form action={requestUnwatchAsset}><input type="hidden" name="watchId" value={r.watch_id} /><input type="hidden" name="back" value={back} /><button className="btn" type="submit" disabled={!canControl}>Unwatch</button></form>
          ) : (
            <form action={requestWatchAsset}><input type="hidden" name="assetId" value={r.asset_id} /><input type="hidden" name="reason" value="asset workspace" /><input type="hidden" name="back" value={back} /><button className="btn" type="submit" disabled={!canControl}>Watch</button></form>
          )}
          {r.cycle_id ? <a className="btn" href={`/agent-activity/${r.cycle_id}`}>Open decision</a> : <a className="btn" href={`/agent-activity?token=${encodeURIComponent(r.mint)}`}>Decisions</a>}
          {openPosition ? <a className="btn danger" href="/positions">Manual close (Positions)</a> : null}
          <form action={requestResearchRefresh}><input type="hidden" name="assetId" value={r.asset_id} /><input type="hidden" name="back" value={back} /><button className="btn" type="submit" disabled={!canControl}>Request research refresh</button></form>
          <a className="btn" href="/scanner">Scanner</a>
        </div>
      </section>

      <section className="panel">
        <h2>Market</h2>
        <CandleChart series={view.candles} markers={markers} levels={levels} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem', marginTop: '0.8rem' }}>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">returns</td><td style={cell}>1m {pct(r.returns?.m1)} · 5m {pct(r.returns?.m5)} · 15m {pct(r.returns?.m15)} · 1h {pct(r.returns?.h1)} · 4h {pct(r.returns?.h4)}</td></tr>
              <tr><td style={cell} className="muted">vs SOL / universe</td><td style={cell}>{pct(r.sol_relative_return)} · {r.universe_relative_strength === null ? '—' : r.universe_relative_strength.toFixed(2)}</td></tr>
              <tr><td style={cell} className="muted">relative volume</td><td style={cell}>{r.relative_volume === null ? '—' : `${r.relative_volume.toFixed(2)}×`} · vol 1h {usdc(r.volume_usd?.h1)} · 24h {usdc(r.volume_usd?.h24)}</td></tr>
              <tr><td style={cell} className="muted">volatility / ATR</td><td style={cell}>{r.realized_volatility === null ? '—' : pct(r.realized_volatility)} · {r.atr === null ? '—' : r.atr.toPrecision(3)}</td></tr>
              <tr><td style={cell} className="muted">flow 5m / 1h</td><td style={cell}>{flowText(r.buy_volume_usd?.m5, r.sell_volume_usd?.m5)} · {flowText(r.buy_volume_usd?.h1, r.sell_volume_usd?.h1)} · trades 5m {r.buy_count?.m5 ?? '—'}/{r.sell_count?.m5 ?? '—'}</td></tr>
              <tr><td style={cell} className="muted">market cap</td><td style={cell}>{usdc(r.market_cap_usd)}</td></tr>
              <tr><td style={cell} className="muted">snapshot</td><td style={cell}>{r.snapshot_at ? ago(r.snapshot_at, now) : 'none'} · features {r.features_at ? ago(r.features_at, now) : 'none'}</td></tr>
            </tbody>
          </table>
          <div>
            <h3 style={{ margin: '0 0 0.3rem' }}>Liquidity and impact curve</h3>
            {(r.price_impact_probes?.length ?? 0) === 0 && (r.route_probes?.length ?? 0) === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No impact probe recorded.</p>
            ) : (
              <table className="mono" style={{ borderCollapse: 'collapse' }}>
                <thead><tr>{['size', 'impact', 'route', 'probed'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
                <tbody>
                  {(r.price_impact_probes ?? []).map((p, i) => (
                    <tr key={`e${i}`}><td style={cell}>{usdc(p.sizeUsd)}</td><td style={cell}>{p.impactBps === null ? '—' : `${p.impactBps} bp`}</td><td style={cell}>{p.routeFound ? 'yes' : 'NO'}</td><td style={cell} className="muted">{ago(p.probedAt, now)}</td></tr>
                  ))}
                  {(r.route_probes ?? []).map((p, i) => (
                    <tr key={`s${i}`}><td style={cell}>{usdc(p.sizeUsd)}</td><td style={cell}>{p.impactBps === null ? '—' : `${p.impactBps} bp`}</td><td style={cell} className="muted">snapshot</td><td style={cell} className="muted">{r.snapshot_at ? ago(r.snapshot_at, now) : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Emergency exit route</h3>
            {r.route_id ? (
              <p className="mono muted" style={{ margin: 0 }}>
                {(r.route_hops ?? []).map((h) => h.program ?? 'pool').join(' → ') || 'route'} · refreshed {ago(r.route_refreshed_at, now)} · dry-run {r.route_dry_run ? `${r.route_dry_run.ok ? 'OK' : r.route_dry_run.error ?? 'failed'} ${ago(r.route_dry_run.at, now)}` : 'never'}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No direct-pool route snapshot; LIVE_AUTO entry is impossible for this asset (§14.6).</p>
            )}
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>On-chain / ownership</h2>
          {r.eligibility_at === null ? (
            <p className="muted">Not evaluated yet.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={cell} className="muted">evaluated</td><td style={cell}>{ago(r.eligibility_at, now)} · grade {r.grade?.toFixed(0) ?? '—'}</td></tr>
                <tr><td style={cell} className="muted">holders</td><td style={cell}>{r.holder_count ?? '—'}</td></tr>
                <tr><td style={cell} className="muted">concentration</td><td style={cell}>{r.concentration ? `top1 ${pct(r.concentration.top1, 1).replace('+', '')} · top5 ${pct(r.concentration.top5, 1).replace('+', '')} · top10 ${pct(r.concentration.top10, 1).replace('+', '')} · top20 ${pct(r.concentration.top20, 1).replace('+', '')}${r.concentration.analyticsMismatch ? ' · ANALYTICS MISMATCH' : ''} (${r.concentration.source ?? 'source ?'})` : 'no concentration data'}</td></tr>
                <tr><td style={cell} className="muted">authorities</td><td style={cell}>mint {r.mint_authority} · freeze {r.freeze_authority}</td></tr>
                <tr><td style={cell} className="muted">security flags</td><td style={{ ...cell, whiteSpace: 'normal' }}>{r.security_flags?.length ? r.security_flags.join(', ') : 'none'}</td></tr>
                <tr><td style={cell} className="muted">transfer restrictions</td><td style={{ ...cell, whiteSpace: 'normal' }}>{r.transfer_restrictions?.length ? r.transfer_restrictions.join(', ') : 'none'}</td></tr>
                <tr><td style={cell} className="muted">routes</td><td style={cell}>Jupiter {r.jupiter_route_available ? 'yes' : 'NO'} · settlement {r.settlement_route_confirmed ? 'confirmed' : 'UNCONFIRMED'}</td></tr>
                <tr><td style={cell} className="muted">insider metrics</td><td style={{ ...cell, whiteSpace: 'normal' }}>{r.insider_metrics && Object.keys(r.insider_metrics).length ? JSON.stringify(r.insider_metrics) : 'not available from the configured providers'}</td></tr>
                <tr><td style={cell} className="muted">own addresses</td><td style={cell}>{view.ownedAddresses} registered address(es) excluded from flow, momentum and smart-money evidence (D26)</td></tr>
                <tr><td style={cell} className="muted">rejections</td><td style={{ ...cell, whiteSpace: 'normal' }}>{r.rejection_reasons?.length ? r.rejection_reasons.join(', ') : 'none'}</td></tr>
              </tbody>
            </table>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Tracked wallets</h3>
          {view.trackedWallets.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No tracked wallet recorded; per-asset wallet flows arrive with the smart-money adapter.</p>
          ) : (
            <p className="mono muted" style={{ margin: 0 }}>{view.trackedWallets.slice(0, 8).map((w) => `${w.address.slice(0, 4)}…${w.address.slice(-4)}${w.is_owned ? ' (own, excluded)' : ''}${w.labels.length ? ` ${w.labels.map((l) => l.label ?? l.kind ?? '').filter(Boolean).join('/')}` : ''}`).join(' · ')}</p>
          )}
        </section>

        <section className="panel">
          <h2>Intelligence</h2>
          {view.events.length === 0 ? (
            <p className="muted">No news, social or catalyst event linked to this asset{r.event_count_24h ? '' : ' (intel-ingest is disabled without provider keys)'}.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {view.events.map((e) => {
                const repeated = e.corroborates_event_id !== null || (e.novelty_score !== null && e.novelty_score < 0.3);
                return (
                  <li key={e.id} style={{ marginBottom: '0.3rem' }}>
                    <span className="chip" data-tone={repeated ? 'degraded' : 'ok'}><span className="v">{e.kind}</span></span> {e.title ?? e.classification ?? 'untitled'}
                    <div className="muted">
                      {e.source_provider} · {e.source_quality} · first seen {ago(e.first_seen_at, now)}{e.source_published_at ? ` · source time ${ago(e.source_published_at, now)}` : ' · source time unknown'} · novelty {e.novelty_score === null ? '—' : e.novelty_score.toFixed(2)}
                      {repeated ? ' · REPEATED NARRATIVE: corroborates an earlier event; does not add confidence' : ''}
                    </div>
                    {e.summary ? <div className="muted">{e.summary.slice(0, 240)}{e.summary.length > 240 ? '…' : ''}</div> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Agent</h2>
          {cycles.length === 0 ? (
            <p className="muted">No action cycle for this asset.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['started', 'strategy', 'action', 'verdict', 'state', 'cutoff'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {cycles.map((c) => (
                  <tr key={c.id}>
                    <td style={cell}><a href={`/agent-activity/${c.id}`}>{ago(c.started_at, now)}</a></td>
                    <td style={cell}>{c.strategy_version_id}{c.skill_version_id ? <div className="muted">skill {c.skill_version_id}</div> : null}</td>
                    <td style={cell}>{c.proposed_action ?? '—'}{c.proposal?.thesis ? <div className="muted" style={{ maxWidth: '18rem', whiteSpace: 'normal' }}>{c.proposal.thesis.slice(0, 100)}</div> : null}</td>
                    <td style={cell}>{c.verdict ?? '—'}{c.review?.objections.length ? <div className="muted">{c.review.objections.map((o) => o.code).join(', ')}</div> : null}</td>
                    <td style={cell}>{c.state}{c.revision_round > 0 ? ` (rev ${c.revision_round})` : ''}</td>
                    <td style={cell}>v{c.cutoffs.at(-1)?.version ?? '?'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Next: {openPosition ? 'reassessment on the position monitor cadence' : r.open_candidates.length ? 'candidate under strategy evaluation' : 'no scheduled automation for this asset'}.</p>
        </section>

        <section className="panel">
          <h2>History</h2>
          <h3 style={{ margin: '0 0 0.3rem' }}>Candidates ({view.candidates.length})</h3>
          {view.candidates.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Never a candidate.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['discovered', 'trigger', 'score', 'status', 'strategies', '+15m', '+1h', '+4h', '+24h'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {view.candidates.map((c) => {
                  const o = view.outcomes.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td style={cell}>{ago(c.discovered_at, now)}</td>
                      <td style={cell}>{c.trigger_family}</td>
                      <td style={cell}>{c.scanner_score.toFixed(0)}</td>
                      <td style={cell}>{c.status}{c.deterministic_rejection_reason ? <div className="muted">{c.deterministic_rejection_reason}</div> : null}</td>
                      <td style={cell}>{c.strategy_version_ids.map((s) => s.split('@')[0]).join('/') || '—'}</td>
                      <td style={cell}>{pct(o?.m15)}</td><td style={cell}>{pct(o?.h1)}</td><td style={cell}>{pct(o?.h4)}</td><td style={cell}>{pct(o?.h24)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Positions ({view.positions.length})</h3>
          {view.positions.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Never held.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['opened', 'status', 'quantity', 'avg entry', 'realized', 'unrealized', 'review', 'closed'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {view.positions.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>{ago(p.opened_at, now)}</td>
                    <td style={cell}>{p.status}</td>
                    <td style={cell}>{tokens(p.quantity, r.decimals)}</td>
                    <td style={cell}>{p.average_entry_price === null ? '—' : price(p.average_entry_price)}</td>
                    <td style={cell}>{usd(baseToUsd(p.realized_pnl_base_units))}</td>
                    <td style={cell}>{p.unrealized_pnl_base_units === null ? 'unmarked' : usd(baseToUsd(p.unrealized_pnl_base_units))}</td>
                    <td style={cell}>{p.review_state}</td>
                    <td style={cell}>{p.closed_at ? ago(p.closed_at, now) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Fills ({view.fills.length})</h3>
          {view.fills.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No fill.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['filled', 'side', 'in', 'out', 'shortfall', 'path', 'tx'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {view.fills.map((f) => (
                  <tr key={f.id}>
                    <td style={cell}>{ago(f.filled_at, now)} <span className="muted">{f.commitment}</span></td>
                    <td style={cell}>{f.output_mint === r.mint ? 'BUY' : 'SELL'}</td>
                    <td style={cell}>{f.input_mint === r.mint ? tokens(f.input_amount, r.decimals) : usd(baseToUsd(f.input_amount))}</td>
                    <td style={cell}>{f.output_mint === r.mint ? tokens(f.output_amount, r.decimals) : usd(baseToUsd(f.output_amount))}</td>
                    <td style={cell}>{f.execution_shortfall_bps === null ? '—' : `${f.execution_shortfall_bps.toFixed(1)} bp`}</td>
                    <td style={cell}>{f.execution_path}</td>
                    <td style={cell} className="muted" title={f.tx_signature}>{f.tx_signature.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

function flowText(buy: number | null | undefined, sell: number | null | undefined): string {
  if (buy === null || buy === undefined || sell === null || sell === undefined) return '—';
  const total = buy + sell;
  return total > 0 ? `${((buy / total) * 100).toFixed(0)}% buy (${usdc(total)})` : 'no volume';
}
