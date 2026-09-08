import { ago } from '../../../lib/paper';
import { loadControlRequests, loadReleases } from '../../../lib/ops';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestArmRelease, requestPromoteRelease } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Releases (§12.4, §15.9, D41, D56; ADR-0004). Every Release by digest with its status, the
 * attestations recorded for it and the capital ceiling attested at arming. Promote and arm create
 * control requests; the approvals role requires an admin with a verified passkey step-up, and
 * arming additionally needs a READY Live Readiness verdict, deployment live capability, a positive
 * ceiling and no mint held under two sleeves. Refusals are shown with their reason.
 */
export default async function Releases() {
  const [{ releases, attestations, capital, accounts }, requests, operator] = await Promise.all([loadReleases(), loadControlRequests(['PROMOTE_RELEASE', 'ARM_RELEASE'], 20), getOperatorSession()]);
  const isAdmin = operator?.role === 'admin';
  const now = Date.now();
  const tone = (s: string) => (s === 'ARMED' ? 'live-approval' : s === 'ELIGIBLE_LIVE' ? 'ok' : s === 'RETIRED' ? 'off' : 'unknown');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Releases</h1>
      <section className="panel">
        <h2>Registered ({releases.length})</h2>
        {releases.length === 0 ? (
          <p className="muted">No Release registered: the state projector registers the S0_SAFE Release and the readiness role the tiny-live variant's.</p>
        ) : (
          releases.map((r) => {
            const att = attestations.filter((a) => a.release_id === r.id);
            const cap = capital.filter((c) => c.release_id === r.id);
            const canPromote = isAdmin && (r.status === 'DRAFT' || r.status === 'PAPER_VALIDATED');
            const canArm = isAdmin && (r.status === 'ELIGIBLE_LIVE' || r.status === 'ARMED');
            return (
              <div key={r.id} style={{ borderTop: '1px solid var(--rule)', padding: '0.6rem 0' }}>
                <p className="mono" style={{ margin: 0 }}>
                  <span className="chip" data-tone={tone(r.status)}><span className="v">{r.status}</span></span> <strong>{r.binding.strategyVersionId ?? 'unknown strategy'}</strong> · digest {r.digest.slice(0, 16)}… · created {ago(r.created_at, now)}
                  {r.promoted_at ? ` · promoted ${ago(r.promoted_at, now)}` : ''}
                  {r.binding.skillVersionId ? ` · skill ${r.binding.skillVersionId}` : ' · deterministic (no Trading Skill)'}
                </p>
                <p className="muted mono" style={{ margin: '0.3rem 0', fontSize: '0.85rem' }}>
                  attestations: {att.length === 0 ? 'none' : att.map((a) => `${a.purpose} by ${a.operator_role} ${ago(a.attested_at, now)}${a.expires_at && Date.parse(a.expires_at) < now ? ' (expired)' : ''}`).join(' · ')}
                  {' · '}capital: {cap.length === 0 ? 'no ceiling attested' : cap.map((c) => `$${c.ceiling_usd} ceiling${c.recognized_usd_at_attestation !== null ? ` (recognized $${c.recognized_usd_at_attestation})` : ''} ${ago(c.attested_at, now)}`).join(' · ')}
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <form action={requestPromoteRelease}>
                    <input type="hidden" name="releaseId" value={r.id} />
                    <button className="btn" type="submit" disabled={!canPromote} title="PROMOTE_RELEASE: admin step-up; a DRAFT is first validated from paper evidence">
                      PROMOTE
                    </button>
                  </form>
                  <form action={requestArmRelease} className="mono" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input type="hidden" name="releaseId" value={r.id} />
                    <select name="accountId" required disabled={!canArm}>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} ({a.mode})</option>
                      ))}
                    </select>
                    <input name="capitalCeilingUsd" type="number" min="1" step="1" placeholder="ceiling USD" required disabled={!canArm} style={{ width: '8rem' }} />
                    <button className="btn" type="submit" disabled={!canArm} title="ARM_RELEASE: admin step-up, READY readiness verdict, live capability, positive ceiling, single sleeve per mint">
                      ARM
                    </button>
                  </form>
                </div>
              </div>
            );
          })
        )}
        <p className="muted">Arming is deliberate: every missing precondition is named in the refusal below. Pause and close never need this ceremony (D41).</p>
      </section>
      <section className="panel">
        <h2>Recent promote / arm requests</h2>
        {requests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {requests.map((r) => {
              const detail = r.resolution?.['detail'] as { missing?: string[] } | undefined;
              return (
                <li key={r.id}>
                  {r.kind} · release {String(r.payload['releaseId'] ?? '?').slice(0, 8)} · {r.state} · {ago(r.created_at, now)}
                  {r.resolution ? <span className="muted"> · {String(r.resolution['reason'] ?? r.resolution['status'] ?? '')}{detail?.missing ? `: ${detail.missing.join(', ')}` : ''}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
