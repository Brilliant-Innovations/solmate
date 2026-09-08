import { STEP_UP_POLICY, ControlRequestKind } from '@sol-agent-trader/contracts';
import { Passkeys } from '../../../components/passkeys';
import { TotpEnrollment } from '../../../components/totp-enrollment';
import { ago } from '../../../lib/paper';
import { fingerprint, loadSettings } from '../../../lib/settings';
import { createSupabaseServerClient, getOperatorSession } from '../../../lib/supabase/server';
import { signOutEverywhere, unenrollTotp } from './actions';

export const metadata = { title: 'Settings · Solmate' };
export const dynamic = 'force-dynamic';

/**
 * §20.26 Settings and Operator Security: operators and roles, TOTP and passkeys with sessions
 * revoke; the D41 step-up policy and lifetimes; notification routing, escalation, dead-man and
 * heartbeat as configured in contracts; display defaults; deployment guardrails, signer / custody
 * security, provider plans and the wallet connector as read-only operational state. `viewer` is
 * read-only, `operator` may pause/reduce/close and approve, `admin` additionally promotes and arms
 * and changes security configuration; nothing on this page changes live policy from the browser.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const params = await searchParams;
  const session = await getOperatorSession();
  const supabase = await createSupabaseServerClient();
  const now = Date.now();
  const factors = supabase ? (await supabase.auth.mfa.listFactors()).data : null;
  const totp = factors?.totp ?? [];
  const hasVerified = totp.some((f) => f.status === 'verified');
  const profile = supabase ? ((await supabase.schema('ops').from('runtime_sessions').select('profile').order('created_at', { ascending: false }).limit(1).maybeSingle()).data?.profile ?? null) : null;
  const view = await loadSettings(session?.userId ?? null, profile);
  const canControl = session?.aal === 'aal2' && (session.role === 'operator' || session.role === 'admin');
  const walletFp = view.account ? await fingerprint(view.account.trading_wallet) : null;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' };
  const p = view.policies;

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Settings</h1>
      {params.notice && (
        <div className="notice" role="status">
          {params.notice}
        </div>
      )}

      <section className="panel">
        <h2>Operator security</h2>
        <p>
          Signed in as <code>{session?.email ?? '—'}</code>, role <code>{session?.role ?? 'none'}</code>, session assurance <code>{session?.aal ?? 'unknown'}</code>.
          {session?.aal !== 'aal2' && <strong> Controls are locked until this session is aal2.</strong>}
        </p>
        <TotpEnrollment hasVerifiedFactor={hasVerified} />
        {totp.length > 0 && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Enrolled authenticators (TOTP)</h3>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['name', 'status', 'since', ''].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {totp.map((f) => (
                  <tr key={f.id}>
                    <td style={cell}>{f.friendly_name || '—'}</td>
                    <td style={cell}><code>{f.status}</code></td>
                    <td style={cell}>{f.created_at.slice(0, 10)}</td>
                    <td style={cell}>
                      <form action={unenrollTotp}>
                        <input type="hidden" name="factorId" value={f.id} />
                        <button className="btn" type="submit">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {session && (
          <Passkeys userId={session.userId} email={session.email} displayName={session.displayName} passkeys={view.passkeys} canControl={canControl} rpId={process.env['NEXT_PUBLIC_WEBAUTHN_RP_ID'] ?? null} />
        )}
        {(view.pendingSecurityRequests.length > 0 || view.recentAssertions.length > 0) && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Recent security requests and step-up verdicts</h3>
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {view.pendingSecurityRequests.map((r) => (
                <li key={r.id}>{r.kind} · {r.state}{r.resolution && typeof r.resolution['reason'] === 'string' ? ` (${r.resolution['reason'] as string})` : ''} · {ago(r.created_at, now)}</li>
              ))}
              {view.recentAssertions.map((a, i) => (
                <li key={`a${i}`}>step-up for {a.kind}: {a.verified ? 'VERIFIED' : `FAILED (${a.failure_reason})`} · {ago(a.verified_at, now)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Sessions</h3>
          <p className="muted" style={{ marginTop: 0 }}>Read sessions expire with the Supabase refresh token; control sessions need aal2 and a step-up challenge is valid for {mins(p.stepUp.challengeTtlMs)}. Signing out everywhere revokes every refresh token for this user, on every device.</p>
          <form action={signOutEverywhere}>
            <button className="btn danger" type="submit">Sign out everywhere</button>
          </form>
        </div>
      </section>

      <div style={grid}>
        <section className="panel">
          <h2>Operators</h2>
          {view.operators.length === 0 ? (
            <p className="muted">No operator row is readable from this session.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['name', 'role', 'user id', 'since', 'state'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {view.operators.map((o) => (
                  <tr key={o.user_id}>
                    <td style={cell}>{o.display_name}</td>
                    <td style={cell}><code>{o.role}</code></td>
                    <td style={cell} className="muted">{o.user_id.slice(0, 8)}…</td>
                    <td style={cell}>{o.created_at.slice(0, 10)}</td>
                    <td style={cell}>{o.disabled_at ? <span className="chip" data-tone="failed"><span className="v">DISABLED</span></span> : <span className="chip" data-tone="ok"><span className="v">ACTIVE</span></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>
            <code>viewer</code> reads. <code>operator</code> pauses, reduces, closes and approves. <code>admin</code> additionally promotes Releases, arms live modes and changes security configuration. Roles are granted by an admin outside the browser (sign-up is disabled); multi-tenant SaaS is a non-goal.
          </p>
        </section>

        <section className="panel">
          <h2>Step-up policy (D41)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Which controls need a passkey ceremony. Pause, close, reduce, reject, acknowledge and end stay fast by design. First passkey cooling {mins(p.stepUp.firstPasskeyCoolingMs)}; fresh-TOTP window {mins(p.stepUp.recentTotpWindowMs)}; challenge life {mins(p.stepUp.challengeTtlMs)}.</p>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {ControlRequestKind.options.map((k) => (
                <tr key={k}>
                  <td style={cell}>{k}</td>
                  <td style={cell}><code>{STEP_UP_POLICY[k]}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Notifications</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {(['INFO', 'NOTICE', 'HIGH', 'CRITICAL'] as const).map((s) => (
                <tr key={s}><td style={cell} className="muted">{s}</td><td style={cell}>{p.notifications.channelsBySeverity[s].join(', ')}</td></tr>
              ))}
              <tr><td style={cell} className="muted">CRITICAL confirmed channels</td><td style={cell}>≥ {p.notifications.criticalMinConfirmedChannels}</td></tr>
              <tr><td style={cell} className="muted">escalation</td><td style={cell}>every {mins(p.notifications.escalationIntervalMs)} up to level {p.notifications.escalationMaxLevel}</td></tr>
              <tr><td style={cell} className="muted">dead-man classes</td><td style={cell}>{p.notifications.deadManClasses.join(', ')}</td></tr>
              <tr><td style={cell} className="muted">dead-man interval</td><td style={cell}>{mins(p.notifications.deadManIntervalMs)} → PAUSE_NEW_ENTRIES (never EMERGENCY_CLOSE_ALL)</td></tr>
              <tr><td style={cell} className="muted">heartbeat (SYSTEM_ALIVE)</td><td style={cell}>every {mins(p.notifications.heartbeatIntervalMs)} while a session runs</td></tr>
              <tr><td style={cell} className="muted">quiet hours</td><td style={cell}>none in v1; CRITICAL is never suppressed</td></tr>
              <tr><td style={cell} className="muted">channels with deliveries</td><td style={cell}>{view.deliveryChannels.length ? view.deliveryChannels.join(', ') : 'none yet'}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Channel credentials (Telegram, email) live in the worker environment, never in the browser. Policy version <span className="mono">{p.notifications.version}</span>. <a href="/alerts">Alert center</a></p>
        </section>

        <section className="panel">
          <h2>Display</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">timezone</td><td style={cell}>UTC on every screen; relative ages beside absolute times</td></tr>
              <tr><td style={cell} className="muted">display currency</td><td style={cell}>USD (settlement USDC reads 1:1); token amounts in native units</td></tr>
              <tr><td style={cell} className="muted">density / charts</td><td style={cell}>compact monospace tables; Lightweight Charts on Asset Workspace, Recharts for ops (M9 step 4)</td></tr>
              <tr><td style={cell} className="muted">live treatment</td><td style={cell}>LIVE_APPROVAL / LIVE_AUTO recolour the shell; PAPER never looks like LIVE</td></tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Deployment guardrails (read-only)</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">profile</td><td style={cell}>{view.profile ? `${view.profile.profile} · ${view.profile.description}` : profile ?? 'no session yet'}</td></tr>
              <tr><td style={cell} className="muted">required checks</td><td style={{ ...cell, whiteSpace: 'normal' }}>{view.profile?.required_checks.join(', ') ?? '—'}</td></tr>
              <tr><td style={cell} className="muted">live capital allowed</td><td style={cell}>{view.profile ? (view.profile.live_capital_allowed ? 'YES' : 'NO') : '—'} · physical isolation {view.profile ? (view.profile.physical_isolation ? 'YES' : 'NO') : '—'}</td></tr>
              <tr><td style={cell} className="muted">capital-attestation ceiling</td><td style={cell}>{view.capitalAttestation ? `$${view.capitalAttestation.ceiling_usd.toLocaleString()} attested ${ago(view.capitalAttestation.attested_at, now)}${view.capitalAttestation.recognized_usd_at_attestation !== null ? ` (recognized $${view.capitalAttestation.recognized_usd_at_attestation.toLocaleString()} then)` : ''}` : 'none (no Release armed)'}</td></tr>
              <tr><td style={cell} className="muted">per-token exposure cap</td><td style={cell}>{(p.risk.maxExposurePerTokenFraction * 100).toFixed(0)}% · daily drawdown {(p.risk.maxDailyDrawdownFraction * 100).toFixed(1)}% · rolling {(p.risk.maxRollingDrawdownFraction * 100).toFixed(1)}% · breaker cooldown {mins(p.risk.cooldownAfterBreakerMs)}</td></tr>
              <tr><td style={cell} className="muted">wallet reserve floor</td><td style={cell}>{Number(p.reserve.minGasLamports) / 1e9} SOL gas · ${Number(p.reserve.minSettlementBaseUnits) / 1e6} settlement</td></tr>
              <tr><td style={cell} className="muted">presence / watchdog</td><td style={cell}>presence timeout {mins(p.session.presenceTimeoutMs)} · heartbeat missing after {mins(p.watchdog.heartbeatMissingAfterMs)} · watchdog fresh {mins(p.watchdog.watchdogFreshMs)}</td></tr>
              <tr><td style={cell} className="muted">executor caps / trust roots</td><td style={cell}>Profile 2+ only: pinned in the execution-service environment inside the isolated environment; not readable here by design (D65)</td></tr>
              <tr><td style={cell} className="muted">signer-outage unprotected cap</td><td style={cell}>applies from Profile 2 (SIGNER_UNAVAILABLE_WITH_EXPOSURE is CRITICAL); no live exposure in {profile ?? 'this profile'}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Signer / custody security (read-only)</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">signer provider</td><td style={cell}>{profile && profile.startsWith('P1') ? 'none (paper adapter); production signer is Turnkey with a non-exportable key from Profile 2' : 'Turnkey (non-exportable), policy gateway per ADR-0008'}</td></tr>
              {['SIGNER_CONTRACT_PROBE_C', 'SIGNER_DENY_EXPORT_PINNED', 'PROBE_A_SIGNER_POLICY', 'BREAK_GLASS_SWEEP_DRILL', 'TRIGGER_LIFECYCLE', 'CREDENTIAL_ISOLATION', 'OUT_OF_BAND_CONTROLS'].map((id) => {
                const r = view.signerRows.find((x) => x.row_id === id);
                const stale = r?.expires_at ? Date.parse(r.expires_at) < now : false;
                return (
                  <tr key={id}>
                    <td style={cell} className="muted">{id}</td>
                    <td style={cell}>
                      {r ? (
                        <>
                          <span className="chip" data-tone={r.verdict === 'PASS' ? (stale ? 'degraded' : 'ok') : r.verdict === 'FAIL' ? 'failed' : 'unknown'}><span className="v">{r.verdict}{stale ? ' (stale)' : ''}</span></span> {ago(r.evaluated_at, now)}
                        </>
                      ) : (
                        <span className="chip" data-tone="unknown"><span className="v">NOT RUN</span></span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr><td style={cell} className="muted">correlated-provider warning</td><td style={cell}>shown when the signer provider also controls Trigger custody (Profile 2+)</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Probes and drills run from the isolated environment and land as readiness rows; see <a href="/readiness">Live Readiness</a>.</p>
        </section>

        <section className="panel">
          <h2>Provider plans (read-only)</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['provider', 'plan', 'rate / budget assumptions'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              <tr><td style={cell}>Birdeye</td><td style={cell}>Lite ($39/mo)</td><td style={{ ...cell, whiteSpace: 'normal' }}>2.5M CU/month, 15 rps; tier sizes the adapter's CU and rate budgets</td></tr>
              <tr><td style={cell}>Helius</td><td style={cell}>Free</td><td style={{ ...cell, whiteSpace: 'normal' }}>10 rps, 1M credits/month; RPC + Parsed Events for reconciliation</td></tr>
              <tr><td style={cell}>Jupiter</td><td style={cell}>Free (API key)</td><td style={{ ...cell, whiteSpace: 'normal' }}>quote / price v3; swap and Trigger from Profile 2</td></tr>
              <tr><td style={cell}>Model providers</td><td style={cell}>not configured</td><td style={{ ...cell, whiteSpace: 'normal' }}>D43 defaults: platform ${p.spend.platform.modelUsdPerDay}/day, strategy ${p.spend.strategy.modelUsdPerDay}/day and {p.spend.strategy.cyclesPerHour} cycles/h, provider {p.spend.provider.providerRequestsPerMinute} req/min</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Source of truth: <span className="mono">docs/costs.md</span> provider tier register; keys live in the worker environment.</p>
        </section>

        <section className="panel">
          <h2>Wallet connector</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">deployment cluster</td><td style={cell}>{view.account?.cluster ?? 'no account'}</td></tr>
              <tr><td style={cell} className="muted">allowed funding assets</td><td style={cell}>SOL (gas) and the settlement mint {view.account ? `${view.account.settlement_mint.slice(0, 6)}…` : ''}; FUND_TRADING_WALLET only</td></tr>
              <tr><td style={cell} className="muted">trading-wallet destination</td><td style={cell}>{view.account ? `${view.account.trading_wallet.slice(0, 6)}…${view.account.trading_wallet.slice(-4)} · fingerprint ${walletFp}` : '—'}</td></tr>
              <tr><td style={cell} className="muted">connector</td><td style={cell}>Solana Kit / Wallet Standard, <span className="mono">@sol-agent-trader/wallet-ui</span> (funding UI lands with M9 step 6)</td></tr>
              <tr><td style={cell} className="muted">authority</td><td style={cell}>a connected browser wallet is never a trading, approval or auth authority; destination and cluster come from deployment guardrails and are read-only here</td></tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
