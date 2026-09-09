'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

type Stage = { step: 'idle' } | { step: 'enrolled'; factorId: string; qr: string; secret: string } | { step: 'done' };

/**
 * TOTP enrolment (§5.7, §20.26). Runs in the browser because Supabase returns the QR code and
 * secret once, at enrol time, to the session that will verify them. After verification the
 * session is aal2 and the operator's controls unlock.
 */
export function TotpEnrollment({ hasVerifiedFactor }: { hasVerifiedFactor: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enrol() {
    setError(null);
    setBusy(true);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      setBusy(false);
      return;
    }
    // Without an issuer Supabase derives one from the request host, so an enrolment run against a
    // dev server labelled the authenticator entry "localhost" — indistinguishable from any other
    // localhost app, and wrong on the deployment the operator actually signs in to. The SDK defines
    // issuer as "domain which the user is enrolled with", so it is the host, which also keeps a
    // local and a hosted enrolment tellable apart in the authenticator.
    const host = typeof window === 'undefined' ? 'solmate' : window.location.host;
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: host, friendlyName: `${host} · ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (err || !data) {
      setError(err?.message ?? 'Enrolment failed.');
      return;
    }
    setStage({ step: 'enrolled', factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(formData: FormData) {
    if (stage.step !== 'enrolled') return;
    setError(null);
    setBusy(true);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: stage.factorId, code });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setStage({ step: 'done' });
    router.refresh();
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Authenticator app (TOTP)</h3>
      {hasVerifiedFactor && stage.step === 'idle' && <p className="muted">A verified authenticator is enrolled. Adding another is allowed; removing one requires a verified session.</p>}
      {!hasVerifiedFactor && stage.step === 'idle' && (
        <p className="notice" role="status">
          No authenticator enrolled. Controls stay locked until one is verified.
        </p>
      )}
      {error && (
        <p className="notice" data-tone="failed" role="alert">
          {error}
        </p>
      )}
      {stage.step === 'idle' && (
        <button className="btn" type="button" onClick={enrol} disabled={busy}>
          {hasVerifiedFactor ? 'Add another authenticator' : 'Enrol authenticator'}
        </button>
      )}
      {stage.step === 'enrolled' && (
        <div className="form">
          <p>Scan the code with your authenticator app, then enter the current six-digit code.</p>
          {/* Supabase returns an SVG data URI for the QR code. */}
          <img src={stage.qr} alt="TOTP enrolment QR code" width={192} height={192} style={{ background: 'white', borderRadius: 4 }} />
          <p className="mono muted" style={{ wordBreak: 'break-all' }}>
            Manual key: {stage.secret}
          </p>
          <form action={verify}>
            <label>
              Code
              <input name="code" inputMode="numeric" pattern="[0-9 ]{6,8}" autoComplete="one-time-code" required />
            </label>
            <button className="btn" type="submit" disabled={busy}>
              Verify and activate
            </button>
          </form>
        </div>
      )}
      {stage.step === 'done' && <p className="notice">Authenticator verified. This session is now aal2.</p>}
    </div>
  );
}
