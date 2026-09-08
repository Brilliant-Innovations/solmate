'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { stepUpBindingHash } from '@sol-agent-trader/contracts';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

export interface PasskeyRow {
  id: string;
  label: string;
  credential_id: string;
  transports: string[];
  created_at: string;
  usable_from: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Passkey registration and revocation (§5.7, §20.26, D41; ADR-0006). The browser runs the WebAuthn
 * ceremony and files the evidence as a control request; the worker's operator-security role
 * verifies it with SimpleWebAuthn and writes the passkey. Flow: compute the binding hash of the
 * request the challenge may authorise → ops.begin_step_up() issues a five-minute challenge →
 * ceremony → one ops.control_requests row. A first passkey needs a fresh TOTP verification; every
 * later one also needs an assertion from an existing passkey over the same challenge (R2-01), and
 * a first passkey cools for an hour before it can authorise REQUIRED controls.
 */
export function Passkeys({ userId, email, displayName, passkeys, canControl, rpId }: { userId: string; email: string | null; displayName: string | null; passkeys: PasskeyRow[]; canControl: boolean; rpId: string | null }) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'failed'; text: string } | null>(null);
  const active = passkeys.filter((p) => p.revoked_at === null);
  const rp = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');

  async function beginChallenge(kind: 'REGISTER_PASSKEY' | 'REVOKE_PASSKEY', payload: Record<string, unknown>) {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) throw new Error('Supabase is not configured');
    const bindingHash = await stepUpBindingHash(kind, payload);
    const { data, error } = await supabase.schema('ops').rpc('begin_step_up', { p_kind: kind, p_binding_hash: bindingHash as never });
    if (error) throw new Error(error.message.replace(/^.*FRESH_TOTP_REQUIRED.*$/, 'Verify your authenticator code again (Settings → Operator security), then register the first passkey within five minutes.'));
    const row = (Array.isArray(data) ? data[0] : data) as { id: string; challenge: string; expires_at: string } | undefined;
    if (!row) throw new Error('no challenge issued');
    return { supabase, challengeId: row.id, challenge: row.challenge };
  }

  async function assertExisting(challenge: string, challengeId: string) {
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
      challenge,
      rpId: rp,
      timeout: 120_000,
      userVerification: 'required',
      allowCredentials: active.map((p) => ({ id: p.credential_id, type: 'public-key' as const, transports: p.transports as never })),
    };
    const response = await startAuthentication({ optionsJSON });
    return { challengeId, credentialId: response.id, response };
  }

  async function register() {
    if (!label.trim()) {
      setNotice({ tone: 'failed', text: 'Give the passkey a label first.' });
      return;
    }
    setBusy('register');
    setNotice(null);
    try {
      const payload = { label: label.trim(), source: 'settings' };
      const { supabase, challengeId, challenge } = await beginChallenge('REGISTER_PASSKEY', payload);
      const stepUp = active.length > 0 ? await assertExisting(challenge, challengeId) : null;
      const optionsJSON: PublicKeyCredentialCreationOptionsJSON = {
        challenge,
        rp: { id: rp, name: 'Solmate operator console' },
        user: { id: toBase64Url(new TextEncoder().encode(userId)), name: email ?? userId, displayName: displayName ?? email ?? 'operator' },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },
          { alg: -257, type: 'public-key' },
        ],
        timeout: 120_000,
        attestation: 'none',
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: active.map((p) => ({ id: p.credential_id, type: 'public-key' as const, transports: p.transports as never })),
      };
      const response = await startRegistration({ optionsJSON });
      const { error } = await supabase.schema('ops').from('control_requests').insert({
        kind: 'REGISTER_PASSKEY',
        payload: { ...payload, registration: { challengeId, response }, ...(stepUp ? { stepUp } : {}) } as never,
      });
      if (error) throw new Error(error.message);
      setLabel('');
      setNotice({ tone: 'ok', text: `Registration filed. The worker verifies the attestation within seconds; ${active.length === 0 ? 'a first passkey can authorise REQUIRED controls after a one-hour cooling period' : 'it is usable immediately'}. A CRITICAL alert records every registration.` });
      router.refresh();
    } catch (err) {
      setNotice({ tone: 'failed', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(passkeyId: string) {
    setBusy(passkeyId);
    setNotice(null);
    try {
      const payload = { passkeyId, source: 'settings' };
      const { supabase, challengeId, challenge } = await beginChallenge('REVOKE_PASSKEY', payload);
      const stepUp = await assertExisting(challenge, challengeId);
      const { error } = await supabase.schema('ops').from('control_requests').insert({ kind: 'REVOKE_PASSKEY', payload: { ...payload, stepUp } as never });
      if (error) throw new Error(error.message);
      setNotice({ tone: 'ok', text: 'Revocation filed; the worker applies it after verifying the assertion.' });
      router.refresh();
    } catch (err) {
      setNotice({ tone: 'failed', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Passkeys (step-up for risk-increasing controls, D41)</h3>
      {notice && (
        <div className="notice" data-tone={notice.tone === 'failed' ? 'failed' : undefined} role="status">
          {notice.text}
        </div>
      )}
      {passkeys.length === 0 ? (
        <p className="muted">No passkey registered. Until one exists, REQUIRED controls (resume, approve, promote, arm, revoke) are refused as STEP_UP_REQUIRED.</p>
      ) : (
        <table className="mono" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['label', 'state', 'registered', 'usable from', 'last used', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '0.2rem 0.8rem 0.2rem 0' }} className="muted">{h}</th>)}</tr>
          </thead>
          <tbody>
            {passkeys.map((p) => {
              const cooling = p.revoked_at === null && Date.parse(p.usable_from) > Date.now();
              return (
                <tr key={p.id}>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.label}</td>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>
                    <span className="chip" data-tone={p.revoked_at ? 'failed' : cooling ? 'degraded' : 'ok'}><span className="v">{p.revoked_at ? 'REVOKED' : cooling ? 'COOLING' : 'ACTIVE'}</span></span>
                  </td>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.created_at.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.usable_from.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ padding: '0.2rem 0.8rem 0.2rem 0' }}>{p.last_used_at ? p.last_used_at.slice(0, 16).replace('T', ' ') : 'never'}</td>
                  <td style={{ padding: '0.2rem 0' }}>
                    {p.revoked_at === null && (
                      <button className="btn" type="button" disabled={!canControl || busy !== null} onClick={() => revoke(p.id)} title="REQUIRED step-up: an assertion from one of your passkeys">
                        {busy === p.id ? 'Verifying…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="controls" style={{ marginTop: '0.6rem' }}>
        <input className="mono" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="passkey label (e.g. laptop, yubikey)" maxLength={64} aria-label="passkey label" disabled={!canControl || busy !== null} />
        <button className="btn" type="button" disabled={!canControl || busy !== null} onClick={register}>
          {busy === 'register' ? 'Waiting for authenticator…' : active.length === 0 ? 'Register first passkey' : 'Register another passkey'}
        </button>
      </div>
      <p className="muted" style={{ margin: '0.4rem 0 0' }}>
        Relying party <span className="mono">{rp}</span>. {active.length === 0 ? 'The first passkey needs a TOTP verification within the last five minutes.' : 'Adding or revoking a passkey needs an assertion from an existing one.'} Lost every passkey? Recovery is an admin action outside the browser (ADR-0006).
      </p>
    </div>
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
