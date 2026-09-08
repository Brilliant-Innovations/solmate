import { CandleChart, type ChartLevel, type ChartMarker } from '../../../../components/candle-chart';
import { ago, baseToUsd, tokens, usd } from '../../../../lib/paper';
import { dryRunState, loadPositionDetail, protectionHealth, reviewLabel } from '../../../../lib/positions';
import { price } from '../../../../lib/scanner';
import { getOperatorSession } from '../../../../lib/supabase/server';
import { requestManualClose, requestManualReduce } from '../../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Position detail (§20.9): lot allocation and protection rule when the same mint is held by several
 * strategies, the last emergency-exit dry-run with route and expected impact, thesis evolution from
 * entry to now, every HOLD / reassessment decision with its adversarial review, price chart with
 * action markers and stop/entry levels, strategy-lot attribution, protective-order lifecycle,
 * exit-compatibility diagnostics, and manual Reduce / Close (fast, D41).
 */
export default async function PositionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = Date.now();
  const [detail, operator] = await Promise.all([loadPositionDetail(id), getOperatorSession()]);
  if (!detail) {
    return (
      <>
        <h1 style={{ marginTop: 0 }}>Position</h1>
        <p className="muted">No position with that id is readable from this session.</p>
        <p><a className="btn" href="/positions">Back to Positions</a></p>
      </>
    );
  }
  const { position: p, cycles, fills, safetyHistory, candles } = detail;
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const agoS = (iso: string) => ago(iso, now);
  const review = reviewLabel(p, agoS);
  const prot = protectionHealth(p);
  const dr = dryRunState(p, now);
  const alarming = p.safety_state === 'EXIT_RECOMMENDED' || p.safety_state === 'CRITICAL_EXIT';
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const unreal = p.unrealized_pnl_base_units === null ? null : baseToUsd(p.unrealized_pnl_base_units);
  const markers: ChartMarker[] = [
    ...fills.map((f) => ({ time: Math.floor(Date.parse(f.filled_at) / 1000), position: (f.output_mint === p.mint ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar', color: f.output_mint === p.mint ? '#2e9e6b' : '#c94f4f', shape: (f.output_mint === p.mint ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown', text: f.output_mint === p.mint ? 'entry' : 'exit' })),
    ...cycles.filter((c) => c.terminal_at).map((c) => ({ time: Math.floor(Date.parse(c.terminal_at!) / 1000), position: 'aboveBar' as const, color: c.proposed_action === 'HOLD' ? '#4f7fc9' : c.proposed_action === 'EXIT' ? '#c94f4f' : '#d9a62e', shape: 'circle' as const, text: `${c.proposed_action ?? c.state}${c.verdict ? ` ${c.verdict[0]}` : ''}` })),
  ];
  const levels: ChartLevel[] = [];
  if (p.average_entry_price) levels.push({ price: p.average_entry_price, color: '#4f7fc9', title: 'entry' });
  if (p.unreviewed_stop !== null) levels.push({ price: p.unreviewed_stop, color: '#c94f4f', title: 'stop (deterministic)' });
  else if (p.stop?.level) levels.push({ price: p.stop.level, color: '#c94f4f', title: 'stop' });
  const proposals = cycles.filter((c) => c.proposal).map((c) => ({ at: c.started_at, action: c.proposed_action, thesis: c.proposal!.thesis, source: c.proposal!.source, verdict: c.verdict, objections: c.review?.objections ?? [], id: c.id, state: c.state }));
  const openLots = p.lots.filter((l) => l.status === 'OPEN');
  const totalOpen = openLots.reduce((acc, l) => acc + Number(l.quantity), 0);

  return (
    <>
      <h1 style={{ marginTop: 0 }}>
        {p.symbol} <span className="muted" style={{ fontWeight: 400 }}>position · {p.status}</span>
      </h1>
      {alarming && (
        <div className="notice" data-tone="failed" role="alert">
          Held-asset safety is <strong>{p.safety_state}</strong>{p.safety?.reasons.length ? ` (${p.safety.reasons.join(', ')})` : ''}. The position monitor executes the deterministic exit path; Close below requests it now.
        </div>
      )}
      <section className="panel">
        <p className="mono" style={{ margin: '0 0 0.4rem' }}>
          <span className="chip" data-tone={p.safety_state === 'NORMAL' ? 'ok' : p.safety_state === 'DEGRADED' ? 'degraded' : 'failed'}><span className="k">safety</span><span className="v">{p.safety_state}</span></span>{' '}
          <span className="chip" data-tone={review.tone}><span className="k">review</span><span className="v">{review.text}</span></span>{' '}
          <span className="chip" data-tone={prot.tone}><span className="k">protection</span><span className="v">{prot.text}</span></span>{' '}
          <span className="chip" data-tone={dr === 'OK' ? 'ok' : dr === 'STALE' ? 'degraded' : dr === 'FAILED' ? 'failed' : 'unknown'}><span className="k">dry-run</span><span className="v">{dr}{p.route_dry_run ? ` ${agoS(p.route_dry_run.at)}` : ''}</span></span>
        </p>
        <table className="mono" style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={cell} className="muted">quantity / cost</td><td style={cell}>{tokens(p.quantity, p.decimals)} · {usd(baseToUsd(p.cost_basis_base_units))}</td></tr>
            <tr><td style={cell} className="muted">entry / current</td><td style={cell}>{p.average_entry_price === null ? '—' : price(p.average_entry_price)} / {price(p.price_usd)} {p.snapshot_at ? <span className="muted">mark {agoS(p.snapshot_at)}</span> : <span className="muted">unmarked</span>}</td></tr>
            <tr><td style={cell} className="muted">P&amp;L realized / unrealized</td><td style={cell}>{usd(baseToUsd(p.realized_pnl_base_units))} / {unreal === null ? 'unmarked' : usd(unreal)}</td></tr>
            <tr><td style={cell} className="muted">opened / horizon</td><td style={cell}>{agoS(p.opened_at)} · expected {p.expected_horizon_minutes !== null ? `${p.expected_horizon_minutes} min` : 'not recorded on entry'}{p.closed_at ? ` · closed ${agoS(p.closed_at)}` : ''}</td></tr>
            <tr><td style={cell} className="muted">stop / target</td><td style={cell}>{p.unreviewed_stop !== null ? `${price(p.unreviewed_stop)} deterministic tighten-only (D39)` : p.stop?.level ? `${price(p.stop.level)} ${p.stop.model ?? ''}` : 'no stop'} · {p.target?.policy ? `${p.target.policy} ${p.target.parameters ? JSON.stringify(p.target.parameters) : ''}` : 'no target policy'}</td></tr>
            <tr><td style={cell} className="muted">next reassessment</td><td style={cell}>{p.next_reassessment_at ? (Date.parse(p.next_reassessment_at) < now ? `overdue (${agoS(p.next_reassessment_at)})` : `in ${Math.round((Date.parse(p.next_reassessment_at) - now) / 1000)}s`) : '—'}{p.last_reviewed_cycle_id ? <> · last reviewed cycle <a href={`/agent-activity/${p.last_reviewed_cycle_id}`}>{p.last_reviewed_cycle_id.slice(0, 8)}</a></> : null}</td></tr>
            <tr><td style={cell} className="muted">custody split</td><td style={cell}>{p.custody_split.length === 0 ? 'trading wallet' : p.custody_split.map((c) => `${p.custody.find((x) => x.id === c.custodyAccountId)?.kind ?? c.custodyAccountId.slice(0, 8)} ${tokens(c.quantity, p.decimals)}`).join(' · ')}</td></tr>
          </tbody>
        </table>
        {p.status !== 'CLOSED' && (
          <div className="controls" style={{ marginTop: '0.6rem' }}>
            <form action={requestManualClose}><input type="hidden" name="positionId" value={p.id} /><button className="btn danger" type="submit" disabled={!canControl}>Close</button></form>
            <form action={requestManualReduce}><input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="fraction" value="0.5" /><button className="btn" type="submit" disabled={!canControl}>Reduce ½</button></form>
            <form action={requestManualReduce}><input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="fraction" value="0.25" /><button className="btn" type="submit" disabled={!canControl}>Reduce ¼</button></form>
            <a className="btn" href={`/assets/${p.asset_id}`}>Asset Workspace</a>
            <a className="btn" href="/positions">All positions</a>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Price and P&amp;L with action markers</h2>
        <CandleChart series={candles} markers={markers} levels={levels} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Strategy lots and protection rule</h2>
          {p.lots.length === 0 ? (
            <p className="muted">No lot recorded.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['strategy', 'status', 'quantity', 'share', 'cost', 'realized', 'protection', 'provider order', 'reserved'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {p.lots.map((l) => (
                  <tr key={l.id}>
                    <td style={cell}>{l.strategy_version_id}</td>
                    <td style={cell}>{l.status}</td>
                    <td style={cell}>{tokens(l.quantity, p.decimals)}</td>
                    <td style={cell}>{l.status === 'OPEN' && totalOpen > 0 ? `${((Number(l.quantity) / totalOpen) * 100).toFixed(0)}%` : '—'}</td>
                    <td style={cell}>{usd(baseToUsd(l.cost_basis_base_units))}</td>
                    <td style={cell}>{usd(baseToUsd(l.realized_pnl_base_units))}</td>
                    <td style={cell}>{l.protection_mode}</td>
                    <td style={cell}>{l.provider_order_id ?? (l.protection_mode === 'JUPITER_TRIGGER' ? <span style={{ color: 'var(--failed)' }}>missing</span> : '—')}</td>
                    <td style={cell}>{tokens(l.reserved_for_protection, p.decimals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>
            {openLots.length > 1 ? 'Same mint held by several strategies: every fill is attributed per lot in proportion to the sold quantity, and a provider fill for one lot never reduces another (§32).' : 'Single lot: fills attribute to it directly.'} Protection is lot-scoped; MONITORED_EXIT means the position monitor and the executor's deterministic exit, JUPITER_TRIGGER a provider order in a vault.
          </p>
        </section>

        <section className="panel">
          <h2>Emergency exit and exit compatibility</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">route</td><td style={{ ...cell, whiteSpace: 'normal' }}>{p.route_hops ? (p.route_hops.map((h) => h.program ?? 'pool').join(' → ') || 'route') : 'no direct-pool route snapshot'}</td></tr>
              <tr><td style={cell} className="muted">last dry-run</td><td style={{ ...cell, whiteSpace: 'normal' }}>{p.route_dry_run ? `${p.route_dry_run.ok ? 'OK' : p.route_dry_run.error ?? 'failed'} · ${agoS(p.route_dry_run.at)}${p.route_dry_run.simulatedOutputAmount ? ` · simulated out ${p.route_dry_run.simulatedOutputAmount} base units` : ''}` : 'never'}</td></tr>
              <tr><td style={cell} className="muted">expected exit impact</td><td style={cell}>{p.exit_quote ? `${p.exit_quote.price_impact_bps ?? '—'} bp via ${p.exit_quote.router_label ?? 'Jupiter'} (${agoS(p.exit_quote.quoted_at)})` : p.price_impact_probes?.length ? p.price_impact_probes.map((x) => `${x.impactBps ?? '—'} bp @ $${x.sizeUsd}`).join(' · ') : 'no quote'}</td></tr>
              <tr><td style={cell} className="muted">exit compatibility</td><td style={{ ...cell, whiteSpace: 'normal' }}>{p.safety && Object.keys(p.safety.exit_compatibility).length ? Object.entries(p.safety.exit_compatibility).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : 'no safety evaluation yet'}</td></tr>
            </tbody>
          </table>
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Safety history</h3>
          {safetyHistory.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Not evaluated yet.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {safetyHistory.map((s, i) => (
                <li key={i}>
                  <span className="chip" data-tone={s.state === 'NORMAL' ? 'ok' : s.state === 'DEGRADED' ? 'degraded' : 'failed'}><span className="v">{s.state}</span></span> {agoS(s.evaluated_at)} · {s.policy_version} · triggers {s.triggers.join(', ')}{s.reasons.length ? ` · ${s.reasons.join(', ')}` : ''}{s.previous_state && s.previous_state !== s.state ? ` · from ${s.previous_state}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Thesis evolution and reviews</h2>
          {proposals.length === 0 ? (
            <p className="muted">No proposal recorded for this position (entry may have been deterministic).</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {proposals.map((pr) => (
                <li key={pr.id} style={{ marginBottom: '0.5rem' }}>
                  <div className="mono"><a href={`/agent-activity/${pr.id}`}>{agoS(pr.at)}</a> · {pr.action ?? '—'} · <span className="chip" data-tone={pr.source === 'AI' ? 'watch' : 'paper'}><span className="v">{pr.source === 'AI' ? 'AI' : 'DETERMINISTIC'}</span></span> · {pr.state}</div>
                  <div>{pr.thesis}</div>
                  <div className="muted mono">adversary {pr.verdict ?? '—'}{pr.objections.length ? `: ${pr.objections.map((o) => o.code).join(', ')}` : ''}</div>
                </li>
              ))}
            </ol>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>All cycles ({cycles.length})</h3>
          {cycles.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>None.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['started', 'action', 'verdict', 'state', 'reasons'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {cycles.map((c) => (
                  <tr key={c.id}>
                    <td style={cell}><a href={`/agent-activity/${c.id}`}>{agoS(c.started_at)}</a></td>
                    <td style={cell}>{c.proposed_action ?? '—'}</td>
                    <td style={cell}>{c.verdict ?? '—'}</td>
                    <td style={cell}>{c.state}</td>
                    <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{c.reason_codes.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Fills ({fills.length})</h2>
          {fills.length === 0 ? (
            <p className="muted">No fill linked to this position's lots.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['filled', 'side', 'in', 'out', 'shortfall', 'path', 'tx'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {fills.map((f) => (
                  <tr key={f.id}>
                    <td style={cell}>{agoS(f.filled_at)} <span className="muted">{f.commitment}</span></td>
                    <td style={cell}>{f.output_mint === p.mint ? 'ENTRY' : 'EXIT'}</td>
                    <td style={cell}>{f.input_mint === p.mint ? tokens(f.input_amount, p.decimals) : usd(baseToUsd(f.input_amount))}</td>
                    <td style={cell}>{f.output_mint === p.mint ? tokens(f.output_amount, p.decimals) : usd(baseToUsd(f.output_amount))}</td>
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
