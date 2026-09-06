import { redirect } from 'next/navigation';
import { Nav } from '../../components/nav';
import { loadStatusSnapshot, StatusBar } from '../../components/status-bar';
import { getOperatorSession } from '../../lib/supabase/server';
import { signOut } from '../(auth)/sign-in/actions';

export const dynamic = 'force-dynamic';

/**
 * Application shell (§20.1): status bar on every page, primary navigation, and the unmistakable
 * live treatment driven by the current capital authority. Requires a signed-in user; a user
 * without an operator role sees the shell with an explanation and no data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getOperatorSession();
  const configured = Boolean(process.env['NEXT_PUBLIC_SUPABASE_URL']);
  if (configured && !session) redirect('/sign-in');
  const snapshot = await loadStatusSnapshot();
  return (
    <div className="shell" data-authority={snapshot.authority ?? 'UNKNOWN'} data-paused={String(snapshot.paused)}>
      <StatusBar />
      <div className="body">
        <Nav />
        <main className="main">
          {!configured && (
            <div className="notice" data-tone="failed" role="alert">
              Supabase is not configured for this deployment. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.
            </div>
          )}
          {session && session.role !== null && session.aal !== 'aal2' && (
            <div className="notice" role="alert">
              Controls are locked: this session is <code>{session.aal ?? 'unverified'}</code>. Every control request needs a TOTP-verified (<code>aal2</code>) session (§5.7).{' '}
              <a href="/settings">Enrol or verify an authenticator in Settings.</a>
            </div>
          )}
          {session && session.role === null && (
            <div className="notice" role="alert">
              Signed in as <code>{session.email}</code> but this user has no operator role. An admin adds a row to <code>ops.operators</code> for user id{' '}
              <code>{session.userId}</code>.
            </div>
          )}
          {children}
          <p className="muted" style={{ marginTop: '2rem', fontSize: '0.8rem' }}>
            {session ? (
              <>
                {session.displayName ?? session.email} · role <code>{session.role ?? 'none'}</code> ·{' '}
                <form action={signOut} style={{ display: 'inline' }}>
                  <button className="btn" type="submit">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              'Not signed in.'
            )}
          </p>
        </main>
      </div>
    </div>
  );
}
