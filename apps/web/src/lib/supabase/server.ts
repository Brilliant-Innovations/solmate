import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@sol-agent-trader/db';

/**
 * Server-side Supabase client for the control plane (blueprint §5.3, §23.3). Uses the anon key and
 * the operator's session cookie, so every read is subject to RLS and every write is limited to the
 * browser write surface (ops.control_requests). The service role never exists in this deployable.
 */
export function supabaseConfig(): { url: string; publishableKey: string } | null {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const publishableKey = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  return url && publishableKey ? { url, publishableKey } : null;
}

export async function createSupabaseServerClient() {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  const cookieStore = await cookies();
  return createServerClient<Database>(cfg.url, cfg.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are refreshed by the proxy instead.
        }
      },
    },
  });
}

export type OperatorSession = {
  userId: string;
  email: string | null;
  role: Database['enums']['Enums']['operator_role'] | null;
  displayName: string | null;
};

/** The signed-in user and their operator role (null role = signed in but not an operator). */
export async function getOperatorSession(): Promise<OperatorSession | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.schema('ops').from('operators').select('role, display_name').eq('user_id', user.id).maybeSingle();
  return { userId: user.id, email: user.email ?? null, role: data?.role ?? null, displayName: data?.display_name ?? null };
}
