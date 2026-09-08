import { ago } from '../../../lib/paper';
import { CYCLE_PAGE_SIZE, loadCycleFacets, loadCycles, loadUnreviewedPositions, stageLabel, type CycleStatusFilter, type CycleView } from '../../../lib/cycles';

export const dynamic = 'force-dynamic';

type Search = { status?: string; strategy?: string; action?: string; agreement?: string; token?: string; result?: string; fail?: string };

/**
 * Agent Activity / Action Queue (§20.6): autonomy as a state machine. One row per action cycle,
 * including open-position HOLD / EXIT reassessments, with trigger, stage, proposer claim,
 * adversary verdict and expiry. Positions whose review state is not REVIEWED are listed first as
 * `PROTECTION_ONLY (unreviewed)` or `BUDGET_PAUSED` (§13.7B). Filters: active/completed/failed,
 * strategy, action type, proposer/adversary agreement, token, result, and the reason a cycle
 * failed to clear. Every row drills into the Decision / Action Inspector.
 */
export default async function AgentActivity({ searchParams }: { searchParams: Promise<Search> }) {
  const p = await searchParams;
  const status = (['active', 'completed', 'failed'].includes(p.status ?? '') ? p.status : '') as CycleStatusFilter;
  const agreement = p.agreement === 'agree' || p.agreement === 'disagree' ? p.agreement : '';
  const [cycles, facets, unreviewed] = await Promise.all([
    loadCycles({ status, strategy: p.strategy || undefined, action: p.action || undefined, agreement, token: p.token || undefined, result: p.result || undefined, failReason: p.fail || undefined }),
    loadCycleFacets(),
    loadUnreviewedPositions(),
  ]);
  const now = Date.now();
  const cell = { padding: '0.3rem 0.8rem 0.3rem 0', verticalAlign: 'top' as const };
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Agent Activity</h1>

      {unreviewed.length > 0 && (
        <div className="notice" data-tone="failed" role="alert">
          {unreviewed.length} open position(s) without a cleared review:{' '}
          {unreviewed.map((u) => `${u.symbol} ${u.review_state === 'PROTECTION_ONLY' ? 'PROTECTION_ONLY (unreviewed)' : u.review_state}${u.review_state_reason ? ` · ${u.review_state_reason}` : ''} · ${ago(u.review_state_since, now)}`).join('; ')}.
          Deterministic protection only applies until a cycle clears (§13.7B).
        </div>
      )}

      <section className="panel">
        <h2>Filters</h2>
        <form method="get" action="/agent-activity" className="controls" style={{ gap: '0.5rem' }}>
          <select name="status" defaultValue={status} aria-label="status">
            <option value="">active + completed</option>
            <option value="active">active</option>
            <option value="completed">completed (CLEARED)</option>
            <option value="failed">failed to clear</option>
          </select>
          <select name="strategy" defaultValue={p.strategy ?? ''} aria-label="strategy"><option value="">any strategy</option>{facets.strategies.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <select name="action" defaultValue={p.action ?? ''} aria-label="action type"><option value="">any action</option>{facets.actions.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <select name="agreement" defaultValue={agreement} aria-label="agreement">
            <option value="">any verdict</option>
            <option value="agree">proposer/adversary agree (CONFIRM)</option>
            <option value="disagree">disagree (CHALLENGE / REJECT)</option>
          </select>
          <select name="result" defaultValue={p.result ?? ''} aria-label="result">
            <option value="">any result</option>
            {['CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED', 'PROPOSED', 'REVISION_REQUESTED', 'TRIGGERED', 'CONTEXT_BUILT'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select name="fail" defaultValue={p.fail ?? ''} aria-label="failure reason"><option value="">any failure reason</option>{facets.failReasons.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <input className="mono" name="token" defaultValue={p.token ?? ''} placeholder="token symbol or mint" aria-label="token" />
          <button className="btn" type="submit">Apply</button>
          <a className="btn" href="/agent-activity">Clear</a>
        </form>
        <p className="muted" style={{ margin: '0.4rem 0 0' }}>Capital authority is per session, not per cycle; the status bar shows PAPER / LIVE. Replay cycles appear here only when a replay run wrote them (M10).</p>
      </section>

      <section className="panel">
        <h2>Cycles ({cycles.length}{cycles.length === CYCLE_PAGE_SIZE ? ', newest page' : ''})</h2>
        {cycles.length === 0 ? (
          <p className="muted">No action cycles match.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  {['started', 'token · strategy', 'trigger', 'stage', 'proposer', 'adversary', 'expires / ended', 'result'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left', whiteSpace: 'nowrap' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cycles.map((c) => (
                  <Row key={c.id} c={c} now={now} cell={cell} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Row({ c, now, cell }: { c: CycleView; now: number; cell: Record<string, string> }) {
  const stage = stageLabel(c);
  const stageTone = c.position_review && c.position_review.review_state !== 'REVIEWED' ? 'failed' : c.state === 'CLEARED' ? 'ok' : c.state === 'UNRESOLVED' || c.state === 'REJECTED' ? 'failed' : c.state === 'EXPIRED' ? 'degraded' : 'watch';
  const verdictTone = c.verdict === 'CONFIRM' ? 'ok' : c.verdict === 'CHALLENGE' ? 'degraded' : c.verdict === 'REJECT' ? 'failed' : 'unknown';
  const objections = c.review?.objections ?? [];
  const terminal = c.terminal_at !== null;
  const expiry = c.proposal?.expires_at ?? null;
  const expiresText = terminal ? `ended ${ago(c.terminal_at, now)}` : expiry ? (Date.parse(expiry) > now ? `expires in ${Math.round((Date.parse(expiry) - now) / 1000)}s` : `expired ${ago(expiry, now)}`) : `budget ${c.decision_budget_ms} ms`;
  const nowrap = { ...cell, whiteSpace: 'nowrap' };
  return (
    <tr style={{ borderTop: '1px solid var(--rule)' }}>
      <td style={nowrap}>
        <a href={`/agent-activity/${c.id}`}>{ago(c.started_at, now)}</a>
        <div className="muted">{c.speed_tier}</div>
      </td>
      <td style={nowrap}>
        <strong>{c.asset?.symbol ?? 'unknown'}</strong> <span className="muted">{c.position_id ? 'position' : 'candidate'}</span>
        <div className="muted">{c.strategy_version_id}</div>
      </td>
      <td style={cell}>{c.trigger ? c.trigger.family : c.position_id ? 'reassessment' : '—'}</td>
      <td style={nowrap}>
        <span className="chip" data-tone={stageTone}><span className="v">{stage}</span></span>
        {c.revision_round > 0 && <div className="muted">revision {c.revision_round} · cutoff v{c.cutoffs.at(-1)?.version ?? '?'}</div>}
      </td>
      <td style={{ ...cell, minWidth: '14rem' }}>
        {c.proposed_action ? (
          <>
            {c.proposed_action}
            {c.proposal && Number.isFinite(c.proposal.confidence) ? ` · confidence ${c.proposal.confidence.toFixed(2)}` : ''}
            <div className="muted">{c.proposal?.source === 'AI' ? 'AI interpretation' : 'deterministic'}{c.proposal?.thesis ? ` · ${c.proposal.thesis.slice(0, 80)}${c.proposal.thesis.length > 80 ? '…' : ''}` : ''}</div>
          </>
        ) : (
          <span className="muted">no proposal yet</span>
        )}
      </td>
      <td style={{ ...cell, minWidth: '14rem' }}>
        {c.verdict ? (
          <>
            <span className="chip" data-tone={verdictTone}><span className="v">{c.verdict}</span></span>{' '}
            <span className="muted">{c.review?.deterministic_gate ? 'deterministic gate' : 'AI adversary'}{c.review && !c.review.blocking ? ' · non-blocking' : ''}</span>
            {objections.length > 0 && <div className="muted">{objections.map((o) => o.code).join(', ')}</div>}
          </>
        ) : (
          <span className="muted">no verdict</span>
        )}
      </td>
      <td style={nowrap}>{expiresText}</td>
      <td style={cell}>
        {c.state}
        {c.reason_codes.length > 0 && <div className="muted">{c.reason_codes.join(', ')}</div>}
      </td>
    </tr>
  );
}
