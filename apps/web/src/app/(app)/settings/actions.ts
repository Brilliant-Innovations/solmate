'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../lib/supabase/server';

/** Remove an authenticator. Supabase requires an aal2 session for unenrol; the error is shown if not. */
export async function unenrollTotp(formData: FormData): Promise<void> {
  const factorId = String(formData.get('factorId') ?? '');
  const supabase = await createSupabaseServerClient();
  if (!supabase || !factorId) return;
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) redirect('/settings?notice=' + encodeURIComponent(error.message));
  revalidatePath('/settings');
}
