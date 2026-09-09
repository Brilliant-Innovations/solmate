import Link from 'next/link';
import { DEFAULT_REPLAY_COST_MODEL } from '@sol-agent-trader/contracts';
import { When } from '../../../components/when';
import { FIDELITY_LABEL, listReplayRuns, listStrategyVersionOptions, statusTone } from '../../../lib/replay';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestRunReplay } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Replay Lab (§20.15, §18). Files replay runs as RUN_REPLAY control requests the worker's replay
 * role binds to every current version and executes under the simulated clock, and lists the
 * immutable record of every run. Simulated time is labelled on every surface: a replay never
 * looks like live trading and never touches capital (FAST control, D41).
 */
export default async function ReplayLab() {
  const now = Date.now();
  const [runs, versions, operator] = await Promise.all([listReplayRuns(), listStrategyVersionOptions(), getOperatorSession()]);
  const canFile = operator?.role === 'operator' || operator?.role === 'admin';
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const cost = DEFAULT_REPLAY_COST_MODEL;
  const dayAgo = new Date(now - 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 16);
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Replay Lab</h1>
      <p className="notice" role="note" style={{ fontWeight: 600 }}>SIMULATED TIME — every figure on this page comes from a replay over recorded data. Nothing here is live trading, and a replay cannot touch capital.</p>

      <section className="panel">
        <h2>File a replay run</h2>
        <form action={requestRunReplay} className="form" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))', gap: '0.6rem', alignItems: 'end' }}>
          <label>Name<br /><input className="mono" name="name" required maxLength={120} placeholder="S0 gate value, week 1" disabled={!canFile} style={{ width: '100%' }} /></label>
          <label>Fidelity (provider-data subset)<br />
            <select name="fidelity" defaultValue="B_CAPTURED" disabled={!canFile} style={{ width: '100%' }}>
              <option value="B_CAPTURED">{FIDELITY_LABEL.B_CAPTURED} — candles, eligibility, captured quote probes, recorded S1 cycles</option>
              <option value="A_HISTORICAL">{FIDELITY_LABEL.A_HISTORICAL} — candles and eligibility only, impact modelled</option>
            </select>
          </label>
          <label>From (UTC)<br /><input type="datetime-local" name="from" required defaultValue={iso(new Date(dayAgo.setUTCHours(0, 0, 0, 0)))} disabled={!canFile} style={{ width: '100%' }} /></label>
          <label>To (UTC, not in the future)<br /><input type="datetime-local" name="to" required defaultValue={iso(new Date(new Date(now).setUTCHours(0, 0, 0, 0)))} disabled={!canFile} style={{ width: '100%' }} /></label>
          <label>Forward hold-out from (UTC, optional)<br /><input type="datetime-local" name="holdout" disabled={!canFile} style={{ width: '100%' }} /></label>
          <label>Seed<br /><input type="number" name="seed" min={0} step={1} defaultValue={0} disabled={!canFile} style={{ width: '100%' }} /></label>
          <fieldset style={{ gridColumn: '1 / -1', border: '1px solid var(--line, #ccc)', padding: '0.5rem 0.8rem' }}>
            <legend>Strategy versions (baseline and AI run against the same timeline)</legend>
            {versions.length === 0 ? <p className="muted">No strategy versions registered; the worker registers them on start.</p> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.8rem' }}>
              {versions.map((v) => (
                <label key={v.version_id} className="mono">
                  <input type="checkbox" name="strategy" value={v.version_id} defaultChecked={v.strategy_id === 'S0_RAW' || v.strategy_id === 'S0_SAFE'} disabled={!canFile} /> {v.version_id} <span className="chip" data-tone={v.status === 'RETIRED' ? 'off' : 'paper'}>{v.status}</span> <span className="muted">{v.speed_tier} · budget {v.max_decision_latency_ms} ms</span>
                </label>
              ))}
            </div>
            <label style={{ display: 'block', marginTop: '0.5rem' }}>Baseline<br />
              <select name="baseline" disabled={!canFile}>
                {versions.map((v) => <option key={v.version_id} value={v.version_id} selected={v.strategy_id === 'S0_RAW'}>{v.version_id}</option>)}
              </select>
            </label>
          </fieldset>
          <label>Universe (asset ids, comma-separated; blank = every asset with candles in the window)<br /><input className="mono" name="assets" placeholder="blank = whole captured universe" disabled={!canFile} style={{ width: '100%' }} /></label>
          <label><input type="checkbox" name="latencyMatched" defaultChecked disabled={!canFile} /> Latency-matched baseline (the baseline also decided at the slowest AI budget)</label>
          <label><input type="checkbox" name="proposerOnly" defaultChecked disabled={!canFile} /> Proposer-only shadow beside proposer + adversary (recorded S1 cycles)</label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="btn" type="submit" disabled={!canFile}>File replay run</button>
            {!canFile ? <span className="muted" style={{ marginLeft: '0.6rem' }}>Filing needs the operator role.</span> : null}
          </div>
        </form>
        <table className="mono" style={{ borderCollapse: 'collapse', marginTop: '0.8rem' }}><tbody>
          <tr><td style={cell} className="muted">initial capital</td><td style={cell}>the worker&apos;s paper starting capital, one isolated book per strategy (same capital for every strategy)</td></tr>
          <tr><td style={cell} className="muted">cost model</td><td style={{ ...cell, whiteSpace: 'normal' }}>{cost.version}: paper fill {cost.fill.version} (router {cost.fill.fees.routerBps} bps, network {cost.fill.fees.networkLamports} + priority {cost.fill.fees.priorityLamports} lamports, submission delay {cost.fill.submissionDelayMs} ms); adverse-execution allowance by path {Object.entries(cost.fill.adverseAllowanceBpsByPath).map(([p, b]) => `${p} ${b} bps`).join(', ')}; decision latency {cost.decisionLatencyMs} ms; candle availability lag {cost.candleAvailabilityLagMs} ms; modelled execution failure rate {(cost.executionFailureRate * 100).toFixed(1)}% (seeded); path {cost.executionPath}</td></tr>
          <tr><td style={cell} className="muted">versions bound</td><td style={{ ...cell, whiteSpace: 'normal' }}>the worker records git SHA, contract-set digest, feature engine, risk / gate / cost-model versions, prompt versions, model selections with training-cutoff disclosure and the dataset cutoff of the moment the request is accepted (§18.5); model substitution experiments need a new strategy version, never an edit</td></tr>
        </tbody></table>
      </section>

      <section className="panel">
        <h2>Runs ({runs.length})</h2>
        {runs.length === 0 ? (
          <p className="muted">No replay runs yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={cell}>status</th><th style={cell}>name</th><th style={cell}>fidelity</th><th style={cell}>window (simulated)</th><th style={cell}>hold-out from</th><th style={cell}>strategies</th><th style={cell}>seed</th><th style={cell}>filed</th><th style={cell}>digest</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={cell}><span className="chip" data-tone={statusTone(r.status)}>{r.status}</span></td>
                    <td style={cell}><Link href={`/replay/${r.id}`}>{r.name}</Link>{r.error ? <span className="muted"> · {r.error.slice(0, 80)}</span> : null}</td>
                    <td style={cell}>{FIDELITY_LABEL[r.fidelity]}</td>
                    <td style={cell}>{r.window_from.slice(0, 16).replace('T', ' ')} → {r.window_to.slice(0, 16).replace('T', ' ')} UTC</td>
                    <td style={cell}>{r.in_sample_until ? r.in_sample_until.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal' }}>{r.strategy_version_ids.map((s) => <span key={s} className="chip" data-tone={s === r.baseline_strategy_version_id ? 'watch' : 'paper'} style={{ marginRight: '0.3rem' }}>{s}{s === r.baseline_strategy_version_id ? ' · baseline' : ''}</span>)}</td>
                    <td style={cell}>{r.seed}</td>
                    <td style={cell}><When iso={r.created_at} now={now} /></td>
                    <td style={cell}>{r.decisions_digest ? r.decisions_digest.slice(0, 12) : '—'}</td>
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
