import { ago, baseToUsd, loadPaperAccount, loadPositions, tokens, usd } from '../../../lib/paper';

export const dynamic = 'force-dynamic';

/**
 * Positions table (§20.4, §20.21): open first, then recently closed. Marks come from the position
 * monitor's executable exit quote; an unmarked position shows no unrealized value rather than 0.
 * The stop shown is the deterministic, tighten-only unreviewed stop (D39).
 */
export default async function Positions() {
  const account = await loadPaperAccount();
  const rows = account ? await loadPositions(account.id, { includeClosed: true, limit: 100 }) : [];
  const open = rows.filter((p) => p.status !== 'CLOSED');
  const closed = rows.filter((p) => p.status === 'CLOSED');
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const };
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Positions</h1>
      {!account && <p className="muted">No paper account exists yet.</p>}
      <section className="panel">
        <h2>Open ({open.length})</h2>
        {open.length === 0 ? (
          <p className="muted">No open positions.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['asset', 'strategy', 'quantity', 'cost', 'entry', 'stop', 'unrealized', 'safety', 'review', 'opened'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>{p.symbol}</td>
                    <td style={cell}>{p.strategies.join(' / ') || '—'}</td>
                    <td style={cell}>{tokens(p.quantity, p.decimals)}</td>
                    <td style={cell}>{usd(baseToUsd(p.cost_basis_base_units))}</td>
                    <td style={cell}>{p.average_entry_price === null ? '—' : p.average_entry_price.toPrecision(5)}</td>
                    <td style={cell}>{p.unreviewed_stop === null ? (p.stop?.level ?? '—') : p.unreviewed_stop.toPrecision(5)}</td>
                    <td style={cell}>{p.unrealized_pnl_base_units === null ? 'unmarked' : usd(baseToUsd(p.unrealized_pnl_base_units))}</td>
                    <td style={cell}>{p.safety_state}</td>
                    <td style={cell}>{p.review_state}</td>
                    <td style={cell}>{ago(p.opened_at)}</td>
                  </tr>
                ))}
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
                <tr>
                  {['asset', 'strategy', 'realized', 'opened', 'closed'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>{p.symbol}</td>
                    <td style={cell}>{p.strategies.join(' / ') || '—'}</td>
                    <td style={cell}>{usd(baseToUsd(p.realized_pnl_base_units))}</td>
                    <td style={cell}>{ago(p.opened_at)}</td>
                    <td style={cell}>{ago(p.closed_at)}</td>
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
