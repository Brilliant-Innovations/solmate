import { TINY_LIVE_ROW_SET } from '@sol-agent-trader/contracts';
import { ago } from '../../../lib/paper';
import { loadControlRequests, loadReadiness } from '../../../lib/ops';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestReadinessEvidence } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Live Readiness (§20.28, §29; ADR-0004 row set; ADR-0010 deployment binding). Shows the verdict
 * the worker computed, the strategy class it was computed for, every row with its reason, and the
 * binding the rows are valid against. A FAIL here blocks arming through the same verdict the
 * approvals role reads; the screen never computes readiness itself.
 */
export default async function Readiness() {
  const [{ verdict, rows }, requests, operator] = await Promise.all([loadReadiness(), loadControlRequests(['RUN_READINESS_DRILL'], 15), getOperatorSession()]);
  const canRequest = operator?.role === 'operator' || operator?.role === 'admin';
  const now = Date.now();
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const };
  const tone = (v: string) => (v === 'PASS' || v === 'READY' ? 'ok' : v === 'NOT_APPLICABLE' ? 'unknown' : v === 'UNKNOWN' ? 'degraded' : 'failed');
  const byId = new Map(rows.map((r) => [r.row_id, r] as const));
  const evidenceSpecs = TINY_LIVE_ROW_SET.filter((s) => s.kind !== 'COMPUTED');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Live Readiness</h1>
      <section className="panel">
        <h2>Verdict</h2>
        {!verdict ? (
          <p className="muted">No readiness verdict recorded: the worker's readiness role has not run against this database.</p>
        ) : (
          <>
            <p className="mono">
              <span className="chip" data-tone={tone(verdict.verdict)}><span className="k">{verdict.name}</span><span className="v">{verdict.verdict}</span></span>{' '}
              <span className="chip" data-tone="unknown"><span className="k">strategy class</span><span className="v">{verdict.strategy_class}</span></span>{' '}
              <span className="chip" data-tone="unknown"><span className="k">profile</span><span className="v">{verdict.profile}</span></span>{' '}
              <span className="chip" data-tone="unknown"><span className="k">computed</span><span className="v">{ago(verdict.computed_at, now)}</span></span>
            </p>
            <p className="muted">
              Release <span className="mono">{verdict.release_id ?? 'none'}</span> · commit <span className="mono">{verdict.binding.gitSha ?? '?'}</span> · contract set <span className="mono">{(verdict.binding.contractSetDigest ?? '').slice(0, 16)}…</span> · wallet{' '}
              <span className="mono">{verdict.binding.tradingWallet ?? 'none'}</span> · {verdict.binding.cluster ?? '?'} · capabilities {verdict.enabled_capabilities.join(', ') || 'none'}
            </p>
            <p className="muted">
              {verdict.missing.length} missing · {verdict.stale.length} stale · {verdict.failed.length} failed · {verdict.not_applicable.length} not applicable
              {verdict.not_applicable.includes('TRIGGER_LIFECYCLE') ? ' · provider protection disabled: Profile 2 is MONITORED_EXIT-only (ADR-0004)' : ''}
            </p>
            <p className="muted">A green verdict for the deterministic class is never clearance for an LLM strategy (ADR-0004 scope rule). Arming reads this verdict; a FAIL blocks it.</p>
          </>
        )}
      </section>
      <section className="panel">
        <h2>Rows</h2>
        {!verdict ? (
          <p className="muted">No rows.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['row', 'kind', 'required', 'verdict', 'reason', 'evaluated', 'evidence', 'recorded by'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {verdict.rows.map((r) => {
                  const row = byId.get(r.rowId);
                  return (
                    <tr key={r.rowId}>
                      <td style={cell}>{r.rowId}</td>
                      <td style={cell}>{r.kind}</td>
                      <td style={cell}>{r.required ? 'yes' : 'no'}</td>
                      <td style={cell}><span className="chip" data-tone={tone(r.verdict)}><span className="v">{r.verdict}</span></span></td>
                      <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{r.reason ?? (row?.detail?.['reason'] as string | undefined) ?? ''}</td>
                      <td style={cell}>{r.evaluatedAt ? ago(r.evaluatedAt, now) : 'never'}</td>
                      <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{row?.evidence_ref ?? ''}</td>
                      <td style={cell} className="muted">{row?.recorded_by ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Record evidence</h2>
        <p className="muted">
          Drills run in the target environment, probes and CI runs are recorded against the current binding; any change to commit, contract set, policy, wallet, cluster or Release invalidates them (ADR-0010). A PASS is recorded by an admin
          with an evidence reference; drills and probes also need a passkey step-up on the request, which the worker checks before it records the row.
        </p>
        <form action={requestReadinessEvidence} className="mono" style={{ display: 'grid', gap: '0.5rem', maxWidth: '40rem' }}>
          <label>
            row{' '}
            <select name="rowId" required>
              {evidenceSpecs.map((s) => (
                <option key={s.rowId} value={s.rowId}>{s.rowId} ({s.kind})</option>
              ))}
            </select>
          </label>
          <label>
            kind{' '}
            <select name="kind" required>
              <option value="DRILL">DRILL</option>
              <option value="PROBE">PROBE</option>
              <option value="CI_EVIDENCE">CI_EVIDENCE</option>
            </select>
          </label>
          <label>
            verdict{' '}
            <select name="verdict" required>
              <option value="PASS">PASS</option>
              <option value="FAIL">FAIL</option>
              <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
            </select>
          </label>
          <label>
            evidence reference <input name="evidenceRef" placeholder="CI run URL, drill record, probe result file" style={{ width: '100%' }} />
          </label>
          <label>
            note <input name="note" placeholder="optional" style={{ width: '100%' }} />
          </label>
          <button className="btn" type="submit" disabled={!canRequest} title="Creates a RUN_READINESS_DRILL control request; the readiness role records the row after role and step-up checks">
            RECORD EVIDENCE
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Recent evidence requests</h2>
        {requests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {requests.map((r) => (
              <li key={r.id}>
                {String(r.payload['rowId'] ?? '?')} · {String(r.payload['verdict'] ?? '?')} · {r.state} · {ago(r.created_at, now)}
                {r.resolution ? <span className="muted"> · {String(r.resolution['reason'] ?? r.resolution['readinessRowId'] ?? '')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
