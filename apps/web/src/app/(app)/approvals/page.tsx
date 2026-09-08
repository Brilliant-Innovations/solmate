import { ago, tokens } from '../../../lib/paper';
import { loadApprovalQueue, loadControlRequests, remaining } from '../../../lib/ops';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestApproveAuthorization, requestRejectAuthorization } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Approval Queue (§20.8, §15.6, D41). Every row is a risk-authorizer envelope awaiting a
 * LIVE_APPROVAL grant: the exact intent, its maximum input, and the authorization's remaining
 * validity. Approve creates a control request the approvals role turns into a grant bound to the
 * authorization hash (step-up required for exposure increases); reject cancels the intent and
 * needs no step-up. The browser never signs or executes.
 */
export default async function Approvals() {
  const [queue, requests, operator] = await Promise.all([loadApprovalQueue(), loadControlRequests(['APPROVE_AUTHORIZATION', 'REJECT_AUTHORIZATION'], 20), getOperatorSession()]);
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const now = Date.now();
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Approval Queue</h1>
      <section className="panel" data-authority="live-approval">
        <h2>Awaiting approval ({queue.length})</h2>
        {queue.length === 0 ? (
          <p className="muted">Nothing awaits approval. Authorizations appear here only for a LIVE account under LIVE_APPROVAL; the paper book never needs an envelope.</p>
        ) : (
          queue.map((q) => {
            const left = remaining(q.expires_at, now);
            const i = q.intents;
            return (
              <div key={q.intent_id} style={{ borderTop: '1px solid var(--rule)', padding: '0.6rem 0' }}>
                <p className="mono" style={{ margin: 0 }}>
                  <strong>{i?.action ?? '?'} {i?.side ?? ''}</strong> · strategy {i?.strategy_version_id ?? '?'} · max input {i ? tokens(i.max_input_amount, 6) : '?'} (settlement base units) · asset <span className="muted">{i?.asset_id.slice(0, 8) ?? '?'}</span>
                </p>
                <p className="muted mono" style={{ margin: '0.3rem 0', fontSize: '0.85rem' }}>
                  intent {q.intent_id} · authorization {q.authorization_hash.slice(0, 16)}… · issued {ago(q.created_at, now)} ·{' '}
                  <span className="chip" data-tone={left.expired ? 'failed' : 'degraded'}><span className="k">expires in</span><span className="v">{left.text}</span></span>
                </p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <form action={requestApproveAuthorization}>
                    <input type="hidden" name="intentId" value={q.intent_id} />
                    <button className="btn" type="submit" disabled={!canControl || left.expired} title="APPROVE_AUTHORIZATION: the approvals role signs a grant bound to this authorization hash after role and step-up checks">
                      APPROVE
                    </button>
                  </form>
                  <form action={requestRejectAuthorization}>
                    <input type="hidden" name="intentId" value={q.intent_id} />
                    <button className="btn" type="submit" disabled={!canControl} title="REJECT_AUTHORIZATION: cancels the intent; no step-up">
                      REJECT
                    </button>
                  </form>
                </div>
              </div>
            );
          })
        )}
        <p className="muted">An authorization that expires unapproved is recorded as EXPIRED_BY_LATENCY by the live-entry role; nothing is retried on the operator's behalf.</p>
      </section>
      <section className="panel">
        <h2>Recent decisions</h2>
        {requests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {requests.map((r) => (
              <li key={r.id}>
                {r.kind} · intent {String(r.payload['intentId'] ?? '?').slice(0, 8)} · {r.state} · {ago(r.created_at, now)}
                {r.resolution ? <span className="muted"> · {String(r.resolution['reason'] ?? (r.resolution['cancelled'] ? 'cancelled' : r.resolution['authorizationHash'] ? `grant ${String(r.resolution['authorizationHash']).slice(0, 12)}…` : ''))}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
