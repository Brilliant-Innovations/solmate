import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from './lib/safe-next';

/**
 * Session refresh and route protection (Next.js 16 proxy). Unauthenticated requests are sent to
 * /sign-in; /api/health stays public because readiness compares contract digests across
 * deployables without a session (D50). No financial state is reachable here.
 */
const PUBLIC_PATHS = ['/sign-in', '/api/health'];

export async function proxy(request: NextRequest) {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const publishableKey = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));

  let response = NextResponse.next({ request });
  if (!url || !publishableKey) {
    return isPublic || path === '/' ? response : NextResponse.redirect(new URL('/sign-in', request.url));
  }

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/sign-in';
    redirect.search = '';
    redirect.searchParams.set('next', safeNext(path));
    return NextResponse.redirect(redirect);
  }
  if (user) {
    // §5.7: a session with an enrolled second factor must verify it before anything else.
    // Only PUBLIC_PATHS are exempt (review R2-18).
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const mfaPending = aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2';
    if (mfaPending && !isPublic) {
      const redirect = request.nextUrl.clone();
      redirect.pathname = '/sign-in/mfa';
      redirect.search = '';
      redirect.searchParams.set('next', safeNext(path));
      return NextResponse.redirect(redirect);
    }
    if (path === '/sign-in' || (path === '/sign-in/mfa' && !mfaPending)) {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|woff2?)$).*)'],
};
