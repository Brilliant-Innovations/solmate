import { ago, tokens } from '../../../lib/paper';
import { lamportsToSol, loadWalletView, reserveStatus, short } from '../../../lib/wallet';

export const dynamic = 'force-dynamic';

/**
 * Wallet / Custody (§20.9, §13.6, D9, D26, D35, §31). The trading wallet and its registered custody
 * accounts, the latest chain reconciliation with every balance line (expected vs observed), the
 * D35 reserve check, sticky entry pauses (cleared only by a step-up RESUME), the capital ceiling
 * attested at arming, and the manual funding record. Nothing on this page signs, funds or moves
 * anything: replenishment is manual and reconciliation is the authority (§31).
 */
export default async function Wallet() {
  const v = await loadWalletView();
  const now = Date.now();
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const };
  const th = (labels: string[]) => (
    <thead>
      <tr>
        {labels.map((h) => (
          <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
        ))}
      </tr>
    </thead>
  );
  if (!v.account) {
    return (
      <>
        <h1 style={{ marginTop: 0 }}>Wallet / Custody</h1>
        <p className="muted">No trading account exists yet.</p>
      </>
    );
  }
  const account = v.account;
  const isPaper = account.name.startsWith('paper');
  const r = v.reconciliation;
  const reserve = reserveStatus(r, v.account.settlement_mint);
  const reconTone = r === null ? 'unknown' : r.status === 'CLEAN' ? 'ok' : r.status === 'MISMATCH' ? 'failed' : 'degraded';
  const reserveTone = (s: string) => (s === 'OK' ? 'ok' : s === 'BELOW_RESERVE' ? 'failed' : 'unknown');
  const mintLabel = (mint: string | null) => (mint === null ? 'SOL' : mint === account.settlement_mint ? 'USDC' : short(mint));
  const amount = (mint: string | null, base: string | null) => (base === null ? '—' : mint === null ? `${lamportsToSol(base)} SOL` : mint === account.settlement_mint ? tokens(base, 6) : base);
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Wallet / Custody</h1>
      <section className="panel">
        <h2>Trading wallet</h2>
        <p className="mono" style={{ margin: '0.2rem 0' }}>
          <span className="chip" data-tone={isPaper ? 'paper' : 'live-approval'}><span className="v">{isPaper ? 'PAPER ACCOUNT' : 'LIVE ACCOUNT'}</span></span> {v.account.name} · {v.account.cluster}
        </p>
        <p className="mono" style={{ margin: '0.2rem 0', wordBreak: 'break-all' }}>{v.account.trading_wallet}</p>
        <p className="muted" style={{ margin: '0.2rem 0' }}>
          {isPaper ? 'Paper account: balances below are ledger expectations reconciled against the observation wallet; no real custody is at risk.' : 'Live account: reconciliation against chain truth is the custody authority (D9).'}
          {' '}Settlement mint {short(v.account.settlement_mint)} · owned-address registry {v.ownedAddresses === null ? 'unavailable' : `${v.ownedAddresses} address(es)`} (D26).
        </p>
        {v.attestation ? (
          <p className="mono" style={{ margin: '0.2rem 0' }}>
            Attested capital ceiling ${v.attestation.ceiling_usd.toLocaleString()} · recognized at attestation {v.attestation.recognized_usd_at_attestation === null ? '—' : `$${v.attestation.recognized_usd_at_attestation.toLocaleString()}`} · {ago(v.attestation.attested_at, now)}
          </p>
        ) : (
          <p className="muted mono" style={{ margin: '0.2rem 0' }}>No capital attestation: this account has never been armed (D56).</p>
        )}
      </section>

      <section className="panel">
        <h2>Reserves (D35)</h2>
        <p className="mono" style={{ margin: 0 }}>
          <span className="chip" data-tone={reserveTone(reserve.gas.state)}><span className="v">{reserve.gas.state}</span></span> gas SOL {lamportsToSol(reserve.gas.observed)} (min {lamportsToSol(reserve.gas.min)}) ·{' '}
          <span className="chip" data-tone={reserveTone(reserve.settlement.state)}><span className="v">{reserve.settlement.state}</span></span> settlement {reserve.settlement.observed === null ? '—' : tokens(reserve.settlement.observed, 6)} USDC (min {tokens(reserve.settlement.min, 6)})
        </p>
        <p className="muted" style={{ margin: '0.3rem 0 0' }}>Replenishment is manual. Threshold breaches raise alerts; nothing here funds the wallet (§31).</p>
      </section>

      <section className="panel">
        <h2>Chain reconciliation</h2>
        {r === null ? (
          <p className="muted">No reconciliation report yet; balances are unknown, not zero.</p>
        ) : (
          <>
            <p className="mono" style={{ margin: 0 }}>
              <span className="chip" data-tone={reconTone}><span className="v">{r.status}</span></span> evaluated {ago(r.evaluated_at, now)} · slot {r.chain_slot ?? '—'} · movements via {r.movement_source}
              {r.pause_triggered ? ' · PAUSED NEW ENTRIES' : ''}
              {r.reasons.length ? ` · ${r.reasons.join(', ')}` : ''}
            </p>
            <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
              <table className="mono" style={{ borderCollapse: 'collapse' }}>
                {th(['balance', 'address', 'expected', 'observed', 'delta', 'ok'])}
                <tbody>
                  {r.balances.map((b) => (
                    <tr key={`${b.address}:${b.mint ?? 'SOL'}`}>
                      <td style={cell}>{mintLabel(b.mint)}</td>
                      <td style={cell}>{short(b.address)}</td>
                      <td style={cell}>{b.expected === null ? 'no expectation' : amount(b.mint, b.expected)}</td>
                      <td style={cell}>{amount(b.mint, b.observed)}</td>
                      <td style={cell}>{b.delta ?? '—'}</td>
                      <td style={cell}>{b.ok ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.unexpected_token_accounts.length > 0 && (
              <p className="mono" style={{ margin: '0.5rem 0 0', color: 'var(--failed)' }}>
                Unexpected token accounts: {r.unexpected_token_accounts.map((u) => `${short(u.tokenAccount)} (${short(u.mint)}${u.registered ? '' : ', unregistered'})`).join(', ')}
              </p>
            )}
            {r.unparsed_signatures.length > 0 && <p className="muted mono" style={{ margin: '0.3rem 0 0' }}>{r.unparsed_signatures.length} signature(s) could not be parsed into movements this cycle.</p>}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Entry pauses ({v.pauses.length})</h2>
        {v.pauses.length === 0 ? (
          <p className="muted">No sticky entry pause is active.</p>
        ) : (
          <>
            {v.pauses.map((p) => (
              <p key={p.id} className="mono" style={{ margin: '0.2rem 0' }}>
                <span className="chip" data-tone="paused"><span className="v">PAUSED</span></span> {p.reason} · set by {p.set_by} ({p.set_by_ref}) {ago(p.set_at, now)}
              </p>
            ))}
            <p className="muted" style={{ margin: '0.3rem 0 0' }}>A sticky pause survives session restarts. Only a step-up RESUME clears it (§21.2C); exits and protection keep running.</p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Custody accounts ({v.custody.length})</h2>
        {v.custody.length === 0 ? (
          <p className="muted">No custody accounts registered.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              {th(['kind', 'address', 'provider', 'mint', 'verification', 'active'])}
              <tbody>
                {v.custody.map((c) => (
                  <tr key={c.id}>
                    <td style={cell}>{c.kind}</td>
                    <td style={cell}>{short(c.address)}</td>
                    <td style={cell}>{c.owner_provider}</td>
                    <td style={cell}>{c.mint === null ? '—' : mintLabel(c.mint)}</td>
                    <td style={cell}>{c.verification_state}</td>
                    <td style={cell}>{c.active_to ? `ended ${ago(c.active_to, now)}` : `since ${ago(c.active_from, now)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Funding record</h2>
        {v.funding.length === 0 ? (
          <p className="muted">No funding events recorded for this wallet. Funding is a manual, typed-guard operation (§20.9); confirmation comes only from chain reconciliation.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              {th(['state', 'from', 'mint', 'amount', 'signature', 'created', 'confirmed'])}
              <tbody>
                {v.funding.map((f) => (
                  <tr key={f.id}>
                    <td style={cell}>{f.state}{f.failure_reason ? ` (${f.failure_reason})` : ''}</td>
                    <td style={cell}>{short(f.source_wallet)}</td>
                    <td style={cell}>{mintLabel(f.funding_mint)}</td>
                    <td style={cell}>{amount(f.funding_mint, f.requested_amount)}</td>
                    <td style={cell}>{f.tx_signature ? short(f.tx_signature) : '—'}</td>
                    <td style={cell}>{ago(f.created_at, now)}</td>
                    <td style={cell}>{f.confirmed_at ? ago(f.confirmed_at, now) : 'not confirmed'}</td>
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
