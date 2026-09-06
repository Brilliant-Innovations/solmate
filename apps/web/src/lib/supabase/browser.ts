'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@sol-agent-trader/db';

/**
 * Browser-side Supabase client (publishable key only). Used for Supabase Auth ceremonies that
 * must run in the browser, such as TOTP enrolment (§5.7). Reads are RLS-scoped; the only table
 * write it could ever perform is ops.control_requests, like the server client.
 */
export function createSupabaseBrowserClient() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  if (!url || !key) return null;
  return createBrowserClient<Database>(url, key);
}
