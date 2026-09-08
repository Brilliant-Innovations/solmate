import { ago } from '../../../lib/paper';
import { AUDIT_PAGE_SIZE, loadAuditEvents, loadAuditFacets, loadAuditIntegrity, type AuditEventView } from '../../../lib/audit';

export const dynamic = 'force-dynamic';

type Search = { actor?: string; actionClass?: string; entityType?: string; origin?: string; live?: string; from?: string; to?: string; before?: string };

/**
 * Audit Log (§20.25, §6.22; ADR-0009 P2): who or what changed system behaviour, when and under
 * which authority. Filters by actor, action class, entity type, origin, date range and
 * live-impacting only. Imported executor-journal records keep their original local time next to
 * the import time. The integrity panel shows the chain check, the last checkpoint replicated
 * outside Postgres and the last verification against that replica; a failed or stale
 * verification is a CRITICAL notice here, never a quiet badge.
 */
export default async function AuditLog({ searchParams }: { searchParams: Promise<Search> }) {
  const p = await searchParams;
  const before = p.before ? Number(p.before) : undefined;
  const filters = { actor: p.actor || undefined, actionClass: p.actionClass || undefined, entityType: p.entityType || undefined, origin: p.origin || undefined, liveOnly: p.live === '1', from: p.from || undefined, to: p.to || undefined, before: Number.isFinite(before) ? before : undefined };
  const [events, facets, integrity] = await Promise.all([loadAuditEvents(filters), loadAuditFacets(), loadAuditIntegrity()]);
  const now = Date.now();
  const cell = { padding: '0.25rem 0.8rem 0.25rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const v = integrity.verification;
  const verificationAgeMs = v ? now - Date.parse(v.verified_at) : null;
  const verificationStale = verificationAgeMs !== null && verificationAgeMs > 6 * 3_600_000;
  const integrityBad = (integrity.chain !== null && !integrity.chain.ok) || (v !== null && !v.ok) || verificationStale;
  const nextPage = events.length === AUDIT_PAGE_SIZE ? events[events.length - 1]!.sequence : null;
  const query = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...p, ...over })) if (val) q.set(k, val);
    const s = q.toString();
    return s ? `/audit?${s}` : '/audit';
  };
  const originTone = (o: string) => (o === 'EMERGENCY_JOURNAL_IMPORT' ? 'failed' : o === 'WATCHDOG' ? 'degraded' : 'unknown');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Audit Log</h1>

      {integrityBad && (
        <div className="notice" data-tone="failed" role="alert">
          {integrity.chain && !integrity.chain.ok ? `The audit chain does not verify: first bad sequence ${integrity.chain.first_bad_sequence ?? 'unknown'}. ` : ''}
          {v && !v.ok ? `The last verification against the external checkpoint failed: ${v.reason}${v.detail ? ` (${v.detail})` : ''}. ` : ''}
          {verificationStale ? `The last verification is ${ago(v!.verified_at, now)} old. ` : ''}
          Treat the ledger as unverified until the audit-checkpoint role reports again.
        </div>
      )}

      <section className="panel">
        <h2>Integrity</h2>
        <p className="mono" style={{ margin: '0.2rem 0' }}>
          <span className="chip" data-tone={integrity.chain === null ? 'unknown' : integrity.chain.ok ? 'ok' : 'failed'}><span className="v">{integrity.chain === null ? 'CHAIN UNCHECKED' : integrity.chain.ok ? 'CHAIN OK' : 'CHAIN BROKEN'}</span></span>{' '}
          {integrity.chain ? `${integrity.chain.checked} event(s) verified from genesis` : 'the database chain check did not run'} · head {integrity.head ? `#${integrity.head.sequence} ${ago(integrity.head.at, now)} ${integrity.head.hash.slice(0, 12)}…` : 'empty ledger'}
        </p>
        <p className="mono" style={{ margin: '0.2rem 0' }}>
          <span className="chip" data-tone={integrity.checkpoint ? 'ok' : 'unknown'}><span className="v">{integrity.checkpoint ? 'CHECKPOINT' : 'NO CHECKPOINT'}</span></span>{' '}
          {integrity.checkpoint ? `#${integrity.checkpoint.sequence} ${integrity.checkpoint.hash.slice(0, 12)}… ${ago(integrity.checkpoint.checkpointed_at, now)} · replicated to ${integrity.checkpoint.replicated_to.join(', ') || 'nowhere'}` : 'no checkpoint has been replicated outside the database yet'}
        </p>
        <p className="mono" style={{ margin: '0.2rem 0' }}>
          <span className="chip" data-tone={v === null ? 'unknown' : v.ok && !verificationStale ? 'ok' : 'failed'}><span className="v">{v === null ? 'NOT VERIFIED' : v.ok ? (verificationStale ? 'VERIFIED (STALE)' : 'VERIFIED') : 'VERIFICATION FAILED'}</span></span>{' '}
          {v ? `${ago(v.verified_at, now)} against ${v.replica}${v.checkpoint_sequence !== null ? ` at #${v.checkpoint_sequence}` : ''}${v.head_sequence !== null ? ` (head #${v.head_sequence})` : ''}${v.reason ? ` · ${v.reason}` : ''}` : 'the audit-checkpoint role has not recorded a verification'}
        </p>
        <p className="muted" style={{ margin: '0.3rem 0 0' }}>
          Events are append-only and hash-chained. The checkpoint is replicated outside Postgres so a database-only rewrite cannot recreate the integrity history; the risk-authorizer refuses clearances behind or beyond it.
          {integrity.importsPending !== null ? ` ${integrity.importsPending} executor-journal record(s) imported to date.` : ''}
        </p>
      </section>

      <section className="panel">
        <h2>Filters</h2>
        <form method="get" action="/audit" className="controls" style={{ gap: '0.5rem' }}>
          <select name="actor" defaultValue={p.actor ?? ''} aria-label="actor"><option value="">any actor</option>{facets.actors.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <select name="actionClass" defaultValue={p.actionClass ?? ''} aria-label="action class"><option value="">any action</option>{facets.actionClasses.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <select name="entityType" defaultValue={p.entityType ?? ''} aria-label="entity type"><option value="">any entity</option>{facets.entityTypes.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <select name="origin" defaultValue={p.origin ?? ''} aria-label="origin"><option value="">any origin</option><option value="NORMAL">NORMAL</option><option value="EMERGENCY_JOURNAL_IMPORT">EMERGENCY_JOURNAL_IMPORT</option><option value="WATCHDOG">WATCHDOG</option></select>
          <input type="datetime-local" name="from" defaultValue={p.from ?? ''} aria-label="from" />
          <input type="datetime-local" name="to" defaultValue={p.to ?? ''} aria-label="to" />
          <label className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" name="live" value="1" defaultChecked={p.live === '1'} /> live-impacting only</label>
          <button className="btn" type="submit">Apply</button>
          <a className="btn" href="/audit">Clear</a>
        </form>
      </section>

      <section className="panel">
        <h2>Events {before ? `before #${before}` : ''} ({events.length})</h2>
        {events.length === 0 ? (
          <p className="muted">No events match.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['#', 'at', 'actor', 'action', 'entity', 'origin', 'live', 'authority', 'change'].map((h) => (
                    <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.sequence} style={{ borderTop: '1px solid var(--rule)' }}>
                    <td style={cell}>{e.sequence}</td>
                    <td style={cell}>
                      {ago(e.at, now)}
                      {e.origin === 'EMERGENCY_JOURNAL_IMPORT' && e.original_local_at ? <div className="muted">local {new Date(e.original_local_at).toISOString().replace('T', ' ').slice(0, 19)} · imported {e.imported_at ? ago(e.imported_at, now) : '—'}</div> : null}
                    </td>
                    <td style={cell}>{e.actor}<div className="muted" style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.actor_ref}</div></td>
                    <td style={cell}>{e.action_class}</td>
                    <td style={cell}>{e.entity?.type ?? '—'}<div className="muted" style={{ maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.entity?.id ?? ''}</div></td>
                    <td style={cell}><span className="chip" data-tone={originTone(e.origin)}><span className="v">{e.origin}</span></span></td>
                    <td style={cell}>{e.live_impacting ? 'LIVE' : '—'}</td>
                    <td style={cell}>{e.authority_evidence ?? '—'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', minWidth: '18rem' }}><Change e={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="controls" style={{ marginTop: '0.6rem' }}>
          {before ? <a className="btn" href={query({ before: undefined })}>Newest</a> : null}
          {nextPage !== null ? <a className="btn" href={query({ before: String(nextPage) })}>Older than #{nextPage}</a> : null}
        </p>
      </section>
    </>
  );
}

function Change({ e }: { e: AuditEventView }) {
  const short = (o: Record<string, unknown> | null) => (o ? JSON.stringify(o) : null);
  const before = short(e.before_summary);
  const after = short(e.after_summary);
  if (!before && !after) return <span className="muted">—</span>;
  const preview = (after ?? before ?? '').slice(0, 96);
  return (
    <details>
      <summary style={{ cursor: 'pointer' }}>{preview}{(after ?? before ?? '').length > 96 ? '…' : ''}</summary>
      {before && <pre style={{ margin: '0.3rem 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>before: {before}</pre>}
      {after && <pre style={{ margin: '0.3rem 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>after: {after}</pre>}
      <div className="muted">hash {e.hash}</div>
    </details>
  );
}
