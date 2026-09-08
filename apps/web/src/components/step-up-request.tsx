'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { stepUpBindingHash, type ControlRequestKind } from '@sol-agent-trader/contracts';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

export interface StepUpPasskey {
  credential_id: string;
  transports: string[];
}

/**
 * A control that requires passkey step-up (D41, §5.7; ADR-0006): approve, promote, arm, retire,
 * resume, set a live authority, record a drill. The bound payload is hashed exactly as the worker
 * hashes it, ops.begin_step_up() issues a five-minute challenge bound to that hash, the passkey
 * signs it, and one control request carries payload + stepUp evidence. The worker's
 * operator-security role verifies the assertion before the owning role acts; the browser never
 * signs, executes or arms anything itself. Without a usable passkey the control explains why.
 */
export function StepUpRequest({ kind, payload, label, title, passkeys, rpId, disabled, danger, confirm, redirectTo, numberField }: { kind: ControlRequestKind; payload: Record<string, unknown>; label: string; title?: string; passkeys: StepUpPasskey[]; rpId: string | null; disabled?: boolean; danger?: boolean; confirm?: string; redirectTo?: string; /** A number the operator types that becomes part of the bound payload (e.g. capitalCeilingUsd). */ numberField?: { name: string; placeholder: string; min: number } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [num, setNum] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'failed'; text: string } | null>(null);
  const rp = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  const noPasskey = passkeys.length === 0;

  async function run() {
    setBusy(true);
    setNotice(null);
    try {
      const supabase = createSupabaseBrowserClient();
      if (!supabase) throw new Error('Supabase is not configured');
      const bound = numberField ? { ...payload, [numberField.name]: Number(num) } : payload;
      if (numberField && !(Number(num) >= numberField.min)) throw new Error(`${numberField.name} must be at least ${numberField.min}`);
      const bindingHash = await stepUpBindingHash(kind, bound);
      const { data, error } = await supabase.schema('ops').rpc('begin_step_up', { p_kind: kind, p_binding_hash: bindingHash as never });
      if (error) throw new Error(error.message.includes('NO_PASSKEY') ? 'Register a passkey in Settings first.' : error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { id: string; challenge: string } | undefined;
      if (!row) throw new Error('no challenge issued');
      const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
        challenge: row.challenge,
        rpId: rp,
        timeout: 120_000,
        userVerification: 'required',
        allowCredentials: passkeys.map((p) => ({ id: p.credential_id, type: 'public-key' as const, transports: p.transports as never })),
      };
      const response = await startAuthentication({ optionsJSON });
      const { error: insertError } = await supabase.schema('ops').from('control_requests').insert({ kind, payload: { ...bound, stepUp: { challengeId: row.id, credentialId: response.id, response } } as never });
      if (insertError) throw new Error(insertError.message);
      setNotice({ tone: 'ok', text: `${kind} filed with a verified-pending passkey assertion; the worker acts within seconds.` });
      setTyped('');
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setNotice({ tone: 'failed', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const blocked = disabled || busy || noPasskey || (confirm !== undefined && typed !== confirm) || (numberField !== undefined && !(Number(num) >= numberField.min));
  return (
    <div className="controls" style={{ gap: '0.4rem', alignItems: 'center' }}>
      {numberField && <input className="mono" type="number" min={numberField.min} step="1" value={num} onChange={(e) => setNum(e.target.value)} placeholder={numberField.placeholder} aria-label={numberField.name} disabled={disabled || busy} style={{ width: '9rem' }} />}
      {confirm !== undefined && <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`type ${confirm}`} aria-label={`type ${confirm} to confirm`} disabled={disabled || busy} autoComplete="off" />}
      <button type="button" className={`btn${danger ? ' danger' : ''}`} onClick={run} disabled={blocked} title={noPasskey ? 'A registered passkey is required (Settings → Operator security)' : title ?? `${kind}: passkey step-up, then one control request`}>
        {busy ? 'Waiting for passkey…' : label}
      </button>
      {noPasskey && !disabled && <span className="muted mono">needs a passkey</span>}
      {notice && <span className="mono" style={{ color: notice.tone === 'failed' ? 'var(--failed)' : 'var(--ok)' }}>{notice.text}</span>}
    </div>
  );
}
