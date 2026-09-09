import { StepUpRequest } from '../../../components/step-up-request';
import { diffBindings } from '../../../lib/arming';
import { ago } from '../../../lib/paper';
import { loadControlRequests, loadReadinessVerdicts, loadReleases } from '../../../lib/ops';
import { loadMyPasskeys } from '../../../lib/settings';
import { createSupabaseServerClient, getOperatorSession } from '../../../lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Releases (§20.29, §12.4, §15.9, D38, D41, D56; ADR-0004). A Release is the immutable live binding
 * tuple. The screen shows armed Releases per live strategy, drafts, the diff of each Release against
 * the previously armed one, validation evidence (paper cycles, attestations, readiness verdict),
 * promotion/retirement history and Promote / Retire with passkey step-up. Arming opens the arming
 * review (§20.3) bound to the Release. Editing a bound artifact creates a draft; nothing is edited
 * in place.
 */
export default async function Releases() {
  const now = Date.now();
  const [{ releases, attestations, capital, accounts }, requests, operator, verdicts] = await Promise.all([loadReleases(), loadControlRequests(['PROMOTE_RELEASE', 'ARM_RELEASE', 'RETIRE_RELEASE'], 20), getOperatorSession(), loadReadinessVerdicts()]);
  const supabase = await createSupabaseServerClient();
  const passkeys = await loadMyPasskeys(operator?.userId ?? null);
  const isAdmin = operator?.aal === 'aal2' && operator.role === 'admin';
  const rpId = process.env['NEXT_PUBLIC_WEBAUTHN_RP_ID'] ?? null;
  const paperCycles = new Map<string, number>();
  if (supabase && releases.length) {
    const strategyIds = [...new Set(releases.map((r) => r.binding.strategyVersionId).filter((x): x is string => !!x))];
    const { data } = await supabase.schema('agents').from('action_cycles').select('strategy_version_id').in('strategy_version_id', strategyIds).eq('state', 'CLEARED' as never).limit(5000);
    for (const c of (data as { strategy_version_id: string }[] | null) ?? []) paperCycles.set(c.strategy_version_id, (paperCycles.get(c.strategy_version_id) ?? 0) + 1);
  }
  const tone = (s: string) => (s === 'ARMED' ? 'live-approval' : s === 'ELIGIBLE_LIVE' ? 'ok' : s === 'RETIRED' ? 'off' : s === 'PAPER_VALIDATED' ? 'watch' : 'unknown');
  const armed = releases.filter((r) => r.status === 'ARMED');
  const cell = { padding: '0.15rem 0.8rem 0.15rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Releases</h1>
      <section className="panel" data-authority={armed.length ? 'live-approval' : undefined}>
        <h2>Armed per live strategy ({armed.length})</h2>
        {armed.length === 0 ? <p className="muted">Nothing armed; live capability is disabled by default (§31).</p> : (
          <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
            {armed.map((r) => <li key={r.id}>{r.binding.strategyVersionId} · digest {r.digest.slice(0, 12)}… · ceiling {capital.filter((c) => c.release_id === r.id).map((c) => `$${c.ceiling_usd}`).join(', ') || 'none'} · <a href={`/releases/${r.id}`}>arming review</a></li>)}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Registered ({releases.length})</h2>
        {releases.length === 0 ? (
          <p className="muted">No Release registered: the state projector registers the S0_SAFE Release and the readiness role the tiny-live variant's.</p>
        ) : (
          releases.map((r) => {
            const att = attestations.filter((a) => a.release_id === r.id);
            const cap = capital.filter((c) => c.release_id === r.id);
            const previous = releases.find((x) => x.id !== r.id && x.status === 'ARMED') ?? null;
            const diff = diffBindings(previous?.binding ?? null, r.binding).filter((d) => d.changed);
            const verdict = verdicts.find((v) => v.release_id === r.id) ?? null;
            const cycles = r.binding.strategyVersionId ? (paperCycles.get(r.binding.strategyVersionId) ?? 0) : 0;
            const canPromote = isAdmin && (r.status === 'DRAFT' || r.status === 'PAPER_VALIDATED');
            const canArm = isAdmin && (r.status === 'ELIGIBLE_LIVE' || r.status === 'ARMED');
            const canRetire = isAdmin && r.status !== 'RETIRED';
            return (
              <div key={r.id} style={{ borderTop: '1px solid var(--rule)', padding: '0.6rem 0' }}>
                <p className="mono" style={{ margin: 0 }}>
                  <span className="chip" data-tone={tone(r.status)}><span className="v">{r.status}</span></span> <strong>{r.binding.strategyVersionId ?? 'unknown strategy'}</strong> · digest {r.digest.slice(0, 16)}… · created {ago(r.created_at, now)}
                  {r.promoted_at ? ` · promoted ${ago(r.promoted_at, now)}` : ''}{r.retired_at ? ` · retired ${ago(r.retired_at, now)}` : ''}
                  {r.binding.skillVersionId ? ` · skill ${r.binding.skillVersionId}` : ' · deterministic (no Trading Skill)'} · <a href={`/releases/${r.id}`}>arming review</a>
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '0.8rem', margin: '0.4rem 0' }}>
                  <div>
                    <div className="muted mono">validation evidence</div>
                    <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
                      <tr><td style={cell} className="muted">paper cycles</td><td style={cell}>{cycles} cleared under {r.binding.strategyVersionId ?? '?'}</td></tr>
                      <tr><td style={cell} className="muted">attestations</td><td style={{ ...cell, whiteSpace: 'normal' }}>{att.length === 0 ? 'none' : att.map((a) => `${a.purpose} by ${a.operator_role} ${ago(a.attested_at, now)}${a.verification_result ? '' : ' (NOT VERIFIED)'}${a.expires_at && Date.parse(a.expires_at) < now ? ' (expired)' : ''}`).join(' · ')}</td></tr>
                      <tr><td style={cell} className="muted">readiness</td><td style={cell}>{verdict ? <span className="chip" data-tone={verdict.verdict === 'READY' ? 'ok' : 'failed'}><span className="v">{verdict.name} {verdict.verdict}</span></span> : <span className="muted">no verdict computed for this Release</span>}</td></tr>
                      <tr><td style={cell} className="muted">capital</td><td style={cell}>{cap.length === 0 ? 'no ceiling attested' : cap.map((c) => `$${c.ceiling_usd} ceiling ${ago(c.attested_at, now)}`).join(' · ')}</td></tr>
                      <tr><td style={cell} className="muted">shadow / replay / tool-manifest / security</td><td style={cell}><span className="muted">recorded as readiness rows (CI_EVIDENCE) on Live Readiness</span></td></tr>
                    </tbody></table>
                  </div>
                  <div>
                    <div className="muted mono">diff vs previously armed {previous ? `(${previous.digest.slice(0, 8)}…)` : '(none armed)'}</div>
                    {diff.length === 0 ? <p className="muted" style={{ margin: 0 }}>{previous ? 'identical binding' : 'no previously armed Release to diff against'}</p> : (
                      <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
                        {diff.map((d) => <tr key={d.key}><td style={cell} className="muted">{d.key}</td><td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}>{d.before} → <strong>{d.after}</strong></td></tr>)}
                      </tbody></table>
                    )}
                  </div>
                </div>
                <div className="controls" style={{ gap: '0.6rem' }}>
                  <StepUpRequest kind="PROMOTE_RELEASE" payload={{ releaseId: r.id, source: 'releases' }} label="Promote" passkeys={passkeys} rpId={rpId} disabled={!canPromote} title="PROMOTE_RELEASE: admin passkey step-up; a DRAFT is first validated from paper evidence" />
                  <a className={`btn${canArm ? '' : ' muted'}`} href={`/releases/${r.id}`} aria-disabled={!canArm}>Arm (review)</a>
                  <StepUpRequest kind="RETIRE_RELEASE" payload={{ releaseId: r.id, source: 'releases' }} label="Retire" passkeys={passkeys} rpId={rpId} disabled={!canRetire} danger confirm="RETIRE" title="RETIRE_RELEASE: admin passkey step-up; a retired Release can never be re-armed" />
                </div>
              </div>
            );
          })
        )}
        <p className="muted">{accounts.length} account(s): {accounts.map((a) => `${a.name} (${a.mode})`).join(', ') || 'none'}. Live artifacts are never edited in place: editing a bound strategy, skill, guideline, automation set or policy creates a draft Release (D38).</p>
      </section>

      <section className="panel">
        <h2>Promotion / arming / retirement history</h2>
        {requests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {requests.map((r) => (
              <li key={r.id}>
                {r.kind} · release {String(r.payload['releaseId'] ?? '?').slice(0, 8)} · {r.state} · {ago(r.created_at, now)}
                {r.resolution ? <span className="muted"> · {String(r.resolution['reason'] ?? r.resolution['status'] ?? '')}{r.resolution['missing'] ? ` (${(r.resolution['missing'] as string[]).join(', ')})` : ''}{r.resolution['detail'] && typeof r.resolution['detail'] === 'object' && 'missing' in (r.resolution['detail'] as object) ? ` (${((r.resolution['detail'] as { missing?: string[] }).missing ?? []).join(', ')})` : ''}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
