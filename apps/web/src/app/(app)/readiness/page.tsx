import { AUTOMATED_DRILL_ROWS, TINY_LIVE_ROW_SET } from '@sol-agent-trader/contracts';
import { StepUpRequest } from '../../../components/step-up-request';
import { ago } from '../../../lib/paper';
import { loadControlRequests, loadReadiness, loadReadinessVerdicts } from '../../../lib/ops';
import { loadMyPasskeys } from '../../../lib/settings';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestExecuteDrill, requestReadinessEvidence } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Live Readiness (§20.28, §29; ADR-0004 row set; ADR-0010 deployment binding). The §29 gate as a
 * persistent screen: distinct READY FOR LIVE_APPROVAL and READY FOR LIVE_AUTO verdicts per strategy
 * class, every row as PASS / FAIL / STALE / NOT RUN with its evidence link, last verified time and
 * expiry. A FAIL blocks the relevant arming through the same verdict the approvals role reads; the
 * screen never computes readiness itself. Drill and probe evidence is recorded with a passkey
 * step-up; the automatable drills (M11) run in the worker from `Run drill` and record their own verdict with a transcript.
 */
export default async function Readiness() {
  const now = Date.now();
  const [{ verdict, rows }, verdicts, requests, operator] = await Promise.all([loadReadiness(), loadReadinessVerdicts(), loadControlRequests(['RUN_READINESS_DRILL', 'EXECUTE_READINESS_DRILL'], 15), getOperatorSession()]);
  const passkeys = await loadMyPasskeys(operator?.userId ?? null);
  const canRequest = operator?.aal === 'aal2' && (operator.role === 'operator' || operator.role === 'admin');
  const rpId = process.env['NEXT_PUBLIC_WEBAUTHN_RP_ID'] ?? null;
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const tone = (v: string) => (v === 'PASS' || v === 'READY' ? 'ok' : v === 'NOT_APPLICABLE' ? 'unknown' : v === 'STALE' || v === 'UNKNOWN' ? 'degraded' : v === 'NOT_RUN' ? 'unknown' : 'failed');
  const byId = new Map(rows.map((r) => [r.row_id, r] as const));
  const evidenceSpecs = TINY_LIVE_ROW_SET.filter((s) => s.kind !== 'COMPUTED');
  const label = (name: string) => (name === 'READY_FOR_ATTENDED_TINY_LIVE' ? 'READY FOR LIVE_APPROVAL (attended tiny live)' : name === 'READY_FOR_UNATTENDED_LIVE_PILOT' ? 'READY FOR LIVE_AUTO (unattended pilot)' : 'READY FOR LIVE_AUTO (hardened)');
  const state = (rowVerdict: string, evaluatedAt: string | null, expiresAt: string | null | undefined): string => {
    if (!evaluatedAt && rowVerdict !== 'NOT_APPLICABLE') return 'NOT_RUN';
    if (rowVerdict === 'PASS' && expiresAt && Date.parse(expiresAt) < now) return 'STALE';
    return rowVerdict;
  };
  const automated = new Set<string>(AUTOMATED_DRILL_ROWS);
  const canRunDrill = operator?.role === 'admin';
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Live Readiness</h1>
      <section className="panel">
        <h2>Verdicts</h2>
        {verdicts.length === 0 ? (
          <p className="muted">No readiness verdict recorded: the worker's readiness role has not run against this database.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['verdict', 'strategy class', 'profile', 'result', 'release', 'computed', 'missing / stale / failed'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              {verdicts.map((v) => (
                <tr key={v.id}>
                  <td style={cell}>{label(v.name)}</td>
                  <td style={cell}>{v.strategy_class}</td>
                  <td style={cell}>{v.profile}</td>
                  <td style={cell}><span className="chip" data-tone={tone(v.verdict)}><span className="v">{v.verdict}</span></span></td>
                  <td style={cell} className="muted">{v.release_id ? v.release_id.slice(0, 8) : 'none'}</td>
                  <td style={cell}>{ago(v.computed_at, now)}</td>
                  <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{v.missing.length} missing · {v.stale.length} stale · {v.failed.length} failed{v.failed.length ? ` (${v.failed.join(', ')})` : ''}{v.stale.length ? ` · stale: ${v.stale.join(', ')}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {verdict && (
          <p className="muted" style={{ margin: '0.5rem 0 0' }}>
            Latest binding: Release <span className="mono">{verdict.release_id ?? 'none'}</span> · commit <span className="mono">{verdict.binding.gitSha ?? '?'}</span> · contract set <span className="mono">{(verdict.binding.contractSetDigest ?? '?').slice(0, 12)}…</span> · wallet <span className="mono">{verdict.binding.tradingWallet ?? 'none'}</span> · {verdict.binding.cluster ?? '?'} · capabilities {verdict.enabled_capabilities.join(', ') || 'none'}
            {verdict.not_applicable.includes('TRIGGER_LIFECYCLE') ? ' · provider protection disabled: Profile 2 is MONITORED_EXIT-only (ADR-0004)' : ''}. A green verdict for the deterministic class is never clearance for an LLM strategy (ADR-0004). Arming reads these verdicts; a FAIL blocks it.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Gate items</h2>
        {!verdict ? (
          <p className="muted">No rows.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['item', 'kind', 'required', 'state', 'reason', 'last verified', 'expires', 'evidence', 'recorded by'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr>
              </thead>
              <tbody>
                {verdict.rows.map((r) => {
                  const row = byId.get(r.rowId);
                  const st = state(r.verdict, r.evaluatedAt, row?.expires_at);
                  const ev = row?.evidence_ref ?? null;
                  return (
                    <tr key={r.rowId}>
                      <td style={cell}>{r.rowId}</td>
                      <td style={cell}>{r.kind}</td>
                      <td style={cell}>{r.required ? 'yes' : 'no'}</td>
                      <td style={cell}><span className="chip" data-tone={tone(st)}><span className="v">{st.replace('_', ' ')}</span></span></td>
                      <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{r.reason ?? (row?.detail?.['reason'] as string | undefined) ?? ''}</td>
                      <td style={cell}>{r.evaluatedAt ? ago(r.evaluatedAt, now) : 'never'}</td>
                      <td style={cell}>{row?.expires_at ? (Date.parse(row.expires_at) < now ? <span style={{ color: 'var(--degraded)' }}>expired {ago(row.expires_at, now)}</span> : `in ${Math.round((Date.parse(row.expires_at) - now) / 3_600_000)}h`) : '—'}</td>
                      <td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{ev ? (/^https?:\/\//.test(ev) ? <a href={ev} target="_blank" rel="noreferrer">{ev.slice(0, 48)}{ev.length > 48 ? '…' : ''}</a> : ev) : ''}</td>
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
        <h2>Record drill / probe evidence (step-up)</h2>
        <p className="muted">
          Drills run in the target environment and probes from the isolated environment; the result is recorded here against the current binding, and any change to commit, contract set, policy, wallet, cluster or Release invalidates it (ADR-0010). <span className="mono">Run drill</span> executes the automatable drills ({[...automated].join(', ')}) in the worker: the alert drill raises, delivers, escalates and resolves a CRITICAL drill alert; the executor drills plan a DB-independent close from the shadow and audit the journal for SIGNED before SUBMITTED. The worker records PASS or FAIL with the transcript as evidence; SIGNER_OUTAGE_DRILL and the break-glass drill stay manual because they need the isolated environment.
        </p>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {evidenceSpecs.filter((s) => s.kind !== 'CI_EVIDENCE').map((s) => (
            <div key={s.rowId} className="controls" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <span className="mono" style={{ minWidth: '18rem' }}>{s.rowId} <span className="muted">({s.kind})</span></span>
              <StepUpRequest kind="RUN_READINESS_DRILL" payload={{ rowId: s.rowId, kind: s.kind, verdict: 'PASS', evidenceRef: null, detail: {}, source: 'readiness' }} label="Record PASS" passkeys={passkeys} rpId={rpId} disabled={!canRequest} title={s.description} />
              <StepUpRequest kind="RUN_READINESS_DRILL" payload={{ rowId: s.rowId, kind: s.kind, verdict: 'FAIL', evidenceRef: null, detail: {}, source: 'readiness' }} label="Record FAIL" passkeys={passkeys} rpId={rpId} disabled={!canRequest} danger title={s.description} />
              {automated.has(s.rowId) ? (
                <form action={requestExecuteDrill}>
                  <input type="hidden" name="rowId" value={s.rowId} />
                  <button className="btn" type="submit" disabled={!canRunDrill} title="Executes the drill in the worker and records its verdict (admin)">Run drill</button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
        <h3 style={{ margin: '0.8rem 0 0.3rem' }}>CI evidence (fast, no step-up)</h3>
        <form action={requestReadinessEvidence} className="mono controls" style={{ gap: '0.5rem' }}>
          <select name="rowId" required>{evidenceSpecs.filter((s) => s.kind === 'CI_EVIDENCE').map((s) => <option key={s.rowId} value={s.rowId}>{s.rowId}</option>)}</select>
          <input type="hidden" name="kind" value="CI_EVIDENCE" />
          <select name="verdict" required><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="NOT_APPLICABLE">NOT_APPLICABLE</option></select>
          <input name="evidenceRef" placeholder="CI run URL" style={{ minWidth: '20rem' }} />
          <input name="note" placeholder="note (optional)" />
          <button className="btn" type="submit" disabled={!canRequest}>Record CI evidence</button>
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
