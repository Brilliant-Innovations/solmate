import Link from 'next/link';
import { When } from '../../../components/when';
import { durationOf, num, pctOf } from '../../../lib/replay';
import { loadStrategyLab } from '../../../lib/strategy-lab';

export const dynamic = 'force-dynamic';

/**
 * Strategy Lab (§20.11): S0–S4 versions and status, speed tier, bound skill / guideline /
 * automation / risk versions, the paper leaderboard from closed lots, the replay leaderboard and
 * baseline comparison from the latest completed replay run, parameter and version diffs, proposer
 * confidence calibration, adversary disagreement rate and value, performance by regime, latency
 * cost, and promotion / retirement history. S0_RAW and S0_SAFE are never merged into one row.
 * Draft configuration is editable only as a new version; a live version is never edited in place.
 */
export default async function StrategyLab() {
  const now = Date.now();
  const v = await loadStrategyLab();
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const th = { ...cell, textAlign: 'left' as const };
  const tone = (s: string) => (s === 'LIVE' || s === 'ELIGIBLE_LIVE' ? 'live-auto' : s === 'RETIRED' ? 'off' : s === 'PAPER' ? 'paper' : 'watch');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Strategy Lab</h1>
      <p className="muted">Versions are immutable; a change is a new version bound by a new Release, and a live immutable version is never edited in place. <span className="mono">S0_RAW</span> (ungated baseline) and <span className="mono">S0_SAFE</span> (deterministic second-look gate) are separate rows throughout (§12.1). Replay figures are simulated time from the <Link href="/replay">Replay Lab</Link>.</p>

      <section className="panel">
        <h2>Versions ({v.versions.length})</h2>
        {v.versions.length === 0 ? <p className="muted">No strategy version registered; the worker registers them on start.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>version</th><th style={th}>variant</th><th style={th}>status</th><th style={th}>speed tier · budget</th><th style={th}>skill</th><th style={th}>guidelines</th><th style={th}>automations</th><th style={th}>risk policy</th><th style={th}>features</th><th style={th}>git</th><th style={th}>active from</th></tr></thead>
              <tbody>
                {v.versions.map((s) => (
                  <tr key={s.version_id}>
                    <td style={cell}>{s.strategy_id}</td><td style={cell}>{s.version_id}</td><td style={cell}>{s.variant}</td>
                    <td style={cell}><span className="chip" data-tone={tone(s.status)}>{s.status}</span></td>
                    <td style={cell}>{s.speed_tier} · {durationOf(s.max_decision_latency_ms)}</td>
                    <td style={cell}>{s.skill_version_id ?? '— (deterministic)'}</td><td style={cell}>{s.guideline_version_id ?? '—'}</td><td style={cell}>{s.automation_set_version_id ?? '—'}</td>
                    <td style={cell}>{s.risk_policy_version}</td><td style={cell}>{s.feature_version}</td><td style={cell}>{s.git_sha.slice(0, 7)}</td>
                    <td style={cell}><When iso={s.active_from} now={now} />{s.active_to ? <> → <When iso={s.active_to} now={now} /></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(28rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Paper leaderboard (closed lots, ledger)</h2>
          {v.paper.length === 0 ? <p className="muted">No lot yet.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>closed</th><th style={th}>open</th><th style={th}>win rate</th><th style={th}>realized USDC</th><th style={th}>expectancy</th><th style={th}>cost basis traded</th><th style={th}>last close</th></tr></thead>
              <tbody>{v.paper.map((r) => <tr key={r.strategyVersionId}><td style={cell}>{r.strategyVersionId}</td><td style={cell}>{r.closedLots}</td><td style={cell}>{r.openLots}</td><td style={cell}>{r.closedLots ? pctOf(r.wins / r.closedLots) : '—'}</td><td style={cell}>{num(r.realizedUsdc)}</td><td style={cell}>{num(r.expectancyUsdc)}</td><td style={cell}>{num(r.costBasisUsdc, 0)}</td><td style={cell}>{r.lastClosedAt ? <When iso={r.lastClosedAt} now={now} /> : '—'}</td></tr>)}</tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Level C, live paper. Full rows and export in <Link href="/history">Trade History</Link>.</p>
        </section>

        <section className="panel">
          <h2>Replay leaderboard {v.latestRun ? <span className="chip" data-tone="observe">SIMULATED · {v.latestRun.name}</span> : null}</h2>
          {!v.latestRun ? <p className="muted">No completed replay run. File one in the <Link href="/replay">Replay Lab</Link>.</p> : (
            <>
              <table className="mono" style={{ borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>strategy</th><th style={th}>variant</th><th style={th}>trades</th><th style={th}>net</th><th style={th}>win rate</th><th style={th}>expectancy</th><th style={th}>max DD</th><th style={th}>failed exec</th></tr></thead>
                <tbody>{v.leaderboard.map((r) => <tr key={`${r.strategy_version_id}|${r.variant}`}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{r.variant}</td><td style={cell}>{r.trades}</td><td style={cell}>{num(r.net_pnl)}</td><td style={cell}>{pctOf(r.win_rate)}</td><td style={cell}>{num(r.expectancy)}</td><td style={cell}>{num(r.max_drawdown)}</td><td style={cell}>{pctOf(r.failed_execution_rate)}</td></tr>)}</tbody>
              </table>
              <p className="muted" style={{ margin: '0.4rem 0 0' }}>Latest completed run <Link href={`/replay/${v.latestRun.id}`}>{v.latestRun.id.slice(0, 8)}</Link>, {v.latestRun.window_from.slice(0, 10)} → {v.latestRun.window_to.slice(0, 10)}, {v.latestRun.fidelity}.</p>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Baseline comparison (§19.3)</h2>
          {v.incremental.length === 0 ? <p className="muted">Needs a completed replay run with a non-baseline strategy.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>vs baseline</th><th style={th}>candidates</th><th style={th}>losers filtered</th><th style={th}>winners rejected</th><th style={th}>admitted</th><th style={th}>baseline net</th><th style={th}>strategy net</th><th style={th}>incremental / candidate</th></tr></thead>
              <tbody>{v.incremental.map((r) => <tr key={r.strategy_version_id}><td style={cell}>{r.strategy_version_id} vs {r.baseline_strategy_version_id}</td><td style={cell}>{r.candidates}</td><td style={cell}>{r.filtered_losers} ({num(r.filtered_losers_baseline_net)})</td><td style={cell}>{r.rejected_winners} ({num(r.rejected_winners_baseline_net)})</td><td style={cell}>{r.admitted_not_baseline}</td><td style={cell}>{num(r.baseline_net_total)}</td><td style={cell}>{num(r.strategy_net_total)}</td><td style={cell}>{num(r.incremental_net_expectancy, 3)}</td></tr>)}</tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Adversary disagreement rate / value · latency cost</h2>
          {v.disagreement.length === 0 && v.latency.length === 0 ? <p className="muted">Needs a completed replay run.</p> : (
            <>
              {v.disagreement.map((d) => <p key={d.strategy_version_id} className="mono" style={{ margin: '0 0 0.3rem' }}>{d.strategy_version_id}: disagreement {pctOf(d.disagreement_rate)} of {d.reviewed} reviewed · expectancy after CONFIRM {num(d.expectancy_after_confirm)} / after CHALLENGE {num(d.expectancy_after_challenge)} · rejected counterfactual {num(d.rejected_counterfactual_net)} on {d.rejected_with_counterfactual} · proposer-only {num(d.proposer_only_net)} vs full {num(d.full_net)}</p>)}
              <table className="mono" style={{ borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>strategy</th><th style={th}>avg latency</th><th style={th}>expired</th><th style={th}>chase</th><th style={th}>edge lost to latency</th></tr></thead>
                <tbody>{v.latency.map((l) => <tr key={l.strategy_version_id}><td style={cell}>{l.strategy_version_id}</td><td style={cell}>{durationOf(l.average_decision_latency_ms)}</td><td style={cell}>{l.expired_by_latency}</td><td style={cell}>{l.chase_rejected}</td><td style={cell}>{num(l.edge_lost_to_latency)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Proposer confidence calibration (§11.14)</h2>
          {v.calibration.length === 0 ? <p className="muted">No scored decision carried a confidence yet (deterministic strategies report none; S1 needs model keys).</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>bin</th><th style={th}>n</th><th style={th}>hit rate</th><th style={th}>expectancy</th><th style={th}>Brier</th></tr></thead>
              <tbody>{v.calibration.map((c) => <tr key={`${c.strategy_version_id}|${c.bin}`}><td style={cell}>{c.strategy_version_id}</td><td style={cell}>{c.bin}</td><td style={cell}>{c.bin_count}</td><td style={cell}>{pctOf(c.hit_rate)}</td><td style={cell}>{num(c.realized_expectancy)}</td><td style={cell}>{num(c.brier_score, 3)}</td></tr>)}</tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Performance by regime (latest replay)</h2>
          {v.attributionByRegime.length === 0 ? <p className="muted">No attributed trade yet.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>regime</th><th style={th}>trades</th><th style={th}>net</th><th style={th}>win rate</th><th style={th}>sample</th></tr></thead>
              <tbody>{v.attributionByRegime.map((r) => <tr key={`${r.strategy_version_id}|${r.group_key}`}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{r.group_key}</td><td style={cell}>{r.trades}</td><td style={cell}>{num(r.net_pnl)}</td><td style={cell}>{pctOf(r.win_rate)}</td><td style={cell}><span className="chip" data-tone={r.sample_supported ? 'ok' : 'degraded'}>{r.sample_supported ? 'supported' : 'under-sampled'}</span></td></tr>)}</tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>By cohort and token: <Link href="/attribution">Attribution / Economics</Link>.</p>
        </section>
      </div>

      <section className="panel">
        <h2>Parameter / version diffs</h2>
        {v.diffs.map((d) => (
          <details key={d.strategyId} open={d.changes.length > 0}>
            <summary className="mono">{d.strategyId}: {d.current.version_id}{d.prior ? ` vs ${d.prior.version_id} — ${d.changes.length} change(s)` : ' — first version'}</summary>
            {d.changes.length === 0 ? <p className="muted">No parameter differs from the prior version.</p> : (
              <table className="mono" style={{ borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>field</th><th style={th}>before</th><th style={th}>after</th></tr></thead>
                <tbody>{d.changes.map((c) => <tr key={c.field}><td style={cell}>{c.field}</td><td style={{ ...cell, whiteSpace: 'normal' }}>{c.before}</td><td style={{ ...cell, whiteSpace: 'normal' }}>{c.after}</td></tr>)}</tbody>
              </table>
            )}
            <p className="muted">Thresholds: <span className="mono">{JSON.stringify(d.current.thresholds)}</span></p>
          </details>
        ))}
      </section>

      <section className="panel">
        <h2>Promotion / retirement history (Releases)</h2>
        {v.releases.length === 0 ? <p className="muted">No Release yet.</p> : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>release</th><th style={th}>status</th><th style={th}>strategy</th><th style={th}>skill · guidelines · risk</th><th style={th}>created</th><th style={th}>promoted</th><th style={th}>retired</th></tr></thead>
            <tbody>{v.releases.map((r) => <tr key={r.id}><td style={cell}><Link href={`/releases/${r.id}`}>{r.digest.slice(0, 12)}</Link></td><td style={cell}><span className="chip" data-tone={r.status === 'ARMED' || r.status === 'PROMOTED' ? 'live-approval' : r.status === 'RETIRED' ? 'off' : 'watch'}>{r.status}</span></td><td style={cell}>{String(r.binding['strategyVersionId'] ?? '—')}</td><td style={cell}>{String(r.binding['skillVersionId'] ?? '—')} · {String(r.binding['guidelineVersionId'] ?? '—')} · {String(r.binding['riskPolicyVersion'] ?? '—')}</td><td style={cell}><When iso={r.created_at} now={now} /></td><td style={cell}>{r.promoted_at ? <When iso={r.promoted_at} now={now} /> : '—'}</td><td style={cell}>{r.retired_at ? <When iso={r.retired_at} now={now} /> : '—'}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
