import Link from 'next/link';
import { notFound } from 'next/navigation';
import { When } from '../../../../components/when';
import { baseToUnits, durationOf, FIDELITY_LABEL, loadReplayRunDetail, lookAheadTone, num, pctOf, statusTone } from '../../../../lib/replay';

export const dynamic = 'force-dynamic';

const DIMENSION_LABEL: Record<string, string> = {
  candidateFamily: 'candidate family',
  regime: 'market regime',
  session: 'market session',
  liquidityBand: 'liquidity band',
  relativeVolumeBand: 'relative-volume band',
  confidenceBin: 'proposer confidence bin',
  adversaryVerdict: 'adversary verdict',
  hourOfDayUtc: 'hour of day (UTC)',
  dayOfWeekUtc: 'day of week (UTC, 0 = Sunday)',
  durationBand: 'position duration',
  executionPath: 'execution path',
};

/**
 * One replay run (§20.15 outputs, §18.5, §19, §30): the reproducibility record, strategies side
 * by side, every attribution the §30 views answer, and the action-cycle timeline in simulated
 * time. Read only; the run is immutable once it completed or failed.
 */
export default async function ReplayRun({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await loadReplayRunDetail(id);
  if (!d) notFound();
  const now = Date.now();
  const { run } = d;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const th = { ...cell, textAlign: 'left' as const };
  const v = run.versions as Record<string, unknown>;
  const versionRows: [string, unknown][] = [
    ['git SHA', v['gitSha']],
    ['contract-set digest', v['contractSetDigest']],
    ['feature engine', v['featureEngineVersion']],
    ['risk policy', v['riskPolicyVersion']],
    ['S0 gate policy', v['gatePolicyVersion']],
    ['cost model', v['costModelVersion']],
    ['skill / guidelines', `${String(v['skillVersionId'] ?? '—')} / ${String(v['guidelineVersionId'] ?? '—')}`],
    ['prompt versions', JSON.stringify(v['promptVersions'] ?? {})],
    ['model selections', JSON.stringify(v['modelSelections'] ?? {})],
    ['provider dataset versions', JSON.stringify(v['providerDatasetVersions'] ?? {})],
  ];
  const dims = [...new Set(d.attribution.map((a) => a.dimension))];
  const symbol = (assetId: string) => d.assets.get(assetId)?.symbol ?? assetId.slice(0, 8);
  const decimals = (assetId: string) => d.assets.get(assetId)?.decimals ?? 6;
  const time = (isoStr: string) => isoStr.slice(0, 19).replace('T', ' ');
  return (
    <>
      <p className="notice" role="note" style={{ fontWeight: 600 }}>SIMULATED TIME — replay run <span className="mono">{run.id}</span>. Every timestamp below is the replay clock, not the wall clock; nothing here is live trading.</p>
      <h1 style={{ marginTop: 0 }}>{run.name} <span className="chip" data-tone={statusTone(run.status)}>{run.status}</span> <span className="chip" data-tone="observe">{FIDELITY_LABEL[run.fidelity]}</span></h1>
      <p className="muted"><Link href="/replay">← Replay Lab</Link> · filed <When iso={run.created_at} now={now} />{run.started_at ? <> · started <When iso={run.started_at} now={now} /></> : null}{run.completed_at ? <> · finished <When iso={run.completed_at} now={now} /></> : null}</p>
      {run.error ? <p className="notice" role="alert">Run failed: <span className="mono">{run.error}</span></p> : null}

      <section className="panel">
        <h2>Reproducibility record (§18.5)</h2>
        <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
          <tr><td style={cell} className="muted">window (simulated)</td><td style={cell}>{time(run.window_from)} → {time(run.window_to)} UTC{run.in_sample_until ? <> · hold-out from {time(run.in_sample_until)}</> : <> · no hold-out split</>}</td></tr>
          <tr><td style={cell} className="muted">dataset cutoff</td><td style={cell}>{time(run.dataset_cutoff)} UTC — no observation made after this instant was readable by the run</td></tr>
          <tr><td style={cell} className="muted">strategies</td><td style={{ ...cell, whiteSpace: 'normal' }}>{run.strategy_version_ids.map((s) => <span key={s} className="chip" data-tone={s === run.baseline_strategy_version_id ? 'watch' : 'paper'} style={{ marginRight: '0.3rem' }}>{s}{s === run.baseline_strategy_version_id ? ' · baseline' : ''}</span>)}</td></tr>
          <tr><td style={cell} className="muted">protocol</td><td style={{ ...cell, whiteSpace: 'normal' }}>seed {run.seed} · latency-matched baseline {run.latency_matched_baseline ? 'on' : 'off'} · proposer-only shadow {run.proposer_only_shadow ? 'on' : 'off'} · calibration target {run.calibration_target.kind} within {durationOf(run.calibration_target.horizonMs)}{run.asset_ids ? ` · universe restricted to ${run.asset_ids.length} asset(s)` : ' · whole captured universe'}</td></tr>
          {versionRows.map(([k, val]) => <tr key={k}><td style={cell} className="muted">{k}</td><td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}>{String(val ?? '—')}</td></tr>)}
          <tr><td style={cell} className="muted">models</td><td style={{ ...cell, whiteSpace: 'normal' }}>{run.models.length === 0 ? 'none (deterministic strategies only)' : run.models.map((m) => <span key={`${m.role}:${m.model}`} style={{ marginRight: '0.6rem' }}>{m.role}: {m.model} <span className="chip" data-tone={lookAheadTone(m.lookAhead)}>{m.lookAhead}</span>{m.trainingCutoff ? <span className="muted"> trained to {m.trainingCutoff.slice(0, 10)}</span> : <span className="muted"> training cutoff unknown</span>}</span>)}</td></tr>
          <tr><td style={cell} className="muted">decisions digest</td><td style={{ ...cell, wordBreak: 'break-all', whiteSpace: 'normal' }}>{run.decisions_digest ?? '—'}</td></tr>
          <tr><td style={cell} className="muted">results digest</td><td style={{ ...cell, wordBreak: 'break-all', whiteSpace: 'normal' }}>{run.results_digest ?? '—'}</td></tr>
        </tbody></table>
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>A second run of the same request, versions and seed reproduces the decisions digest; a different digest means the inputs, the code or the model outputs changed.</p>
      </section>

      <section className="panel">
        <h2>Strategies side by side (§19.1)</h2>
        {d.leaderboard.length === 0 ? <p className="muted">No results yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>variant</th><th style={th}>sample</th><th style={th}>trades</th><th style={th}>net P&amp;L</th><th style={th}>gross</th><th style={th}>fees</th><th style={th}>slippage</th><th style={th}>shortfall bps</th><th style={th}>win rate</th><th style={th}>expectancy</th><th style={th}>profit factor</th><th style={th}>max DD</th><th style={th}>time in market</th><th style={th}>turnover</th><th style={th}>Sharpe</th><th style={th}>Sortino</th><th style={th}>tail loss</th><th style={th}>failed exec</th><th style={th}>decision→fill</th></tr></thead>
              <tbody>
                {d.leaderboard.map((r) => (
                  <tr key={`${r.strategy_version_id}|${r.variant}|${r.sample}`} style={{ opacity: r.sample === 'ALL' ? 1 : 0.8 }}>
                    <td style={cell}>{r.strategy_version_id}{r.strategy_version_id === run.baseline_strategy_version_id ? <span className="muted"> · baseline</span> : null}</td>
                    <td style={cell}>{r.variant}</td><td style={cell}>{r.sample}</td><td style={cell}>{r.trades}</td>
                    <td style={cell}>{num(r.net_pnl)}</td><td style={cell}>{num(r.gross_pnl)}</td><td style={cell}>{num(r.fees)}</td><td style={cell}>{num(r.slippage_cost)}</td><td style={cell}>{num(r.execution_shortfall_bps, 0)}</td>
                    <td style={cell}>{pctOf(r.win_rate)}</td><td style={cell}>{num(r.expectancy)}</td><td style={cell}>{num(r.profit_factor)}</td><td style={cell}>{num(r.max_drawdown)} ({pctOf(r.max_drawdown_fraction)})</td><td style={cell}>{pctOf(r.time_in_market_fraction)}</td><td style={cell}>{num(r.turnover, 0)}</td>
                    <td style={cell}>{num(r.sharpe)}</td><td style={cell}>{num(r.sortino)}</td><td style={cell}>{num(r.tail_loss)}</td><td style={cell}>{pctOf(r.failed_execution_rate)}</td><td style={cell}>{durationOf(r.average_decision_to_fill_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>S0_RAW and S0_SAFE are separate rows by design (§12.1). Sharpe and Sortino are blank below the minimum sample; a blank profit factor means no losing trade yet, not an infinite edge.</p>
      </section>

      <section className="panel">
        <h2>Baseline comparison (§19.3) · Q1, Q8</h2>
        {d.incremental.length === 0 ? <p className="muted">Only the baseline ran.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy vs baseline</th><th style={th}>candidates</th><th style={th}>both traded</th><th style={th}>losers filtered (baseline net)</th><th style={th}>winners rejected (baseline net)</th><th style={th}>admitted, baseline passed (net)</th><th style={th}>both passed</th><th style={th}>baseline net</th><th style={th}>strategy net</th><th style={th}>model cost</th><th style={th}>incremental net expectancy / candidate</th></tr></thead>
              <tbody>
                {d.incremental.map((r) => (
                  <tr key={r.strategy_version_id}>
                    <td style={cell}>{r.strategy_version_id} vs {r.baseline_strategy_version_id}</td><td style={cell}>{r.candidates}</td><td style={cell}>{r.both_traded}</td>
                    <td style={cell}>{r.filtered_losers} ({num(r.filtered_losers_baseline_net)})</td><td style={cell}>{r.rejected_winners} ({num(r.rejected_winners_baseline_net)})</td><td style={cell}>{r.admitted_not_baseline} ({num(r.admitted_not_baseline_net)})</td><td style={cell}>{r.both_passed}</td>
                    <td style={cell}>{num(r.baseline_net_total)}</td><td style={cell}>{num(r.strategy_net_total)}</td><td style={cell}>{num(r.model_cost)}</td><td style={cell}>{num(r.incremental_net_expectancy, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(28rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Proposer / adversary disagreement · Q8, Q16, Q18</h2>
          {d.disagreement.length === 0 ? <p className="muted">No reviewed strategy in this run.</p> : d.disagreement.map((r) => (
            <table key={r.strategy_version_id} className="mono" style={{ borderCollapse: 'collapse', marginBottom: '0.6rem' }}><tbody>
              <tr><td style={cell} className="muted">strategy</td><td style={cell}>{r.strategy_version_id}</td></tr>
              <tr><td style={cell} className="muted">reviewed · confirm / challenge / reject</td><td style={cell}>{r.reviewed} · {r.confirmed} / {r.challenged} / {r.rejected} (disagreement {pctOf(r.disagreement_rate)})</td></tr>
              <tr><td style={cell} className="muted">expectancy after CONFIRM / after CHALLENGE</td><td style={cell}>{num(r.expectancy_after_confirm)} / {num(r.expectancy_after_challenge)}</td></tr>
              <tr><td style={cell} className="muted">rejected: baseline counterfactual</td><td style={cell}>{r.rejected_with_counterfactual} traded by the baseline, net {num(r.rejected_counterfactual_net)}</td></tr>
              <tr><td style={cell} className="muted">proposer-only shadow / full</td><td style={cell}>{num(r.proposer_only_net)} / {num(r.full_net)}</td></tr>
              <tr><td style={cell} className="muted">top objections</td><td style={{ ...cell, whiteSpace: 'normal' }}>{r.top_objections.length ? r.top_objections.map((o) => `${o.code} ×${o.count}`).join(', ') : '—'}</td></tr>
            </tbody></table>
          ))}
        </section>

        <section className="panel">
          <h2>Latency cost · Q15, Q17</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>strategy</th><th style={th}>decisions</th><th style={th}>expired</th><th style={th}>chase</th><th style={th}>stale quote</th><th style={th}>baseline made on them</th><th style={th}>avg latency</th><th style={th}>edge lost to latency</th></tr></thead>
            <tbody>{d.latency.map((r) => <tr key={r.strategy_version_id}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{r.decisions}</td><td style={cell}>{r.expired_by_latency}</td><td style={cell}>{r.chase_rejected}</td><td style={cell}>{r.stale_quote_rejected}</td><td style={cell}>{num(r.missed_baseline_net)}</td><td style={cell}>{durationOf(r.average_decision_latency_ms)}</td><td style={cell}>{num(r.edge_lost_to_latency)}</td></tr>)}</tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Edge lost to latency = FULL net minus LATENCY_MATCHED net for the same strategy; blank when the run has no latency-matched stream for it.</p>
        </section>

        <section className="panel">
          <h2>Confidence calibration · Q11</h2>
          {d.calibration.filter((c) => c.bin_count > 0).length === 0 ? <p className="muted">No scored decision carried a proposer confidence (deterministic strategies report none).</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>strategy</th><th style={th}>bin</th><th style={th}>n</th><th style={th}>mean confidence</th><th style={th}>hit rate</th><th style={th}>realized expectancy</th><th style={th}>Brier</th></tr></thead>
              <tbody>{d.calibration.filter((c) => c.bin_count > 0).map((c) => <tr key={`${c.strategy_version_id}|${c.bin}`}><td style={cell}>{c.strategy_version_id}</td><td style={cell}>{c.bin}</td><td style={cell}>{c.bin_count}</td><td style={cell}>{num(c.mean_confidence)}</td><td style={cell}>{pctOf(c.hit_rate)}</td><td style={cell}>{num(c.realized_expectancy)}</td><td style={cell}>{num(c.brier_score, 3)}</td></tr>)}</tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Target: {run.calibration_target.kind} within {durationOf(run.calibration_target.horizonMs)}. Brier 0.25 is a coin flip at 0.5.</p>
        </section>

        <section className="panel">
          <h2>Economic P&amp;L, three layers · Q19</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>strategy</th><th style={th}>trading net</th><th style={th}>direct cost</th><th style={th}>strategy economic</th><th style={th}>platform share</th><th style={th}>platform economic</th><th style={th}>cost / edge</th></tr></thead>
            <tbody>{d.economic.map((r) => <tr key={r.strategy_version_id}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{num(r.trading_net_usd)}</td><td style={cell}>{num(r.direct_cost_usd)}</td><td style={cell}>{num(r.strategy_economic_usd)}</td><td style={cell}>{num(r.platform_share_usd)}</td><td style={cell}>{num(r.platform_economic_usd)}</td><td style={cell}>{num(r.cost_to_edge_ratio)}</td></tr>)}</tbody>
          </table>
          {d.economic[0] ? <p className="muted" style={{ margin: '0.4rem 0 0' }}>Platform run-rate for the {num(d.economic[0].window_days, 1)}-day window {num(d.economic[0].platform_cost_for_window_usd)} USD, allocated {d.economic[0].allocation === 'BY_TURNOVER' ? 'by turnover' : 'equally'}. Direct model/data/RPC cost is 0 in replay until the spend ledger is joined per strategy.</p> : null}
        </section>
      </div>

      <section className="panel">
        <h2>Exits · Q13, Q14</h2>
        {d.exits.length === 0 ? <p className="muted">No closed trade.</p> : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>strategy</th><th style={th}>variant</th><th style={th}>sample</th><th style={th}>exit reason</th><th style={th}>trades</th><th style={th}>net</th><th style={th}>expectancy</th><th style={th}>avg hold</th><th style={th}>avg shortfall bps</th></tr></thead>
            <tbody>{d.exits.map((r) => <tr key={`${r.strategy_version_id}|${r.variant}|${r.sample}|${r.exit_reason}`}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{r.variant}</td><td style={cell}>{r.sample}</td><td style={cell}>{r.exit_reason}</td><td style={cell}>{r.trades}</td><td style={cell}>{num(r.net_pnl)}</td><td style={cell}>{num(r.expectancy)}</td><td style={cell}>{durationOf(r.average_hold_ms)}</td><td style={cell}>{num(r.average_execution_shortfall_bps, 0)}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Attribution (§19.2) · Q3–Q7, Q10, Q13, Q14, Q20</h2>
        {dims.length === 0 ? <p className="muted">No closed trade to attribute.</p> : dims.map((dim) => {
          const rows = d.attribution.filter((a) => a.dimension === dim);
          if (rows.length === 0) return null;
          return (
            <details key={dim} open={dim === 'session' || dim === 'regime'}>
              <summary>{DIMENSION_LABEL[dim] ?? dim} ({rows.length} group row(s))</summary>
              <table className="mono" style={{ borderCollapse: 'collapse', marginBottom: '0.6rem' }}>
                <thead><tr><th style={th}>strategy</th><th style={th}>group</th><th style={th}>trades</th><th style={th}>net</th><th style={th}>win rate</th><th style={th}>expectancy</th><th style={th}>max DD</th><th style={th}>shortfall bps</th><th style={th}>sample</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={`${r.strategy_version_id}|${r.group_key}`}><td style={cell}>{r.strategy_version_id}</td><td style={cell}>{r.group_key}</td><td style={cell}>{r.trades}</td><td style={cell}>{num(r.net_pnl)}</td><td style={cell}>{pctOf(r.win_rate)}</td><td style={cell}>{num(r.expectancy)}</td><td style={cell}>{num(r.max_drawdown)}</td><td style={cell}>{num(r.execution_shortfall_bps, 0)}</td><td style={cell}>{r.sample_supported ? <span className="chip" data-tone="ok">supported</span> : <span className="chip" data-tone="degraded">under-sampled</span>}</td></tr>)}</tbody>
              </table>
            </details>
          );
        })}
      </section>

      <section className="panel">
        <h2>Action-cycle timeline (simulated time) · {d.decisions.length} decision(s){d.decisions.length >= 500 ? ', first 500 shown' : ''}</h2>
        {d.decisions.length === 0 ? <p className="muted">No decision recorded.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>simulated at</th><th style={th}>sample</th><th style={th}>asset</th><th style={th}>strategy</th><th style={th}>variant</th><th style={th}>cycle</th><th style={th}>verdict</th><th style={th}>reasons</th><th style={th}>latency</th><th style={th}>after decision</th><th style={th}>fill (in → out, shortfall)</th><th style={th}>outcome</th></tr></thead>
              <tbody>
                {d.decisions.map((x) => (
                  <tr key={x.id}>
                    <td style={cell}>{time(x.at)}</td><td style={cell}>{x.sample}</td><td style={cell}>{symbol(x.asset_id)}</td><td style={cell}>{x.strategy_version_id}</td><td style={cell}>{x.variant}</td>
                    <td style={cell}><span className="chip" data-tone={x.cycle_state === 'CLEARED' ? 'ok' : x.cycle_state === 'REJECTED' ? 'failed' : 'degraded'}>{x.cycle_state}</span>{x.action ? ` ${x.action}` : ''}</td>
                    <td style={cell}>{x.adversary_verdict ?? '—'}{x.proposer_confidence !== null ? ` · conf ${num(x.proposer_confidence)}` : ''}</td>
                    <td style={{ ...cell, whiteSpace: 'normal' }}>{x.reason_codes.join(', ') || '—'}</td>
                    <td style={cell}>{durationOf(x.decision_latency_ms)}</td>
                    <td style={cell}>{x.rejection ? <span className="chip" data-tone="degraded">{x.rejection}</span> : x.fill ? 'filled' : x.cycle_state === 'CLEARED' ? 'not attempted' : '—'}</td>
                    <td style={cell}>{x.fill ? `${num(baseToUnits(x.fill.inputAmount, 6))} → ${num(baseToUnits(x.fill.outputAmount, decimals(x.asset_id)), 4)} · ${x.fill.executionShortfallBps === null ? '—' : `${x.fill.executionShortfallBps} bps`}` : '—'}</td>
                    <td style={cell}>{x.outcome ? `${num(baseToUnits(x.outcome.realizedPnlBaseUnits, 6))} · ${x.outcome.exitReason} · held ${durationOf(x.outcome.holdMs)}${x.outcome.targetHit === null ? '' : x.outcome.targetHit ? ' · target hit' : ' · target missed'}` : '—'}</td>
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
