'use server';

import { redirect } from 'next/navigation';
import { safeNext } from '../../../lib/safe-next';
import { createSupabaseServerClient } from '../../../lib/supabase/server';

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = safeNext(String(formData.get('next') ?? '/'));
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect('/sign-in?error=' + encodeURIComponent('Supabase is not configured'));
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect('/sign-in?error=' + encodeURIComponent(error.message));
  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  redirect('/sign-in');
}
