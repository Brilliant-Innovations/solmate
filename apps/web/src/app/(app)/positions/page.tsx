import { ago, baseToUsd, loadPaperAccount, tokens, usd } from '../../../lib/paper';
import { loadControlRequests } from '../../../lib/ops';
import { dryRunState, loadPositionsWorkspace, protectionHealth, reviewLabel, type PositionRow } from '../../../lib/positions';
import { price } from '../../../lib/scanner';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestEmergencyCloseAll, requestManualClose, requestManualReduce } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Positions Workspace (§20.9): token, strategy lots, quantity, entry/current price, realized and
 * unrealized P&L, age versus expected horizon, stop/target/trailing state, custody split, asset
 * safety, protection health, last autonomous reassessment and action, next reassessment due,
 * current exit route/impact, review state and the emergency-exit dry-run. Safety states
 * EXIT_RECOMMENDED / CRITICAL_EXIT are elevated above ordinary P&L styling. Close and reduce are
 * risk-reducing controls: fast, no step-up, one control request each (D41); the worker's
 * manual-actions role validates the operator role and the open position before it acts.
 */
export default async function Positions() {
  const now = Date.now();
  const [account, operator, pending] = await Promise.all([loadPaperAccount(), getOperatorSession(), loadControlRequests(['MANUAL_CLOSE', 'MANUAL_REDUCE', 'EMERGENCY_CLOSE_ALL'], 10)]);
  const rows = account ? await loadPositionsWorkspace(account.id, { includeClosed: true, limit: 100 }) : [];
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const inFlight = pending.filter((r) => r.state === 'PENDING');
  const open = rows.filter((p) => p.status !== 'CLOSED');
  const closed = rows.filter((p) => p.status === 'CLOSED');
  const alarming = open.filter((p) => p.safety_state === 'EXIT_RECOMMENDED' || p.safety_state === 'CRITICAL_EXIT');
  const cell = { padding: '0.25rem 0.7rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const agoS = (iso: string) => ago(iso, now);
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Positions</h1>
      {!account && <p className="muted">No paper account exists yet.</p>}
      {alarming.length > 0 && (
        <div className="notice" data-tone="failed" role="alert">
          <strong>Held-asset safety:</strong> {alarming.map((p) => `${p.symbol} ${p.safety_state}${p.safety?.reasons.length ? ` (${p.safety.reasons.join(', ')})` : ''}`).join('; ')}. The position monitor executes the deterministic exit; Close below requests the same path now.
        </div>
      )}
      {inFlight.length > 0 && (
        <div className="notice" role="status">
          {inFlight.length} manual action request(s) pending: {inFlight.map((r) => r.kind).join(', ')}. The worker resolves each within its manual-actions interval.
        </div>
      )}
      <section className="panel">
        <h2>Open ({open.length})</h2>
        {open.length > 0 && (
          <form action={requestEmergencyCloseAll} className="controls" style={{ marginBottom: '0.6rem' }}>
            <input className="mono" name="confirm" placeholder="type CLOSE ALL" autoComplete="off" disabled={!canControl} aria-label="type CLOSE ALL to confirm" />
            <button className="btn danger" type="submit" disabled={!canControl} title="Requests EMERGENCY_CLOSE_ALL: every open position is closed at market; entries stay paused">Emergency close all</button>
          </form>
        )}
        {open.length === 0 ? (
          <p className="muted">No open positions.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr>
                  {['token', 'lots', 'quantity', 'entry / current', 'P&L realized / unrealized', 'age vs horizon', 'stop / target', 'custody', 'safety', 'protection', 'last reassessment', 'next due', 'exit route / impact', 'review', 'dry-run', 'controls'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.map((p) => <Row key={p.id} p={p} now={now} cell={cell} canControl={canControl} agoS={agoS} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Recently closed ({closed.length})</h2>
        {closed.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['token', 'lots', 'realized', 'opened', 'closed', 'last action'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr>
              </thead>
              <tbody>
                {closed.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}><a href={`/positions/${p.id}`}>{p.symbol}</a></td>
                    <td style={cell}>{[...new Set(p.lots.map((l) => l.strategy_version_id.split('@')[0]))].join(' / ') || '—'}</td>
                    <td style={cell}>{usd(baseToUsd(p.realized_pnl_base_units))}</td>
                    <td style={cell}>{agoS(p.opened_at)}</td>
                    <td style={cell}>{p.closed_at ? agoS(p.closed_at) : '—'}</td>
                    <td style={cell}>{p.lastCycle ? <a href={`/agent-activity/${p.lastCycle.id}`}>{p.lastCycle.proposed_action ?? p.lastCycle.state}{p.lastCycle.reason_codes.length ? ` (${p.lastCycle.reason_codes[0]})` : ''}</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Row({ p, now, cell, canControl, agoS }: { p: PositionRow; now: number; cell: Record<string, string>; canControl: boolean; agoS: (iso: string) => string }) {
  const alarming = p.safety_state === 'EXIT_RECOMMENDED' || p.safety_state === 'CRITICAL_EXIT';
  const review = reviewLabel(p, agoS);
  const prot = protectionHealth(p);
  const dr = dryRunState(p, now);
  const ageMin = (now - Date.parse(p.opened_at)) / 60_000;
  const horizon = p.expected_horizon_minutes;
  const ageTone = horizon === null ? 'unknown' : ageMin > horizon ? 'degraded' : 'ok';
  const unreal = p.unrealized_pnl_base_units === null ? null : baseToUsd(p.unrealized_pnl_base_units);
  const cost = baseToUsd(p.cost_basis_base_units);
  const unrealPct = unreal !== null && cost !== null && cost > 0 ? unreal / cost : null;
  const impact = p.exit_quote?.price_impact_bps ?? p.price_impact_probes?.find((x) => x.sizeUsd >= 250)?.impactBps ?? null;
  const openLots = p.lots.filter((l) => l.status === 'OPEN');
  return (
    <tr style={{ borderTop: '1px solid var(--rule)', background: alarming ? 'color-mix(in oklch, var(--failed) 12%, transparent)' : undefined }}>
      <td style={cell}><a href={`/positions/${p.id}`}><strong>{p.symbol}</strong></a><div className="muted"><a href={`/assets/${p.asset_id}`}>asset</a> · {p.status}</div></td>
      <td style={cell}>{openLots.length === 0 ? '—' : openLots.map((l) => <div key={l.id}>{l.strategy_version_id} <span className="muted">{tokens(l.quantity, p.decimals)}</span></div>)}{openLots.length > 1 && <div className="muted">same-mint lots: per-lot attribution</div>}</td>
      <td style={cell}>{tokens(p.quantity, p.decimals)}<div className="muted">cost {usd(cost)}</div></td>
      <td style={cell}>{p.average_entry_price === null ? '—' : price(p.average_entry_price)} / {price(p.price_usd)}<div className="muted">{p.snapshot_at ? `mark ${agoS(p.snapshot_at)}` : 'unmarked'}</div></td>
      <td style={{ ...cell, color: unreal !== null && unreal < 0 ? 'var(--failed)' : undefined }}>{usd(baseToUsd(p.realized_pnl_base_units))} / {unreal === null ? 'unmarked' : `${usd(unreal)}${unrealPct !== null ? ` (${(unrealPct * 100).toFixed(1)}%)` : ''}`}</td>
      <td style={cell}><span className="chip" data-tone={ageTone}><span className="v">{Math.round(ageMin)}m{horizon !== null ? ` / ${horizon}m` : ''}</span></span>{horizon === null ? <div className="muted">no horizon on entry</div> : null}</td>
      <td style={cell}>
        {p.unreviewed_stop !== null ? <>stop {price(p.unreviewed_stop)} <span className="muted">deterministic</span></> : p.stop?.level ? <>stop {price(p.stop.level)} <span className="muted">{p.stop.model ?? ''}</span></> : <span style={{ color: 'var(--failed)' }}>no stop</span>}
        <div className="muted">{p.target?.policy ? `target ${p.target.policy.toLowerCase().replace(/_/g, ' ')}` : 'no target policy'}</div>
      </td>
      <td style={cell}>{p.custody.length === 0 ? (p.custody_split.length ? `${p.custody_split.length} account(s)` : 'trading wallet') : p.custody.map((c) => c.kind.replace(/_/g, ' ').toLowerCase()).join(' + ')}</td>
      <td style={cell}><span className="chip" data-tone={p.safety_state === 'NORMAL' ? 'ok' : p.safety_state === 'DEGRADED' ? 'degraded' : 'failed'}><span className="v">{p.safety_state}</span></span>{p.safety ? <div className="muted">{agoS(p.safety.evaluated_at)}{p.safety.reasons.length ? ` · ${p.safety.reasons.slice(0, 2).join(', ')}` : ''}</div> : <div className="muted">not evaluated</div>}</td>
      <td style={cell}><span className="chip" data-tone={prot.tone}><span className="v">{prot.tone === 'ok' ? 'PROTECTED' : prot.tone === 'degraded' ? 'DEGRADED' : 'AT RISK'}</span></span><div className="muted">{prot.text}</div></td>
      <td style={cell}>{p.lastCycle ? <><a href={`/agent-activity/${p.lastCycle.id}`}>{p.lastCycle.proposed_action ?? p.lastCycle.state}</a> <span className="muted">{p.lastCycle.verdict ?? ''} · {agoS(p.lastCycle.terminal_at ?? p.lastCycle.started_at)}</span></> : <span className="muted">never</span>}</td>
      <td style={cell}>{p.next_reassessment_at ? (Date.parse(p.next_reassessment_at) < now ? <span style={{ color: 'var(--degraded)' }}>overdue {agoS(p.next_reassessment_at)}</span> : `in ${Math.round((Date.parse(p.next_reassessment_at) - now) / 1000)}s`) : '—'}</td>
      <td style={cell}>{p.exit_quote ? <>{p.exit_quote.router_label ?? 'Jupiter'} {impact !== null ? `${impact} bp` : 'impact —'} <span className="muted">{agoS(p.exit_quote.quoted_at)}</span></> : impact !== null ? `probe ${impact} bp` : <span className="muted">no exit quote</span>}</td>
      <td style={cell}><span className="chip" data-tone={review.tone}><span className="v">{review.text}</span></span></td>
      <td style={cell}><span className="chip" data-tone={dr === 'OK' ? 'ok' : dr === 'STALE' ? 'degraded' : dr === 'FAILED' ? 'failed' : 'unknown'}><span className="v">{dr}</span></span>{p.route_dry_run ? <div className="muted">{agoS(p.route_dry_run.at)}</div> : null}</td>
      <td style={cell}>
        <div className="controls">
          <form action={requestManualClose}><input type="hidden" name="positionId" value={p.id} /><button className="btn danger" type="submit" disabled={!canControl} title="Requests MANUAL_CLOSE at market">Close</button></form>
          <form action={requestManualReduce}><input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="fraction" value="0.5" /><button className="btn" type="submit" disabled={!canControl} title="Requests MANUAL_REDUCE by half">Reduce ½</button></form>
        </div>
      </td>
    </tr>
  );
}
