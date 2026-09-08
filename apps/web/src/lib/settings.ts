import { DEFAULT_NOTIFICATION_POLICY, DEFAULT_RISK_POLICY, DEFAULT_SESSION_POLICY, DEFAULT_SPEND_LIMITS, DEFAULT_WALLET_RESERVE_POLICY, DEFAULT_WATCHDOG_POLICY, FIRST_PASSKEY_COOLING_MS, RECENT_TOTP_WINDOW_MS, STEP_UP_CHALLENGE_TTL_MS, WSOL_MINT } from '@sol-agent-trader/contracts';
import type { PasskeyRow } from '../components/passkeys';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Settings / Operator Security read models (§20.26). Operators and passkeys come from ops.* under
 * RLS (self or admin); everything under "deployment guardrails", "signer / custody security" and
 * "provider plans" is read-only operational state: policy constants pinned in contracts, the
 * deployment profile registry, the latest capital attestation and readiness probe rows. Nothing
 * here is editable from the browser; live configuration is Release-bound and attested (§31).
 */

export interface OperatorRow {
  user_id: string;
  role: string;
  display_name: string;
  created_at: string;
  disabled_at: string | null;
}

export interface SettingsView {
  operators: OperatorRow[];
  passkeys: PasskeyRow[];
  pendingSecurityRequests: { id: string; kind: string; state: string; created_at: string; resolution: Record<string, unknown> | null }[];
  recentAssertions: { kind: string; verified: boolean; failure_reason: string | null; verified_at: string }[];
  profile: { profile: string; description: string; required_checks: string[]; physical_isolation: boolean; live_capital_allowed: boolean } | null;
  account: { name: string; cluster: string; trading_wallet: string; settlement_mint: string; mode: string } | null;
  capitalAttestation: { ceiling_usd: number; recognized_usd_at_attestation: number | null; attested_at: string } | null;
  signerRows: { row_id: string; verdict: string; evaluated_at: string; expires_at: string | null; detail: Record<string, unknown> }[];
  deliveryChannels: string[];
  policies: {
    notifications: typeof DEFAULT_NOTIFICATION_POLICY;
    risk: typeof DEFAULT_RISK_POLICY;
    reserve: typeof DEFAULT_WALLET_RESERVE_POLICY;
    session: typeof DEFAULT_SESSION_POLICY;
    watchdog: typeof DEFAULT_WATCHDOG_POLICY;
    spend: typeof DEFAULT_SPEND_LIMITS;
    stepUp: { challengeTtlMs: number; firstPasskeyCoolingMs: number; recentTotpWindowMs: number };
  };
  wsolMint: string;
}

const SIGNER_ROWS = ['SIGNER_CONTRACT_PROBE_C', 'SIGNER_DENY_EXPORT_PINNED', 'PROBE_A_SIGNER_POLICY', 'BREAK_GLASS_SWEEP_DRILL', 'TRIGGER_LIFECYCLE', 'CREDENTIAL_ISOLATION', 'OUT_OF_BAND_CONTROLS'];

export async function loadSettings(userId: string | null, profile: string | null): Promise<SettingsView> {
  const policies: SettingsView['policies'] = {
    notifications: DEFAULT_NOTIFICATION_POLICY,
    risk: DEFAULT_RISK_POLICY,
    reserve: DEFAULT_WALLET_RESERVE_POLICY,
    session: DEFAULT_SESSION_POLICY,
    watchdog: DEFAULT_WATCHDOG_POLICY,
    spend: DEFAULT_SPEND_LIMITS,
    stepUp: { challengeTtlMs: STEP_UP_CHALLENGE_TTL_MS, firstPasskeyCoolingMs: FIRST_PASSKEY_COOLING_MS, recentTotpWindowMs: RECENT_TOTP_WINDOW_MS },
  };
  const empty: SettingsView = { operators: [], passkeys: [], pendingSecurityRequests: [], recentAssertions: [], profile: null, account: null, capitalAttestation: null, signerRows: [], deliveryChannels: [], policies, wsolMint: WSOL_MINT };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return empty;
  const [operators, passkeys, requests, assertions, profileRow, account, readiness, deliveries] = await Promise.all([
    supabase.schema('ops').from('operators').select('user_id, role, display_name, created_at, disabled_at').order('created_at'),
    userId ? supabase.schema('ops').from('operator_passkeys').select('id, label, credential_id, transports, created_at, usable_from, last_used_at, revoked_at').eq('user_id', userId).order('created_at') : Promise.resolve({ data: [] }),
    supabase.schema('ops').from('control_requests').select('id, kind, state, created_at, resolution').in('kind', ['REGISTER_PASSKEY', 'REVOKE_PASSKEY'] as never[]).order('created_at', { ascending: false }).limit(10),
    userId ? supabase.schema('ops').from('step_up_assertions').select('kind, verified, failure_reason, verified_at').eq('user_id', userId).order('verified_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
    profile ? supabase.schema('ops').from('deployment_profiles').select('profile, description, required_checks, physical_isolation, live_capital_allowed').eq('profile', profile as never).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema('trading').from('accounts').select('id, name, cluster, trading_wallet, settlement_mint, mode').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('ops').from('readiness_rows').select('row_id, verdict, evaluated_at, expires_at, detail').in('row_id', SIGNER_ROWS).order('evaluated_at', { ascending: false }).limit(60),
    supabase.schema('ops').from('notification_deliveries').select('channel').limit(500),
  ]);
  const acc = account.data as { id: string; name: string; cluster: string; trading_wallet: string; settlement_mint: string; mode: string } | null;
  const attestation = acc ? await supabase.schema('ops').from('capital_attestations').select('ceiling_usd, recognized_usd_at_attestation, attested_at').eq('account_id', acc.id).order('attested_at', { ascending: false }).limit(1).maybeSingle() : { data: null };
  const seen = new Set<string>();
  const signerRows: SettingsView['signerRows'] = [];
  for (const r of (readiness.data as unknown as SettingsView['signerRows'] | null) ?? []) {
    if (seen.has(r.row_id)) continue;
    seen.add(r.row_id);
    signerRows.push(r);
  }
  return {
    operators: (operators.data as unknown as OperatorRow[] | null) ?? [],
    passkeys: ((passkeys.data as unknown as PasskeyRow[] | null) ?? []).map((p) => ({ ...p, transports: p.transports ?? [] })),
    pendingSecurityRequests: (requests.data as unknown as SettingsView['pendingSecurityRequests'] | null) ?? [],
    recentAssertions: (assertions.data as unknown as SettingsView['recentAssertions'] | null) ?? [],
    profile: (profileRow.data as unknown as SettingsView['profile']) ?? null,
    account: acc ? { name: acc.name, cluster: acc.cluster, trading_wallet: acc.trading_wallet, settlement_mint: acc.settlement_mint, mode: acc.mode } : null,
    capitalAttestation: (attestation.data as unknown as SettingsView['capitalAttestation']) ?? null,
    signerRows,
    deliveryChannels: [...new Set(((deliveries.data as { channel: string }[] | null) ?? []).map((d) => d.channel))].sort(),
    policies,
    wsolMint: WSOL_MINT,
  };
}

/** sha256 of the trading wallet address as a stable, short destination fingerprint (§20.26 wallet connector). */
export async function fingerprint(s: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
