import Link from 'next/link';
import { loadAttribution } from '../../../lib/attribution';
import { num } from '../../../lib/replay';

export const dynamic = 'force-dynamic';

/**
 * Attribution / Economic P&L (§20.16, §19.4, D37): trading P&L (gross, router fees, priority and
 * network fees, transfer fees, slippage, net), strategy economic P&L (attributable model calls and
 * data/RPC share), platform economic P&L (aggregate strategies, shared subscriptions, hosting,
 * final operating result) and cost per candidate, action cycle, executed trade and profitable
 * trade. Economic P&L includes direct strategy and shared platform operating costs (§31).
 */
export default async function Attribution({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const daysRaw = Number(typeof params['days'] === 'string' ? params['days'] : 30);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
  const v = await loadAttribution(days);
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const th = { ...cell, textAlign: 'left' as const };
  const usd = (n: number | null) => (n === null ? '—' : `$${num(n)}`);
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Attribution / Economics</h1>
      <p className="muted">Period: last {days} days ({v.from.slice(0, 10)} → {v.to.slice(0, 10)}) · {[7, 30, 90].map((d) => <Link key={d} href={`/attribution?days=${d}`} style={{ marginRight: '0.5rem', fontWeight: d === days ? 700 : 400 }}>{d} d</Link>)} · lots closed inside the window, so realized P&amp;L and the costs it is netted against cover the same period; paper and live labelled from the account&apos;s immutable mode. Regime, session, liquidity and confidence attribution for replays live in the <Link href="/replay">Replay Lab</Link>.</p>
      {v.problems.length > 0 ? (
        <p className="chip" data-tone="failed" style={{ display: 'block', whiteSpace: 'normal' }}>
          <strong>These numbers are incomplete.</strong> {v.problems.length} query(ies) failed, so costs and fees below may be missing rather than zero: {v.problems.join(' · ')}
        </p>
      ) : null}
      {v.truncated ? (
        <p className="chip" data-tone="unknown" style={{ display: 'block', whiteSpace: 'normal' }}>
          The lot scan was cut short, so the trading layer covers only the most recent closed lots of the period. Every figure below is a lower bound on activity, not a period total.
        </p>
      ) : null}

      <section className="panel">
        <h2>Trading P&amp;L</h2>
        {v.trading.length === 0 ? <p className="muted">No closed lot in the period.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>book</th><th style={th}>trades</th><th style={th}>profitable</th><th style={th}>gross return</th><th style={th}>DEX/router fees</th><th style={th}>transfer fees</th><th style={th}>priority + network</th><th style={th}>slippage / impact</th><th style={th}>net trading result</th></tr></thead>
              <tbody>{v.trading.map((t) => <tr key={`${t.strategyVersionId}|${t.book}`}><td style={cell}>{t.strategyVersionId}</td><td style={cell}><span className="chip" data-tone={t.book === 'LIVE' ? 'live-auto' : t.book === 'PAPER' ? 'paper' : 'failed'}>{t.book}</span></td><td style={cell}>{t.trades}</td><td style={cell}>{t.profitable}</td><td style={cell}>{t.grossUsdc === null ? 'not measured' : `${num(t.grossUsdc)} USDC`}</td><td style={cell}>{t.routerFeesUsdc === null ? 'not measured' : num(t.routerFeesUsdc, 3)}</td><td style={cell}>{t.transferFeesUsdc === null ? 'not measured' : num(t.transferFeesUsdc, 3)}</td><td style={cell}>{((t.networkLamports + t.priorityLamports) / 1e9).toFixed(5)} SOL{t.networkPriorityUsd !== null ? ` (${usd(t.networkPriorityUsd)})` : ' (SOL price unknown)'}</td><td style={cell}>{num(t.slippageUsdc, 3)}</td><td style={cell}><span className="chip" data-tone={t.netUsdc > 0 ? 'ok' : t.netUsdc < 0 ? 'failed' : 'unknown'}>{num(t.netUsdc)} USDC</span></td></tr>)}</tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>Gross = realized + router and transfer fees; slippage is the realized shortfall against the contemporaneous executable expectation (D48), shown separately and never labelled MEV. Priority/network fees are SOL and converted at the latest SOL price when the scanner tracks it.</p>
      </section>

      <section className="panel">
        <h2>Strategy economic P&amp;L</h2>
        {v.strategy.length === 0 ? <p className="muted">No closed lot in the period.</p> : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>strategy</th><th style={th}>book</th><th style={th}>net trading (after SOL fees)</th><th style={th}>attributable LLM calls</th><th style={th}>data / RPC share</th><th style={th}>contribution after direct cost</th></tr></thead>
            <tbody>{v.strategy.map((s) => <tr key={`${s.strategyVersionId}|${s.book}`}><td style={cell}>{s.strategyVersionId}</td><td style={cell}>{s.book}</td><td style={cell}>{usd(s.netTradingUsd)}</td><td style={cell}>{usd(s.modelUsd)} ({s.modelRuns} run(s)){s.modelUsdAllocated > 0 ? <span className="muted"> · {usd(s.modelUsdDirect)} direct + {usd(s.modelUsdAllocated)} allocated</span> : null}</td><td style={cell}>{usd(s.dataRpcShareUsd)}</td><td style={cell}><span className="chip" data-tone={s.contributionUsd === null ? 'unknown' : s.contributionUsd > 0 ? 'ok' : s.contributionUsd < 0 ? 'failed' : 'unknown'}>{usd(s.contributionUsd)}</span></td></tr>)}</tbody>
          </table>
        )}
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>LLM cost is the ledger&apos;s <span className="mono">agents.runs.cost_usd</span> joined to each run&apos;s action cycle and strategy; the data/RPC share is metered Birdeye compute units at the Lite rate, prorated to the days of each month inside the period and allocated by turnover. A cycle&apos;s book comes from the account its intent charged, so a strategy running in both books is charged its model cost once, split between them; cycles that never produced an intent are allocated across that strategy&apos;s books by direct model spend and shown separately. USDC is treated as USD.</p>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(28rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Platform economic P&amp;L</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">aggregate strategy contribution</td><td style={cell}>{usd(v.platform.aggregateContributionUsd)}</td></tr>
            <tr><td style={cell} className="muted">shared provider subscriptions ({days} d share)</td><td style={cell}>{usd(v.platform.subscriptionsUsd)}</td></tr>
            <tr><td style={cell} className="muted">metered data usage (Birdeye CU at Lite rate)</td><td style={cell}>{usd(v.platform.dataUsageUsd)} <span className="muted">already inside the strategy share</span></td></tr>
            <tr><td style={cell} className="muted">hosting / database / worker</td><td style={cell}>{usd(v.platform.hostingUsd)} <span className="muted">free tiers at Profile 0/1; Supabase Pro and Vercel Pro appear here once taken</span></td></tr>
            <tr><td style={cell} className="muted"><strong>final operating result</strong></td><td style={cell}><span className="chip" data-tone={v.platform.finalOperatingResultUsd === null ? 'unknown' : v.platform.finalOperatingResultUsd > 0 ? 'ok' : 'failed'}>{usd(v.platform.finalOperatingResultUsd)}</span></td></tr>
          </tbody></table>
          <table className="mono" style={{ borderCollapse: 'collapse', marginTop: '0.6rem' }}>
            <thead><tr><th style={th}>provider</th><th style={th}>tier</th><th style={th}>monthly</th><th style={th}>{days} d</th><th style={th}>note</th></tr></thead>
            <tbody>{v.platform.subscriptions.map((s) => <tr key={s.provider}><td style={cell}>{s.provider}</td><td style={cell}>{s.tier}</td><td style={cell}>{usd(s.monthlyUsd)}</td><td style={cell}>{usd(s.periodUsd)}</td><td style={{ ...cell, whiteSpace: 'normal' }}>{s.note}</td></tr>)}</tbody>
          </table>
          {v.platform.providerSpend.length > 0 ? <p className="muted" style={{ margin: '0.4rem 0 0' }}>Metered: {v.platform.providerSpend.map((p) => `${p.provider} ${p.month} ${p.usedCu.toLocaleString()} CU (${usd(p.estimatedUsd)} for the month, ${usd(p.periodUsd)} inside this period)`).join(' · ')}</p> : null}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Run-rate tiers as recorded in docs/costs.md; a tier change is a costs-sheet edit at milestone exit, never a silent constant.</p>
        </section>

        <section className="panel">
          <h2>Unit costs</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">total operating cost in period</td><td style={cell}>{usd(v.units.totalCostUsd)}</td></tr>
            <tr><td style={cell} className="muted">candidates</td><td style={cell}>{v.units.candidates} → {usd(v.units.perCandidate)} per candidate</td></tr>
            <tr><td style={cell} className="muted">action cycles</td><td style={cell}>{v.units.actionCycles} → {usd(v.units.perActionCycle)} per action cycle</td></tr>
            <tr><td style={cell} className="muted">executed trades (closed lots)</td><td style={cell}>{v.units.executedTrades} → {usd(v.units.perExecutedTrade)} per executed trade</td></tr>
            <tr><td style={cell} className="muted">profitable trades</td><td style={cell}>{v.units.profitableTrades} → {usd(v.units.perProfitableTrade)} per profitable trade</td></tr>
          </tbody></table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Rows in <Link href="/history">Trade History</Link>; strategy comparison in the <Link href="/strategy-lab">Strategy Lab</Link>.</p>
        </section>
      </div>
    </>
  );
}
