import { StepUpRequest } from '../../../../components/step-up-request';
import { loadArmingReview } from '../../../../lib/arming';
import { ago, baseToUsd, usd } from '../../../../lib/paper';
import { loadMyPasskeys } from '../../../../lib/settings';
import { getOperatorSession } from '../../../../lib/supabase/server';
import { lamportsToSol } from '../../../../lib/wallet';

export const dynamic = 'force-dynamic';

/**
 * Arming review (§20.3, §20.29): the deliberate flow for arming a Release or moving a session to
 * LIVE_APPROVAL / LIVE_AUTO. Bound to one immutable Release, diffed against the previously armed
 * one, and showing every fact the blueprint requires before the operator confirms with a passkey.
 * The confirmation is a control request; the approvals and session roles re-check every
 * precondition themselves (readiness verdict, live capability, ceiling, sleeve conflicts,
 * attestation), so this page can only inform, never arm.
 */
export default async function ArmingReview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ account?: string }> }) {
  const { id } = await params;
  const { account: accountParam } = await searchParams;
  const now = Date.now();
  const [review, operator] = await Promise.all([loadArmingReview(id, accountParam ?? null, now), getOperatorSession()]);
  if (!review) {
    return (
      <>
        <h1 style={{ marginTop: 0 }}>Arming review</h1>
        <p className="muted">No Release with that id is readable from this session.</p>
        <p><a className="btn" href="/releases">Back to Releases</a></p>
      </>
    );
  }
  const passkeys = await loadMyPasskeys(operator?.userId ?? null);
  const isAdmin = operator?.aal === 'aal2' && operator.role === 'admin';
  const rpId = process.env['NEXT_PUBLIC_WEBAUTHN_RP_ID'] ?? null;
  const r = review.release;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const dep = (key: string) => review.system.dependencies.find((d) => d.key === key) ?? null;
  const critical = review.alerts.open.filter((a) => (a.severity === 'CRITICAL' || a.severity === 'HIGH') && !a.acknowledged_at);
  const readyApproval = review.verdicts.find((v) => v.name === 'READY_FOR_ATTENDED_TINY_LIVE' && v.strategy_class === (r.binding.skillVersionId ? 'LLM' : 'DETERMINISTIC')) ?? null;
  const readyAuto = review.verdicts.find((v) => (v.name === 'READY_FOR_UNATTENDED_LIVE_PILOT' || v.name === 'READY_FOR_HARDENED_LIVE_AUTO') && v.strategy_class === (r.binding.skillVersionId ? 'LLM' : 'DETERMINISTIC')) ?? null;
  const sol = review.wallet.reconciliation?.balances.find((b) => b.mint === null)?.observed ?? null;
  const settlement = review.wallet.account ? (review.wallet.reconciliation?.balances.find((b) => b.mint === review.wallet.account!.settlement_mint)?.observed ?? null) : null;
  const blockers: string[] = [];
  if (!review.profile?.live_capital_allowed) blockers.push(`profile ${review.profile?.profile ?? review.session?.profile ?? '?'} does not allow live capital`);
  if (r.status !== 'ELIGIBLE_LIVE' && r.status !== 'ARMED') blockers.push(`Release is ${r.status}; promote it first`);
  if (!readyApproval || readyApproval.verdict !== 'READY') blockers.push('no READY verdict for LIVE_APPROVAL');
  if (critical.length) blockers.push(`${critical.length} unacknowledged CRITICAL/HIGH alert(s)`);
  if (review.reserve && (review.reserve.gas.state !== 'OK' || review.reserve.settlement.state !== 'OK')) blockers.push('wallet reserves not OK');
  const primary = dep('jupiter');
  const emergency = dep('emergency-adapter');
  const dryRun = dep('dry-run');
  const notif = dep('notifications');
  const spendDep = dep('spend');
  if (emergency && emergency.state !== 'HEALTHY') blockers.push('emergency-exit adapter not healthy (LIVE_AUTO cannot arm)');
  if (review.strategy && review.strategy.live_intent_expiry_ms < review.strategy.human_reaction_floor_ms) blockers.push('strategy intent expiry below the human-reaction floor: NOT ELIGIBLE FOR LIVE_APPROVAL');
  const liveAccount = review.account && review.account.mode === 'LIVE' ? review.account : null;
  const Tone = ({ ok, text }: { ok: boolean | null; text: string }) => <span className="chip" data-tone={ok === null ? 'unknown' : ok ? 'ok' : 'failed'}><span className="v">{text}</span></span>;

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Arming review <span className="muted" style={{ fontWeight: 400 }}>· {r.binding.strategyVersionId ?? 'unknown strategy'}</span></h1>
      <p className="mono" style={{ margin: '0 0 0.6rem' }}>
        <span className="chip" data-tone={r.status === 'ARMED' ? 'live-approval' : r.status === 'ELIGIBLE_LIVE' ? 'ok' : 'unknown'}><span className="k">release</span><span className="v">{r.status}</span></span>{' '}
        digest {r.digest} · {review.previousArmed ? <>diff vs previously armed {review.previousArmed.digest.slice(0, 12)}…</> : 'no previously armed Release'} · <a href="/releases">Releases</a>
      </p>
      {blockers.length > 0 && (
        <div className="notice" data-tone="failed" role="alert">
          <strong>Arming would be refused:</strong> {blockers.join('; ')}. The worker re-checks every item; this list is informational.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <section className="panel">
          <h2>Wallet, blast radius and caps</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">account</td><td style={cell}>{review.account ? `${review.account.name} (${review.account.mode}, ${review.account.cluster})` : 'none'}{review.accounts.length > 1 ? <span className="muted"> · other: {review.accounts.filter((a) => a.id !== review.account?.id).map((a) => <a key={a.id} href={`/releases/${r.id}?account=${a.id}`} style={{ marginLeft: '0.3rem' }}>{a.name}</a>)}</span> : null}</td></tr>
            <tr><td style={cell} className="muted">trading wallet</td><td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}>{review.account?.trading_wallet ?? '—'}</td></tr>
            <tr><td style={cell} className="muted">balance / max blast radius</td><td style={cell}>{sol !== null ? `${lamportsToSol(sol)} SOL` : 'SOL unobserved'} · {settlement !== null ? usd(baseToUsd(settlement)) : 'settlement unobserved'}{review.wallet.attestation ? ` · attested ceiling $${review.wallet.attestation.ceiling_usd.toLocaleString()}` : ' · no attested ceiling yet'}</td></tr>
            <tr><td style={cell} className="muted">reserves</td><td style={cell}>{review.reserve ? <><Tone ok={review.reserve.gas.state === 'OK'} text={`gas ${review.reserve.gas.state}`} /> <Tone ok={review.reserve.settlement.state === 'OK'} text={`settlement ${review.reserve.settlement.state}`} /></> : 'no reconciliation observation'}</td></tr>
            <tr><td style={cell} className="muted">executor absolute cap</td><td style={cell}>pinned in the execution-service environment (D65); the capital ceiling below bounds arming</td></tr>
            <tr><td style={cell} className="muted">risk policy</td><td style={cell}>{r.binding.riskPolicyVersion ?? '?'} · cohorts {r.binding.cohortPolicyVersion ?? '?'} · freshness {r.binding.freshnessPolicyVersion ?? '?'}</td></tr>
            <tr><td style={cell} className="muted">last reconciliation</td><td style={cell}>{review.wallet.reconciliation ? `${review.wallet.reconciliation.status} ${ago(review.wallet.reconciliation.evaluated_at, now)}` : 'never'}</td></tr>
            <tr><td style={cell} className="muted">deployment live capability</td><td style={cell}><Tone ok={review.profile?.live_capital_allowed ?? null} text={review.profile ? (review.profile.live_capital_allowed ? 'ENABLED' : 'DISABLED') : 'UNKNOWN'} /> {review.profile ? `profile ${review.profile.profile}` : ''}</td></tr>
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Bound versions and diff</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['binding', 'previously armed', 'this Release'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              {review.diff.map((d) => (
                <tr key={d.key} style={{ background: d.changed ? 'color-mix(in oklch, var(--degraded) 12%, transparent)' : undefined }}>
                  <td style={cell} className="muted">{d.key}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}>{d.before}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}><strong>{d.after}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>{r.binding.skillVersionId ? 'LLM strategy: skill, guideline, automation-set and both model-policy versions are bound.' : 'Deterministic strategy: no Trading Skill; adversary is the deterministic gate.'} Strategy {review.strategy ? `${review.strategy.strategy_id} ${review.strategy.speed_tier} · authorities ${review.strategy.eligible_capital_authorities.join(', ') || 'none'} · live expiry ${review.strategy.live_intent_expiry_ms / 1000}s vs floor ${review.strategy.human_reaction_floor_ms / 1000}s` : 'unknown'}.</p>
        </section>

        <section className="panel">
          <h2>Sleeves and open positions</h2>
          {review.sleeves.length === 0 ? <p className="muted">No sleeve on this account.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
              {review.sleeves.map((s) => <tr key={s.strategy_version_id}><td style={cell}>{s.strategy_version_id}</td><td style={cell}>cap {usd(baseToUsd(s.capital_cap_base_units))} · committed {usd(baseToUsd(s.committed_base_units))}</td></tr>)}
            </tbody></table>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Open positions ({review.positions.length})</h3>
          {review.positions.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
              {review.positions.map((p) => <tr key={p.id}><td style={cell}><a href={`/positions/${p.id}`}>{p.symbol}</a></td><td style={cell}>{p.lots.filter((l) => l.status === 'OPEN').map((l) => `${l.strategy_version_id.split('@')[0]} ${l.protection_mode}`).join(', ') || 'no open lot'}</td><td style={cell}>{p.safety_state} · {p.review_state}</td></tr>)}
            </tbody></table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Protection modes: {[...new Set(review.positions.flatMap((p) => p.lots.filter((l) => l.status === 'OPEN').map((l) => l.protection_mode)))].join(', ') || 'no open lot'}.</p>
        </section>

        <section className="panel">
          <h2>Adapters, alerts, feeds, channels, dry-runs, spend</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">primary (Jupiter)</td><td style={cell}><Tone ok={primary ? primary.state === 'HEALTHY' : null} text={primary?.state.replace('_', ' ') ?? 'UNKNOWN'} /></td></tr>
            <tr><td style={cell} className="muted">emergency-exit adapter</td><td style={cell}><Tone ok={emergency ? emergency.state === 'HEALTHY' : null} text={emergency?.state.replace('_', ' ') ?? 'UNKNOWN'} /> <span className="muted">{emergency?.source}</span></td></tr>
            <tr><td style={cell} className="muted">dry-run freshness</td><td style={cell}><Tone ok={dryRun ? dryRun.state === 'HEALTHY' : null} text={dryRun?.state.replace('_', ' ') ?? 'UNKNOWN'} /> <span className="muted">{dryRun?.source}</span></td></tr>
            <tr><td style={cell} className="muted">provider freshness</td><td style={cell}>{review.health.providers.total === 0 ? 'no provider rows' : `${review.health.providers.healthy} healthy · ${review.health.providers.degraded} degraded · ${review.health.providers.failed} failed`}</td></tr>
            <tr><td style={cell} className="muted">notification channels</td><td style={cell}><Tone ok={notif ? notif.state === 'HEALTHY' : null} text={notif?.state.replace('_', ' ') ?? 'UNKNOWN'} /> <span className="muted">{notif?.lastError ?? notif?.source}</span></td></tr>
            <tr><td style={cell} className="muted">spend budgets</td><td style={cell}><Tone ok={spendDep ? spendDep.state === 'HEALTHY' : null} text={spendDep?.state.replace('_', ' ') ?? 'UNKNOWN'} /></td></tr>
            <tr><td style={cell} className="muted">unresolved CRITICAL / HIGH</td><td style={{ ...cell, whiteSpace: 'normal' }}>{critical.length === 0 ? <Tone ok text="NONE" /> : critical.map((a) => `${a.severity} ${a.alert_class} (${ago(a.raised_at, now)})`).join('; ')}</td></tr>
            <tr><td style={cell} className="muted">worker roles</td><td style={cell}>{review.health.roles} lease(s){review.health.staleRoles.length ? ` · expired ${review.health.staleRoles.join(', ')}` : ''}</td></tr>
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Readiness verdicts</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">READY FOR LIVE_APPROVAL</td><td style={cell}>{readyApproval ? <><Tone ok={readyApproval.verdict === 'READY'} text={readyApproval.verdict} /> <span className="muted">{readyApproval.name} · {readyApproval.strategy_class} · {ago(readyApproval.computed_at, now)}{readyApproval.release_id === r.id ? ' · for this Release' : ' · for another Release'}</span></> : <Tone ok={null} text="NOT COMPUTED" />}</td></tr>
            <tr><td style={cell} className="muted">READY FOR LIVE_AUTO</td><td style={cell}>{readyAuto ? <><Tone ok={readyAuto.verdict === 'READY'} text={readyAuto.verdict} /> <span className="muted">{readyAuto.name} · {ago(readyAuto.computed_at, now)}</span></> : <Tone ok={null} text="NOT COMPUTED" />}</td></tr>
          </tbody></table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>LIVE_AUTO cannot arm while a required readiness invariant fails. <a href="/readiness">Live Readiness</a></p>
        </section>

        <section className="panel" data-authority="live-approval">
          <h2>Confirm</h2>
          <p className="muted" style={{ marginTop: 0 }}>Each confirmation is a passkey step-up bound to this exact Release, account and ceiling; the approvals role attests and arms only if every precondition still holds. Pause stays one click.</p>
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            <div>
              <div className="mono muted">Arm Release {r.digest.slice(0, 12)}… on {review.account?.name ?? 'no account'} with a capital ceiling (USD)</div>
              <StepUpRequest kind="ARM_RELEASE" payload={{ releaseId: r.id, accountId: review.account?.id ?? '', source: 'arming-review' }} numberField={{ name: 'capitalCeilingUsd', placeholder: 'ceiling USD', min: 1 }} label="Arm Release" passkeys={passkeys} rpId={rpId} disabled={!isAdmin || !review.account || (r.status !== 'ELIGIBLE_LIVE' && r.status !== 'ARMED')} confirm="ARM" danger />
            </div>
            <div>
              <div className="mono muted">Set the session's capital authority (SET_REQUESTED_MODE; live targets need step-up, OBSERVE/PAPER are fast)</div>
              <div className="controls" style={{ gap: '0.6rem' }}>
                <StepUpRequest kind="SET_REQUESTED_MODE" payload={{ authority: 'LIVE_APPROVAL', source: 'arming-review' }} label="Set LIVE_APPROVAL" passkeys={passkeys} rpId={rpId} disabled={!isAdmin || !liveAccount || r.status !== 'ARMED'} confirm="LIVE_APPROVAL" danger />
                <StepUpRequest kind="SET_REQUESTED_MODE" payload={{ authority: 'LIVE_AUTO', source: 'arming-review' }} label="Set LIVE_AUTO" passkeys={passkeys} rpId={rpId} disabled={!isAdmin || !liveAccount || r.status !== 'ARMED' || !readyAuto || readyAuto.verdict !== 'READY'} confirm="LIVE_AUTO" danger />
              </div>
              <p className="muted" style={{ margin: '0.3rem 0 0' }}>Session: {review.session ? `${review.session.activity_state} · authority ${review.session.capital_authority}${review.session.paused?.active ? ' · PAUSED' : ''}` : 'none for this account'}. {liveAccount ? '' : 'The selected account is not a LIVE account; live authorities apply to LIVE accounts only.'}</p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
