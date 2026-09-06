'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '../../lib/supabase/server';

/**
 * The browser write surface (§20.23, §23.3): every operator control becomes a row in
 * ops.control_requests, inserted as the signed-in user under RLS. The worker validates role,
 * step-up and state, then acts. Pause is deliberately cheap and needs no step-up (D41).
 */
export async function requestPauseNewEntries(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  await supabase.schema('ops').from('control_requests').insert({ kind: 'PAUSE_NEW_ENTRIES', payload: { source: 'status-bar' } });
  revalidatePath('/');
}

export async function requestEndSession(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  await supabase.schema('ops').from('control_requests').insert({ kind: 'END_SESSION', payload: { source: 'status-bar' } });
  revalidatePath('/');
}
