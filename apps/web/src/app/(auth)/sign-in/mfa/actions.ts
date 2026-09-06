'use server';

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

/** Second step of sign-in: verify the operator's TOTP code and raise the session to aal2 (§5.7). */
export async function verifyTotp(formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
  const next = String(formData.get('next') ?? '/');
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect('/sign-in?error=' + encodeURIComponent('Supabase is not configured'));

  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) redirect('/sign-in/mfa?error=' + encodeURIComponent(listError.message));
  const totp = factors.totp.find((f) => f.status === 'verified');
  if (!totp) redirect('/settings?notice=' + encodeURIComponent('No verified authenticator app: enrol one first.'));

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
  if (error) redirect('/sign-in/mfa?next=' + encodeURIComponent(target) + '&error=' + encodeURIComponent(error.message));
  redirect(target);
}
