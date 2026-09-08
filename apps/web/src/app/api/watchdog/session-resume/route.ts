import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from '../../../../lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * External offline-resume watchdog (blueprint §21.2C, D61). Vercel Cron calls this route; it runs
 * the database-side tick `ops.session_resume_watchdog()`, which detects an overdue resume or a
 * missing runtime heartbeat, raises CRITICAL, persists PAUSE_NEW_ENTRIES and audits itself. The
 * route holds no database credential beyond the publishable key: the function is fact-based and
 * idempotent, so an extra call can never trade, sign or loosen anything. The bearer secret keeps
 * the route from being a free trigger. Its telemetry is what wind-down consults before allowing
 * offline-protected carry.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env['CRON_SECRET'];
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const cfg = supabaseConfig();
  if (!cfg) return Response.json({ error: 'supabase not configured' }, { status: 503 });
  const client = createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: false } });
  const { data, error } = await client.schema('ops').rpc('session_resume_watchdog' as never, {} as never);
  if (error) return Response.json({ error: error.message }, { status: 502 });
  return Response.json({ service: 'web', watchdog: data, at: new Date().toISOString() });
}
