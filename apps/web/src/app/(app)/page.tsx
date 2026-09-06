import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { createSupabaseServerClient } from '../../lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Control Room placeholder (§20.2). Real widgets arrive with the data that feeds them (M5a
 * onward). What exists today is shown; what does not is labelled as absent, never as zero.
 */
export default async function ControlRoom() {
  const digest = await getContractSetDigest();
  const supabase = await createSupabaseServerClient();
  const profiles = supabase ? (await supabase.schema('ops').from('deployment_profiles').select('profile, description, live_capital_allowed').order('profile')).data ?? [] : [];
  const pending = supabase ? (await supabase.schema('ops').from('control_requests').select('kind, state, created_at').eq('state', 'PENDING').order('created_at', { ascending: false }).limit(10)).data ?? [] : [];

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Control Room</h1>
      <section className="panel">
        <h2>Trading session</h2>
        <p className="muted">No runtime session has been started. The session widget, Agent Now, Upcoming and Opportunity Queue arrive with M5a.</p>
      </section>
      <section className="panel">
        <h2>Pending control requests</h2>
        {pending.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {pending.map((r, i) => (
              <li key={i}>
                {r.kind} · {r.state} · {r.created_at}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">Requests are acted on by the worker after role, step-up and state checks; the browser never executes a control itself.</p>
      </section>
      <section className="panel">
        <h2>Deployment profiles</h2>
        {profiles.length === 0 ? (
          <p className="muted">Not readable: sign in as an operator, or the database is unreachable.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.profile}>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.profile}</td>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.live_capital_allowed ? 'live capital allowed' : 'no live capital'}</td>
                  <td style={{ padding: '0.2rem 0' }} className="muted">
                    {p.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h2>This deployment</h2>
        <p className="mono">
          contract set {digest.digest.slice(0, 16)}… · {digest.schemaCount} schemas · {digest.format}
        </p>
      </section>
    </>
  );
}
