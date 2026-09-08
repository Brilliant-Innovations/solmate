import type { ReactNode } from 'react';
import { ago, baseToUsd, usd } from '../../../../lib/paper';
import { loadCycleInspector, stageLabel, type BaselineView, type CycleInspectorView } from '../../../../lib/cycles';

export const dynamic = 'force-dynamic';

/**
 * Decision / Action Inspector (§20.7): the canonical "why?" screen for one action cycle. A
 * timeline from trigger through evidence cutoffs, proposer, adversary, deterministic risk,
 * authorization hash, signed attempt, chain fill and protection. Every node is labelled either
 * DETERMINISTIC (gate output, risk evaluation, authorization, chain facts) or AI (a model run's
 * claim or objection). Proposer and adversary nodes carry their evidence cutoff version, and a
 * refreshed cycle shows each cutoff and which runs consumed it. The fixed Baseline panel shows
 * what S0_RAW and S0_SAFE decided for the same candidate or position and the realized outcome.
 */
export default async function CycleInspector({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadCycleInspector(id);
  if (!view) {
    return (
      <>
        <h1 style={{ marginTop: 0 }}>Decision / Action Inspector</h1>
        <p className="muted">No action cycle with that id is readable from this session.</p>
        <p><a className="btn" href="/agent-activity">Back to Agent Activity</a></p>
      </>
    );
  }
  const { cycle } = view;
  const now = Date.now();
  return (
    <>
      <h1 style={{ marginTop: 0 }}>
        Decision / Action Inspector <span className="muted">· {cycle.asset?.symbol ?? 'unknown'} · {cycle.strategy_version_id}</span>
      </h1>
      <p className="mono" style={{ margin: '0 0 0.6rem' }}>
        <span className="chip" data-tone={cycle.state === 'CLEARED' ? 'ok' : cycle.state === 'UNRESOLVED' || cycle.state === 'REJECTED' ? 'failed' : cycle.state === 'EXPIRED' ? 'degraded' : 'watch'}><span className="v">{stageLabel(cycle)}</span></span>{' '}
        started {ago(cycle.started_at, now)} · {cycle.speed_tier} · budget {cycle.decision_budget_ms} ms · cycle <span className="muted">{cycle.id}</span>
        {cycle.position_id ? <> · position <a href="/positions">{cycle.position_id.slice(0, 8)}…</a></> : null}
        {' · '}<a href="/agent-activity">all cycles</a>
      </p>
      {cycle.state === 'UNRESOLVED' && (
        <div className="notice" data-tone="failed" role="alert">
          This cycle did not resolve ({cycle.unresolved_reason}). {cycle.position_id ? 'The position stays in deterministic PROTECTION_ONLY until a later cycle clears (§13.7B).' : 'No entry was created.'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(18rem, 2fr)', gap: '1rem', alignItems: 'start' }}>
        <div>
          <Timeline view={view} now={now} />
          <SideBySide view={view} />
        </div>
        <div>
          <Baseline view={view} now={now} />
          <Evidence view={view} />
        </div>
      </div>
    </>
  );
}

const Tag = ({ kind }: { kind: 'DETERMINISTIC' | 'AI' | 'CHAIN' }) => (
  <span className="chip" data-tone={kind === 'AI' ? 'watch' : kind === 'CHAIN' ? 'ok' : 'paper'} style={{ marginRight: '0.4rem' }}>
    <span className="v">{kind}</span>
  </span>
);

function Node({ title, kind, at, now, children }: { title: string; kind: 'DETERMINISTIC' | 'AI' | 'CHAIN'; at?: string | null; now: number; children?: ReactNode }) {
  return (
    <li style={{ margin: '0 0 0.7rem', paddingLeft: '0.9rem', borderLeft: '2px solid var(--rule)' }}>
      <div className="mono">
        <Tag kind={kind} />
        <strong>{title}</strong>
        {at ? <span className="muted"> · {ago(at, now)}</span> : null}
      </div>
      {children ? <div style={{ marginTop: '0.2rem' }}>{children}</div> : null}
    </li>
  );
}

function Timeline({ view, now }: { view: CycleInspectorView; now: number }) {
  const { cycle, proposals, reviews, runs, risk, intent, authorizationHash, attempts, fills, automationRun, position } = view;
  const runById = new Map(runs.map((r) => [r.id, r]));
  const proposerRuns = cycle.proposer_run_ids.map((rid) => runById.get(rid)).filter((r): r is NonNullable<typeof r> => !!r);
  const list = { listStyle: 'none', padding: 0, margin: 0 };
  return (
    <section className="panel">
      <h2>Timeline</h2>
      <ol style={list}>
        <Node title={automationRun ? `Automation fired · ${automationRun.automation_version_id} · ${automationRun.disposition}` : cycle.trigger ? `Trigger · ${cycle.trigger.family}` : cycle.position_id ? 'Trigger · open-position reassessment' : 'Trigger'} kind="DETERMINISTIC" at={automationRun?.created_at ?? cycle.trigger?.discovered_at ?? cycle.started_at} now={now}>
          {automationRun ? <pre className="mono muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(automationRun.trigger_event)}</pre> : null}
        </Node>
        {cycle.cutoffs.map((c, i) => (
          <Node key={c.version} title={`Evidence snapshot · cutoff v${c.version}${i > 0 ? ' (refresh)' : ''}`} kind="DETERMINISTIC" at={c.at} now={now}>
            <span className="muted mono">
              {i > 0 ? `supersedes v${cycle.cutoffs[i - 1]!.version} · ` : ''}
              consumed by {c.consumedByRunIds.length === 0 ? 'no model run (deterministic strategy)' : c.consumedByRunIds.map((r) => runById.get(r)?.role ?? r.slice(0, 8)).join(', ')}
            </span>
          </Node>
        ))}
        {proposals.map((p, i) => {
          const run = proposerRuns[i] ?? null;
          const ai = p.source === 'AI';
          return (
            <Node key={p.id} title={`Proposer${i > 0 ? ' revision' : ''} · ${p.proposal.actionType ?? cycle.proposed_action ?? '?'}${ai && run ? ` · ${run.model}` : ''} · cutoff v${p.proposal.evidenceCutoffVersion ?? '?'}`} kind={ai ? 'AI' : 'DETERMINISTIC'} at={p.created_at} now={now}>
              <div className="mono">
                confidence {typeof p.proposal.confidence === 'number' ? p.proposal.confidence.toFixed(2) : '—'} · urgency {p.proposal.urgency ?? '—'} · expires {ago(p.expires_at, now)}
              </div>
              <div>{p.proposal.thesis}</div>
              {p.proposal.invalidation ? <div className="muted">invalidation: {p.proposal.invalidation}</div> : null}
              {run ? <div className="muted mono">{run.provider}/{run.model} · prompt {run.prompt_version} · {run.latency_ms} ms · ${run.cost_usd.toFixed(4)} · {run.success ? 'schema ok' : 'schema FAILED'}</div> : null}
            </Node>
          );
        })}
        {reviews.map((r) => {
          const run = r.agent_run_id ? runById.get(r.agent_run_id) : undefined;
          const ai = !r.deterministic_gate;
          return (
            <Node key={r.id} title={`Adversary · ${r.verdict}${ai && run ? ` · ${run.model}` : ai ? '' : ' · deterministic gate'} · cutoff v${r.cutoff_version}${r.blocking ? '' : ' · non-blocking (mandatory risk reduction)'}`} kind={ai ? 'AI' : 'DETERMINISTIC'} at={r.created_at} now={now}>
              {r.objections.length === 0 ? (
                <span className="muted">no objections</span>
              ) : (
                <ul style={{ margin: '0.2rem 0 0 1rem', padding: 0 }}>
                  {r.objections.map((o, i) => (
                    <li key={i}><span className="mono">{o.code}</span> — {o.detail}{o.evidenceIds && o.evidenceIds.length > 0 ? <span className="muted mono"> · evidence {o.evidenceIds.map((e) => e.slice(0, 8)).join(', ')}</span> : null}</li>
                  ))}
                </ul>
              )}
              {r.confidence !== null ? <div className="muted mono">confidence {r.confidence.toFixed(2)} · {r.latency_ms} ms</div> : null}
            </Node>
          );
        })}
        {cycle.state === 'REJECTED' && <Node title={`Cycle REJECTED · ${cycle.reason_codes.join(', ') || 'no reason codes'}`} kind="DETERMINISTIC" at={cycle.terminal_at} now={now} />}
        {cycle.state === 'EXPIRED' && <Node title="Cycle EXPIRED before a decision (D32)" kind="DETERMINISTIC" at={cycle.terminal_at} now={now} />}
        {cycle.state === 'UNRESOLVED' && <Node title={`Cycle UNRESOLVED · ${cycle.unresolved_reason}`} kind="DETERMINISTIC" at={cycle.terminal_at} now={now} />}
        {cycle.state === 'CLEARED' && <Node title={`Cycle CLEARED at cutoff v${cycle.cleared_cutoff_version ?? '?'}`} kind="DETERMINISTIC" at={cycle.terminal_at} now={now} />}
        {risk && (
          <Node title={`Risk policy ${risk.policy_version} · ${risk.allowed ? 'ALLOW' : 'DENY'}${risk.computed_position_amount ? ` · ${usd(baseToUsd(risk.computed_position_amount))} max` : ''}`} kind="DETERMINISTIC" at={risk.created_at} now={now}>
            <div className="mono muted">
              {risk.reason_codes.length > 0 ? `${risk.reason_codes.join(', ')} · ` : ''}
              slippage ≤ {risk.max_slippage_bps} bp · impact ≤ {risk.max_price_impact_bps} bp · daily drawdown {(risk.daily_drawdown_fraction * 100).toFixed(2)}%{risk.circuit_breaker_tripped ? ' · CIRCUIT BREAKER TRIPPED' : ''}
              {risk.computed_max_loss_base_units ? ` · max loss ${usd(baseToUsd(risk.computed_max_loss_base_units))}` : ''}
            </div>
            {risk.stale_data_checks.length > 0 && (
              <div className="mono muted">
                freshness: {risk.stale_data_checks.map((s) => `${s.dataClass} ${s.fresh ? 'fresh' : 'STALE'}${s.ageMs !== null ? ` (${Math.round(s.ageMs / 1000)}s / ${Math.round(s.limitMs / 1000)}s)` : ''}`).join(' · ')}
              </div>
            )}
            {risk.stop_policy ? <div className="mono muted">stop: {JSON.stringify(risk.stop_policy)}</div> : null}
          </Node>
        )}
        {intent && (
          <Node title={`Intent · ${intent.action} ${intent.side} · ${intent.lifecycle_state}${intent.approval_required ? ' · approval required' : ''}`} kind="DETERMINISTIC" at={intent.created_at} now={now}>
            <div className="mono muted">max input {intent.max_input_amount} base units · {intent.input_mint.slice(0, 6)}… → {intent.output_mint.slice(0, 6)}… · expires {ago(intent.expires_at, now)}</div>
          </Node>
        )}
        {authorizationHash && <Node title="Authorization hash" kind="DETERMINISTIC" now={now}><span className="mono" style={{ wordBreak: 'break-all' }}>{authorizationHash}</span></Node>}
        {attempts.map((a) => (
          <Node key={a.id} title={`Attempt ${a.attempt_number} · ${a.state}${a.execution_path ? ` · ${a.execution_path}` : ''}${a.router ? ` · ${a.router}` : ''}`} kind={a.signed_at ? 'CHAIN' : 'DETERMINISTIC'} at={a.finalized_at ?? a.confirmed_at ?? a.submitted_at ?? a.signed_at} now={now}>
            <div className="mono muted">
              {a.signed_at ? `signed ${ago(a.signed_at, now)}` : 'not signed'}{a.submitted_at ? ` · submitted ${ago(a.submitted_at, now)}` : ''}{a.confirmed_at ? ` · confirmed ${ago(a.confirmed_at, now)}` : ''}{a.finalized_at ? ` · finalized ${ago(a.finalized_at, now)}` : ''}
              {a.not_landed_reason ? ` · NOT LANDED: ${a.not_landed_reason}` : ''}
              {a.expected_tx_signature ? <div style={{ wordBreak: 'break-all' }}>tx {a.expected_tx_signature}</div> : null}
            </div>
          </Node>
        ))}
        {fills.map((f) => (
          <Node key={f.id} title={`Chain fill · ${f.commitment} · ${f.execution_path}`} kind="CHAIN" at={f.filled_at} now={now}>
            <div className="mono muted">
              in {f.input_amount} → out {f.output_amount} base units{f.execution_shortfall_bps !== null ? ` · shortfall vs quote ${f.execution_shortfall_bps.toFixed(1)} bp` : ' · shortfall not attributed'}
              <div style={{ wordBreak: 'break-all' }}>tx {f.tx_signature}</div>
            </div>
          </Node>
        ))}
        {position && (
          <Node title={`Position · ${position.status} · review ${position.review_state}${position.review_state_reason ? ` (${position.review_state_reason})` : ''}`} kind="DETERMINISTIC" at={position.closed_at} now={now}>
            <div className="mono muted">
              quantity {position.quantity} · unrealized {position.unrealized_pnl_base_units === null ? 'unmarked' : usd(baseToUsd(position.unrealized_pnl_base_units))} · realized {usd(baseToUsd(position.realized_pnl_base_units))}
            </div>
          </Node>
        )}
      </ol>
    </section>
  );
}

function SideBySide({ view }: { view: CycleInspectorView }) {
  const proposal = view.proposals.at(-1) ?? null;
  const review = view.reviews.at(-1) ?? null;
  if (!proposal && !review) return null;
  const col = { flex: '1 1 18rem', minWidth: 0 };
  return (
    <section className="panel">
      <h2>Claim versus objection</h2>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={col}>
          <h3 style={{ margin: '0 0 0.3rem' }}><Tag kind={proposal?.source === 'AI' ? 'AI' : 'DETERMINISTIC'} />Proposer claim</h3>
          {proposal ? (
            <>
              <p style={{ margin: '0 0 0.3rem' }}>{proposal.proposal.thesis}</p>
              {proposal.proposal.reasoningSummary && proposal.proposal.reasoningSummary !== proposal.proposal.thesis ? <p className="muted" style={{ margin: '0 0 0.3rem' }}>{proposal.proposal.reasoningSummary}</p> : null}
              <p className="mono muted" style={{ margin: 0 }}>
                supporting evidence: {(proposal.proposal.supportingEvidenceIds ?? []).length === 0 ? 'none cited' : proposal.proposal.supportingEvidenceIds!.map((e) => e.slice(0, 8)).join(', ')}
                <br />contradicting evidence: {(proposal.proposal.contradictingEvidenceIds ?? []).length === 0 ? 'none cited' : proposal.proposal.contradictingEvidenceIds!.map((e) => e.slice(0, 8)).join(', ')}
              </p>
            </>
          ) : (
            <p className="muted">no proposal</p>
          )}
        </div>
        <div style={col}>
          <h3 style={{ margin: '0 0 0.3rem' }}><Tag kind={review && !review.deterministic_gate ? 'AI' : 'DETERMINISTIC'} />Adversary objection</h3>
          {review ? (
            review.objections.length === 0 ? (
              <p className="muted">{review.verdict} with no objections{review.deterministic_gate ? ' (deterministic gate)' : ''}.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                {review.objections.map((o, i) => (
                  <li key={i}><span className="mono">{o.code}</span> — {o.detail}</li>
                ))}
              </ul>
            )
          ) : (
            <p className="muted">no review</p>
          )}
        </div>
        <div style={col}>
          <h3 style={{ margin: '0 0 0.3rem' }}><Tag kind="DETERMINISTIC" />Risk result</h3>
          {view.risk ? (
            <p className="mono" style={{ margin: 0 }}>
              {view.risk.allowed ? 'ALLOW' : 'DENY'} · {view.risk.policy_version}
              {view.risk.computed_position_amount ? ` · size ${usd(baseToUsd(view.risk.computed_position_amount))}` : ''}
              {view.risk.reason_codes.length > 0 ? <><br />{view.risk.reason_codes.join(', ')}</> : null}
            </p>
          ) : (
            <p className="muted">no risk evaluation (cycle did not clear)</p>
          )}
        </div>
        <div style={col}>
          <h3 style={{ margin: '0 0 0.3rem' }}><Tag kind="CHAIN" />Quote versus fill</h3>
          {view.fills.length === 0 ? (
            <p className="muted">{view.attempts.length === 0 ? 'no execution attempt' : 'no fill recorded'}</p>
          ) : (
            <p className="mono" style={{ margin: 0 }}>
              {view.fills.map((f) => `${f.commitment}: ${f.execution_shortfall_bps === null ? 'shortfall not attributed' : `${f.execution_shortfall_bps.toFixed(1)} bp shortfall`}`).join(' · ')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Baseline({ view, now }: { view: CycleInspectorView; now: number }) {
  const { cycle, baselines } = view;
  const isBaseline = cycle.strategy?.strategy_id === 'S0_RAW' || cycle.strategy?.strategy_id === 'S0_SAFE';
  return (
    <section className="panel">
      <h2>Baseline counterfactual</h2>
      {isBaseline && <p className="muted" style={{ marginTop: 0 }}>This cycle is itself a baseline ({cycle.strategy?.strategy_id}); the other S0 variant for the same target is listed below.</p>}
      {baselines.length === 0 ? (
        <p className="muted">No S0_RAW or S0_SAFE cycle exists for this {cycle.candidate_id ? 'candidate' : 'position'} yet. Baseline and AI strategies see the same candidate set (P9), so a missing baseline row means the baseline has not run for this trigger.</p>
      ) : (
        baselines.map((b) => <BaselineRow key={b.cycle.id} b={b} now={now} />)
      )}
      {cycle.position_id && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Open-position counterfactual (exit at the reassessment mark versus the reviewed HOLD) is computed by the attribution layer after M10; until then the position node above shows realized and current unrealized P&L.
        </p>
      )}
    </section>
  );
}

function BaselineRow({ b, now }: { b: BaselineView; now: number }) {
  const label = b.cycle.strategy?.strategy_id ?? b.cycle.strategy_version_id.split('@')[0];
  return (
    <div className="mono" style={{ borderTop: '1px solid var(--rule)', padding: '0.4rem 0' }}>
      <div>
        <strong>{label}</strong> <span className="muted">{b.cycle.strategy_version_id}</span> · <a href={`/agent-activity/${b.cycle.id}`}>{b.cycle.state}</a> · {b.cycle.proposed_action ?? 'no action'} · {ago(b.cycle.started_at, now)}
      </div>
      {b.cycle.reason_codes.length > 0 && <div className="muted">{b.cycle.reason_codes.join(', ')}</div>}
      <div className="muted">
        {b.intent ? `intent ${b.intent.action} · ${b.intent.lifecycle_state}` : 'no intent'}
        {b.fills.length > 0 ? ` · ${b.fills.length} fill(s)` : ''}
        {b.realized_pnl_base_units !== null ? ` · lot ${b.lot_status} · realized ${usd(baseToUsd(b.realized_pnl_base_units))}` : b.intent ? ' · outcome not yet realized' : ''}
      </div>
    </div>
  );
}

function Evidence({ view }: { view: CycleInspectorView }) {
  const { runs, toolCalls, toolRefusals } = view;
  if (runs.length === 0 && toolCalls.length === 0 && toolRefusals.length === 0) {
    return (
      <section className="panel">
        <h2>Model runs and tools</h2>
        <p className="muted">No model run: this cycle was decided deterministically.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Model runs and tools</h2>
      {runs.map((r) => (
        <div key={r.id} className="mono" style={{ borderTop: '1px solid var(--rule)', padding: '0.4rem 0' }}>
          <div><Tag kind="AI" />{r.role} · {r.provider}/{r.model} · prompt {r.prompt_version} · cutoff v{r.cutoff_version}</div>
          <div className="muted">{r.latency_ms} ms · ${r.cost_usd.toFixed(4)} · {r.success ? 'schema ok' : 'schema FAILED'} · evidence {r.input_evidence_ids.length}</div>
          {r.structured_output ? (
            <details>
              <summary style={{ cursor: 'pointer' }}>structured output</summary>
              <pre style={{ margin: '0.3rem 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(r.structured_output, null, 1)}</pre>
            </details>
          ) : null}
        </div>
      ))}
      {toolCalls.length > 0 && (
        <>
          <h3 style={{ margin: '0.6rem 0 0.2rem' }}>Tool calls ({toolCalls.length})</h3>
          {toolCalls.map((t, i) => (
            <div key={i} className="mono muted">{t.tool_name}@{t.tool_version} · {t.classification} · cutoff v{t.cutoff_version} · {t.latency_ms} ms{t.error ? ` · ERROR ${t.error}` : ''}</div>
          ))}
        </>
      )}
      {toolRefusals.length > 0 && (
        <>
          <h3 style={{ margin: '0.6rem 0 0.2rem' }}>Refused tool calls ({toolRefusals.length})</h3>
          {toolRefusals.map((t, i) => (
            <div key={i} className="mono"><span className="chip" data-tone="failed"><span className="v">{t.reason}</span></span> {t.requested_tool} <span className="muted">— {t.detail}</span></div>
          ))}
        </>
      )}
    </section>
  );
}
