import Link from 'next/link';
import { When } from '../../../components/when';
import { EXIT_REASONS, loadTradeHistory, parseTradeFilters, type TradeFilters, type TradeRow } from '../../../lib/history';
import { listStrategyVersionOptions } from '../../../lib/replay';

export const dynamic = 'force-dynamic';

const fmt = (base: string | number, decimals = 6, digits = 2): string => (Number(base) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
const hold = (ms: number | null): string => (ms === null ? '—' : ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
/** Null propagates: a fee that could not be priced makes the sum unknown, never a smaller number. */
const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
const money = (v: number | null, digits = 3): string => (v === null ? 'not measured' : v.toFixed(digits));
/**
 * The cost basis a row should show: what a closed lot paid at entry, and the ledger's remaining
 * basis while a lot is still open. The lot column alone is 0 for every closed lot, which is what
 * used to render "0.00 USDC cost basis" beside a real loss.
 */
const basisOf = (r: TradeRow): number | null => (r.status === 'CLOSED' ? (r.entryCostBasisBaseUnits === null ? null : Number(r.entryCostBasisBaseUnits)) : Number(r.remainingCostBasisBaseUnits));

/**
 * Trade History (§20.10): closed strategy lots (open ones on request), filterable by strategy
 * version, book, result, exit type, execution path, regime, candidate family, adversary verdict,
 * symbol and date, with every fee class, slippage and shortfall, the entry and exit action cycles
 * (drilling into the Action Inspector) and CSV / JSON export of the filtered rows.
 */
export default async function TradeHistory({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const f = parseTradeFilters(params);
  const now = Date.now();
  const [history, versions] = await Promise.all([loadTradeHistory(f), listStrategyVersionOptions()]);
  const { rows, problems, scanned, truncated } = history;
  const cell = { padding: '0.25rem 0.7rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const th = { ...cell, textAlign: 'left' as const };
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')).toString();
  // Fee totals carry the same null discipline as the rows: one unpriced fee makes the total unknown
  // rather than smaller (review 2026-09-09, H-3). Same for the SOL-denominated column.
  const totals = rows.reduce<{ realized: number; cost: number | null; wins: number; fees: number | null; slippage: number; lamports: number }>((t, r) => ({ realized: t.realized + Number(r.realizedPnlBaseUnits), cost: add(t.cost, basisOf(r)), wins: t.wins + (Number(r.realizedPnlBaseUnits) > 0 ? 1 : 0), fees: add(t.fees, add(r.fees.routerSettlement, r.fees.transferSettlement)), slippage: t.slippage + r.slippageSettlement, lamports: t.lamports + r.fees.networkLamports + r.fees.priorityLamports }), { realized: 0, cost: 0, wins: 0, fees: 0, slippage: 0, lamports: 0 });
  const unknownBook = rows.filter((r) => r.book === 'UNKNOWN').length;
  const paths = [...new Set(rows.flatMap((r) => r.executionPaths))];
  const sel = (name: keyof TradeFilters, options: readonly string[], label: string) => (
    <label>{label}<br />
      <select name={name} defaultValue={String(f[name] ?? '')}>
        <option value="">any</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Trade History</h1>
      <p className="muted">Every closed strategy lot as the ledger holds it (S0_RAW and S0_SAFE stay separate rows). Paper and live are labelled per row; a row drills into the Action Inspector for its entry cycle.</p>
      <section className="panel">
        <h2>Filters</h2>
        <form method="get" className="form" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
          {sel('strategy', versions.map((v) => v.version_id), 'strategy version')}
          {sel('book', ['PAPER', 'LIVE'], 'book')}
          {sel('result', ['win', 'loss'], 'result')}
          <label>exit type<br /><select name="exit" defaultValue={f.exitReason}><option value="">any</option>{EXIT_REASONS.map((e) => <option key={e} value={e}>{e}</option>)}</select></label>
          <label>execution path<br /><select name="path" defaultValue={f.path}><option value="">any</option>{['JUPITER_ORDER', 'PROVIDER_PROTECTIVE', 'DIRECT_POOL_PRIVATE', 'DIRECT_POOL_RPC', ...paths.filter((p) => !['JUPITER_ORDER', 'PROVIDER_PROTECTIVE', 'DIRECT_POOL_PRIVATE', 'DIRECT_POOL_RPC'].includes(p))].map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          <label>regime<br /><select name="regime" defaultValue={f.regime}><option value="">any</option>{['RISK_ON_TREND', 'BROAD_SELLOFF', 'SOL_LED_RALLY', 'NARRATIVE_ROTATION', 'LOW_LIQUIDITY_CHOP', 'VOLATILITY_SHOCK'].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <label>candidate family<br /><select name="family" defaultValue={f.family}><option value="">any</option>{['MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION', 'SMART_MONEY_ACCUMULATION', 'CATALYST_RESPONSE', 'SOCIAL_ACCELERATION', 'HOLDER_LIQUIDITY_EXPANSION'].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <label>adversary verdict<br /><select name="verdict" defaultValue={f.verdict}><option value="">any</option>{['CONFIRM', 'CHALLENGE', 'REJECT'].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <label>symbol<br /><input className="mono" name="symbol" defaultValue={f.symbol} style={{ width: '100%' }} /></label>
          <label>opened from (UTC)<br /><input type="datetime-local" name="from" defaultValue={f.from} style={{ width: '100%' }} /></label>
          <label>opened to (UTC)<br /><input type="datetime-local" name="to" defaultValue={f.to} style={{ width: '100%' }} /></label>
          <label><input type="checkbox" name="open" value="1" defaultChecked={f.includeOpen} /> include open lots</label>
          <div><button className="btn" type="submit">Apply</button> <Link href="/history" className="muted" style={{ marginLeft: '0.5rem' }}>reset</Link></div>
        </form>
        <p style={{ margin: '0.6rem 0 0' }}>
          Export the filtered rows: <a className="btn" href={`/api/history/export?${query}${query ? '&' : ''}format=csv`} download>CSV</a> <a className="btn" href={`/api/history/export?${query}${query ? '&' : ''}format=json`} download>JSON</a>
          <span className="muted"> · includes strategy lot, cost basis, fees by class, slippage, shortfall, action-cycle ids, versions and realized outcomes</span>
        </p>
      </section>

      <section className="panel">
        <h2>{rows.length} lot(s){truncated ? ` of at least ${scanned} scanned` : ''}</h2>
        {problems.length > 0 ? (
          <p className="chip" data-tone="failed" style={{ display: 'block', margin: '0 0 0.6rem', whiteSpace: 'normal' }}>
            <strong>These rows are incomplete.</strong> {problems.length} query(ies) failed, so fees, books and cycle links may be missing rather than zero: {problems.join(' · ')}
          </p>
        ) : null}
        {truncated ? (
          <p className="chip" data-tone="unknown" style={{ display: 'block', margin: '0 0 0.6rem', whiteSpace: 'normal' }}>
            Truncated: {scanned} lot(s) were read and the scan stopped before the ledger was exhausted, so older matching lots are not shown. Narrow the date window or raise <span className="mono">?limit=</span> (max 2000).
          </p>
        ) : null}
        {unknownBook > 0 ? (
          <p className="chip" data-tone="failed" style={{ display: 'block', margin: '0 0 0.6rem', whiteSpace: 'normal' }}>
            {unknownBook} lot(s) show book <span className="mono">UNKNOWN</span>: the account row could not be read, so paper and live cannot be told apart for them. They are never assumed to be paper.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <p className="mono" style={{ margin: '0 0 0.6rem' }}>
            realized {fmt(totals.realized)} USDC on {totals.cost === null ? 'an unmeasured' : fmt(totals.cost)} USDC cost basis · {totals.wins} winner(s) of {rows.length} · router + transfer fees {money(totals.fees, 2)} USDC · slippage {totals.slippage.toFixed(2)} USDC · network + priority {(totals.lamports / 1e9).toFixed(4)} SOL
          </p>
        ) : null}
        {rows.length === 0 ? <p className="muted">No lot matches{truncated ? ` in the ${scanned} most recent lot(s) scanned — an older match would not be visible here` : ''}. Closed lots appear here once the position monitor or an operator control closes a position.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>book</th><th style={th}>opened</th><th style={th}>closed</th><th style={th}>held</th><th style={th}>symbol</th><th style={th}>strategy</th><th style={th}>cost basis</th><th style={th}>proceeds</th><th style={th}>realized</th><th style={th}>fees (router+transfer)</th><th style={th}>network+priority</th><th style={th}>slippage</th><th style={th}>entry shortfall</th><th style={th}>path</th><th style={th}>exit</th><th style={th}>family · regime</th><th style={th}>confidence · verdict</th><th style={th}>tier</th><th style={th}>cycles</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lotId}>
                    <td style={cell}><span className="chip" data-tone={r.book === 'LIVE' ? 'live-auto' : r.book === 'PAPER' ? 'paper' : 'failed'} title={r.book === 'UNKNOWN' ? 'trading.accounts.mode could not be read for this lot' : undefined}>{r.book}</span>{r.status === 'OPEN' ? <span className="chip" data-tone="active" style={{ marginLeft: '0.2rem' }}>OPEN</span> : null}</td>
                    <td style={cell}><When iso={r.openedAt} now={now} /></td>
                    <td style={cell}>{r.closedAt ? <When iso={r.closedAt} now={now} /> : '—'}</td>
                    <td style={cell}>{hold(r.holdMs)}</td>
                    <td style={cell}><Link href={`/assets/${r.assetId}`}>{r.symbol}</Link></td>
                    <td style={cell}>{r.strategyVersionId}</td>
                    <td style={cell}>{basisOf(r) === null ? 'not measured' : fmt(basisOf(r)!)}</td>
                    <td style={cell}>{r.status === 'CLOSED' ? fmt(r.proceedsBaseUnits) : '—'}</td>
                    <td style={cell}><span className="chip" data-tone={Number(r.realizedPnlBaseUnits) > 0 ? 'ok' : Number(r.realizedPnlBaseUnits) < 0 ? 'failed' : 'unknown'}>{fmt(r.realizedPnlBaseUnits)}</span></td>
                    <td style={cell}>{money(add(r.fees.routerSettlement, r.fees.transferSettlement))}</td>
                    <td style={cell}>{((r.fees.networkLamports + r.fees.priorityLamports) / 1e9).toFixed(5)} SOL</td>
                    <td style={cell}>{r.slippageSettlement.toFixed(3)}</td>
                    <td style={cell}>{r.entryShortfallBps === null ? '—' : `${r.entryShortfallBps} bps`}</td>
                    <td style={cell}>{r.executionPaths.join(', ') || '—'}</td>
                    <td style={cell}>{r.exitReason ?? '—'}{r.exitReasonScope === 'POSITION' ? <span className="muted" title="the closing intent named no lot, so this reason is the position's, not this lot's"> (position)</span> : null}</td>
                    <td style={cell}>{r.candidate ? `${r.candidate.family} · ${r.candidate.regime ?? 'regime unknown'}` : '—'}</td>
                    <td style={cell}>{r.proposerConfidence === null ? '—' : r.proposerConfidence.toFixed(2)} · {r.adversaryVerdict ?? '—'}</td>
                    <td style={cell}>{r.speedTier ?? '—'}</td>
                    <td style={cell}>{r.entryCycleId ? <Link href={`/agent-activity/${r.entryCycleId}`}>entry</Link> : '—'}{r.exitCycleIds.map((id, i) => <span key={id}> · <Link href={`/agent-activity/${id}`}>exit {i + 1}</Link></span>)}</td>
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
