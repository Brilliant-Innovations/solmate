import { STEP_UP_POLICY, ControlRequestKind } from '@sol-agent-trader/contracts';
import { TotpEnrollment } from '../../../components/totp-enrollment';
import { createSupabaseServerClient, getOperatorSession } from '../../../lib/supabase/server';
import { unenrollTotp } from './actions';

export const metadata = { title: 'Settings · Solmate' };

/**
 * §20.26 Settings and Operator Security (M2 slice): session assurance, TOTP factors, passkeys
 * (read-only until the M9 registration UI), and the D41 step-up policy as shipped in contracts.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const params = await searchParams;
  const session = await getOperatorSession();
  const supabase = await createSupabaseServerClient();

  const factors = supabase ? (await supabase.auth.mfa.listFactors()).data : null;
  const totp = factors?.totp ?? [];
  const hasVerified = totp.some((f) => f.status === 'verified');
  const passkeys = supabase && session ? (await supabase.schema('ops').from('operator_passkeys').select('id, label, created_at, last_used_at, revoked_at').order('created_at')).data ?? [] : [];

  return (
    <>
      <h1>Settings</h1>
      {params.notice && (
        <div className="notice" role="status">
          {params.notice}
        </div>
      )}

      <section>
        <h2>Operator security</h2>
        <p>
          Signed in as <code>{session?.email ?? '—'}</code>, role <code>{session?.role ?? 'none'}</code>, session assurance <code>{session?.aal ?? 'unknown'}</code>.
          {session?.aal !== 'aal2' && <strong> Controls are locked until this session is aal2.</strong>}
        </p>

        <TotpEnrollment hasVerifiedFactor={hasVerified} />

        {totp.length > 0 && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Enrolled authenticators</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {totp.map((f) => (
                  <tr key={f.id}>
                    <td>{f.friendly_name || '—'}</td>
                    <td>
                      <code>{f.status}</code>
                    </td>
                    <td className="mono">{f.created_at.slice(0, 10)}</td>
                    <td>
                      <form action={unenrollTotp}>
                        <input type="hidden" name="factorId" value={f.id} />
                        <button className="btn" type="submit">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Passkeys (step-up for risk-increasing controls)</h3>
          {passkeys.length === 0 ? (
            <p className="muted">No passkey registered. Registration arrives with the Operator Security UI (M9); the verifier and storage are in place (ADR-0006).</p>
          ) : (
            <ul>
              {passkeys.map((p) => (
                <li key={p.id}>
                  {p.label} · since <span className="mono">{p.created_at.slice(0, 10)}</span>
                  {p.revoked_at && <span className="muted"> · revoked</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2>Step-up policy (D41)</h2>
        <p className="muted">Which controls need a passkey ceremony. Pause, close, reduce, reject and acknowledge stay fast by design.</p>
        <table className="table">
          <thead>
            <tr>
              <th>Control</th>
              <th>Requirement</th>
            </tr>
          </thead>
          <tbody>
            {ControlRequestKind.options.map((k) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td>
                  <code>{STEP_UP_POLICY[k]}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
