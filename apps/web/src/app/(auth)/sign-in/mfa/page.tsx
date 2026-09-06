import { signOut } from '../actions';
import { verifyTotp } from './actions';

export const metadata = { title: 'Verify · Solmate' };

/** Second factor. Every control write needs an aal2 session (migration 001100), so this is not skippable. */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const params = await searchParams;
  return (
    <main className="main" style={{ maxWidth: '32rem', margin: '4rem auto' }}>
      <h1 style={{ marginTop: 0 }}>Second factor</h1>
      <p className="muted">Enter the six-digit code from your authenticator app. Operator controls stay locked until the session is verified.</p>
      {params.error && (
        <div className="notice" data-tone="failed" role="alert">
          Verification failed: {params.error}
        </div>
      )}
      <form action={verifyTotp} className="form">
        <input type="hidden" name="next" value={params.next ?? '/'} />
        <label>
          Code
          <input name="code" inputMode="numeric" pattern="[0-9 ]{6,8}" autoComplete="one-time-code" autoFocus required />
        </label>
        <button className="btn" type="submit">
          Verify
        </button>
      </form>
      <form action={signOut} style={{ marginTop: '1.5rem' }}>
        <button className="btn" type="submit">
          Sign out
        </button>
      </form>
    </main>
  );
}
