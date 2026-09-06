import { signIn } from './actions';

export const metadata = { title: 'Sign in · Solmate' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const params = await searchParams;
  const configured = Boolean(process.env['NEXT_PUBLIC_SUPABASE_URL'] && process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']);
  return (
    <main className="main" style={{ maxWidth: '32rem', margin: '4rem auto' }}>
      <h1 style={{ marginTop: 0 }}>Solmate operator sign-in</h1>
      <p className="muted">
        Operator accounts are created by an admin in Supabase Auth; there is no public sign-up. Connecting a Solana wallet is never
        authentication (D46).
      </p>
      {!configured && (
        <div className="notice" data-tone="failed" role="alert">
          Supabase is not configured for this deployment: set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
        </div>
      )}
      {params.error && (
        <div className="notice" data-tone="failed" role="alert">
          Sign-in failed: {params.error}
        </div>
      )}
      <form action={signIn} className="form">
        <input type="hidden" name="next" value={params.next ?? '/'} />
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button className="btn" type="submit" disabled={!configured}>
          Sign in
        </button>
      </form>
    </main>
  );
}
