import { DEFAULT_RISK_POLICY, getContractSetDigest } from '@sol-agent-trader/contracts';
import { ago, baseToUsd, loadEquity, loadOpenAlerts, loadPaperAccount, loadPositions, loadSessionView, usd } from '../../lib/paper';
import { loadAgentNow, loadDrawdown, loadHealthSummary, loadOpportunityQueue, loadRecentActions, loadSessionExtras, loadSleeves, loadSpendToday, loadUpcoming } from '../../lib/control-room';
import { stageLabel } from '../../lib/cycles';
import { lamportsToSol, loadWalletView, reserveStatus } from '../../lib/wallet';
import { createSupabaseServerClient, getOperatorSession } from '../../lib/supabase/server';
import { requestStartSession } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Control Room (§20.2): answers within seconds whether the system is healthy, live, how much is at
 * risk, what the agent is doing now and next, whether positions are protected, what changed and
 * whether to intervene. Everything is a read of ledger state; what does not exist is labelled
 * absent, never zero (§20.21). PAPER and LIVE are never collapsed: the account mode and capital
 * authority are named on the session widget and the status bar.
 */
export default async function ControlRoom() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const digest = await getContractSetDigest();
  const supabase = await createSupabaseServerClient();
  const operator = await getOperatorSession();
  const canControl = operator?.role === 'operator' || operator?.role === 'admin';
  const account = await loadPaperAccount();
  const [session, equity, positions, alerts] = account
    ? await Promise.all([loadSessionView(account.id), loadEquity(account.id), loadPositions(account.id, { includeClosed: false, limit: 20 }), loadOpenAlerts(10)])
    : [null, { latest: null, dayStart: null }, [], await loadOpenAlerts(10)];
  const extras = session ? await loadSessionExtras(session.id) : null;
  const [agentNow, recent, queue, upcoming, sleeves, spend, drawdown, health, wallet, pendingRes] = await Promise.all([
    loadAgentNow(),
    loadRecentActions(),
    loadOpportunityQueue(nowIso),
    loadUpcoming(account?.id ?? null, extras, nowIso),
    account ? loadSleeves(account.id) : Promise.resolve([]),
    loadSpendToday(nowIso),
    account ? loadDrawdown(account.id, equity.latest?.drawdown ?? null) : Promise.resolve(null),
    loadHealthSummary(now),
    loadWalletView(),
    supabase ? supabase.schema('ops').from('control_requests').select('kind, state, created_at').eq('state', 'PENDING').order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
  ]);
  const pending = (pendingRes.data as { kind: string; state: string; created_at: string }[] | null) ?? [];
  const gatesFailed = session?.cold_start_gates.filter((g) => !g.passed) ?? [];
  const latestEquity = baseToUsd(equity.latest?.equity_base_units);
  const dayStartEquity = baseToUsd(equity.dayStart?.equity_base_units);
  const dayPnl = latestEquity !== null && dayStartEquity !== null && dayStartEquity > 0 ? latestEquity - dayStartEquity : null;
  const unrealized = positions.reduce<number | null>((acc, p) => (p.unrealized_pnl_base_units === null ? acc : (acc ?? 0) + Number(p.unrealized_pnl_base_units) / 1e6), null);
  const realized = positions.reduce((acc, p) => acc + Number(p.realized_pnl_base_units) / 1e6, 0);
  const committed = sleeves.reduce((acc, s) => acc + Number(s.committed_base_units), 0);
  const available = latestEquity !== null ? latestEquity - committed / 1e6 : null;
  const reserve = wallet.account ? reserveStatus(wallet.reconciliation, wallet.account.settlement_mint) : null;
  const unprotected = positions.filter((p) => p.review_state !== 'REVIEWED' || p.safety_state !== 'NORMAL');
  const critical = alerts.filter((a) => a.severity === 'CRITICAL' && !a.acknowledged_at);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))', gap: '1rem', alignItems: 'start' };
  const cell = { padding: '0.2rem 0.7rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const pct = (f: number | null | undefined) => (f === null || f === undefined || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(1)}%`);

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Control Room</h1>

      {(critical.length > 0 || unprotected.length > 0 || health.staleRoles.length > 0 || drawdown?.breakerTripped) && (
        <div className="notice" data-tone="failed" role="alert">
          <strong>Intervention check:</strong>{' '}
          {critical.length > 0 ? `${critical.length} unacknowledged CRITICAL alert(s). ` : ''}
          {unprotected.length > 0 ? `${unprotected.length} position(s) not fully reviewed/safe: ${unprotected.map((p) => `${p.symbol} ${p.review_state}/${p.safety_state}`).join(', ')}. ` : ''}
          {health.staleRoles.length > 0 ? `Worker role lease(s) expired: ${health.staleRoles.join(', ')}. ` : ''}
          {drawdown?.breakerTripped ? `Circuit breaker tripped ${ago(drawdown.breakerSince, now)}. ` : ''}
        </div>
      )}

      <section className="panel">
        <h2>Trading session</h2>
        {!account ? (
          <p className="muted">No paper account exists yet: the worker creates one when the paper-entry role starts.</p>
        ) : !session ? (
          <>
            <p className="muted">
              Paper account <span className="mono">{account.name}</span> has no runtime session. Start one to enter STARTING; cold-start gates must pass before WATCH (D63).
            </p>
            <form action={requestStartSession}>
              <button className="btn" type="submit" disabled={!canControl} title="Requests START_SESSION; the worker validates and starts the PAPER session">START SESSION</button>
            </form>
          </>
        ) : (
          <>
            <p className="mono">
              <span className="chip" data-tone={session.activity_state.toLowerCase().replace('_', '-')}><span className="k">activity</span><span className="v">{session.activity_state}</span></span>{' '}
              <span className="chip" data-tone={session.capital_authority === 'PAPER' ? 'paper' : session.capital_authority === 'OBSERVE' ? 'observe' : session.capital_authority === 'LIVE_APPROVAL' ? 'live-approval' : 'live-auto'}><span className="k">authority</span><span className="v">{session.capital_authority}</span></span>{' '}
              <span className="chip" data-tone="unknown"><span className="k">profile</span><span className="v">{session.profile} · {session.attended ? 'ATTENDED' : 'UNATTENDED'}</span></span>{' '}
              {session.paused?.active && <span className="chip" data-tone="paused"><span className="k">override</span><span className="v">PAUSED · {session.paused.reason ?? 'no reason'} · by {session.paused.by ?? '?'}</span></span>}{' '}
              <span className="chip" data-tone={session.attended ? (session.last_presence_heartbeat_at && now - Date.parse(session.last_presence_heartbeat_at) < 180_000 ? 'ok' : 'failed') : 'unknown'}>
                <span className="k">presence</span><span className="v">{session.attended ? `heartbeat ${ago(session.last_presence_heartbeat_at, now)}` : 'unattended profile'}</span>
              </span>
            </p>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={cell} className="muted">account</td><td style={cell}>{account.name} ({account.cluster}) · session {session.id.slice(0, 8)}</td></tr>
                <tr><td style={cell} className="muted">started / intended end</td><td style={cell}>{session.actual_start_at ? `${ago(session.actual_start_at, now)} (${durationLabel(now - Date.parse(session.actual_start_at))})` : 'not started'} · {extras?.intended_end_at ? `ends ${ago(extras.intended_end_at, now)}` : 'no intended end (operator END SESSION)'}</td></tr>
                <tr><td style={cell} className="muted">market sessions / regime</td><td style={cell}>{extras && extras.market_sessions.length > 0 ? extras.market_sessions.join(', ') : 'no session label'} · {extras?.regime ?? 'regime not classified'}</td></tr>
                <tr><td style={cell} className="muted">event window</td><td style={cell}>{extras?.event_window ? `catalyst ${extras.event_window.catalystEventId.slice(0, 8)} · source time ${ago(extras.event_window.sourceTimeT0, now)} · expires ${ago(extras.event_window.deadline, now)} · extensions ${extras.event_window.extensionsUsed}` : 'none'}</td></tr>
                <tr><td style={cell} className="muted">next transition</td><td style={cell}>{upcoming.find((u) => u.kind === 'SESSION_END' || u.kind === 'EVENT_WINDOW_DEADLINE' || u.kind === 'OFFLINE_RESUME_DEADLINE')?.label ?? 'none scheduled'}{extras?.offline_resume_deadline ? ` · offline resume deadline ${ago(extras.offline_resume_deadline, now)} · watchdog ${extras.resume_watchdog?.status ?? '?'}` : ''}</td></tr>
                <tr><td style={cell} className="muted">END SESSION blockers</td><td style={cell}>{session.wind_down_blockers.length > 0 ? session.wind_down_blockers.join('; ') : extras && extras.in_flight_execution_ids.length > 0 ? `${extras.in_flight_execution_ids.length} in-flight execution(s)` : extras?.exposure_at_last_transition?.unmanagedCount ? `${extras.exposure_at_last_transition.unmanagedCount} unmanaged position(s)` : 'none recorded'}</td></tr>
              </tbody>
            </table>
            {session.activity_state === 'STARTING' && (
              <>
                <h3>Cold-start gates (D63)</h3>
                <table className="mono" style={{ borderCollapse: 'collapse' }}>
                  <tbody>
                    {session.cold_start_gates.map((g) => (
                      <tr key={g.name}><td style={cell}>{g.passed ? '✓' : '✗'}</td><td style={cell}>{g.name}</td><td style={{ padding: '0.2rem 0' }} className="muted">{g.detail ?? ''}</td></tr>
                    ))}
                    {session.cold_start_gates.length === 0 && <tr><td className="muted">No gate evaluated yet.</td></tr>}
                  </tbody>
                </table>
                {gatesFailed.length > 0 && <p className="muted">Entries stay blocked until every gate passes; the worker re-evaluates each tick.</p>}
              </>
            )}
            {session.activity_state === 'WIND_DOWN' && (
              <p className="muted">Winding down: {session.wind_down_blockers.length ? session.wind_down_blockers.join('; ') : 'closing lots and draining in-flight execution'}. OFF follows only at zero unmanaged exposure (D61).</p>
            )}
            {session.transitions.length > 0 && (
              <p className="muted mono" style={{ fontSize: '0.8rem' }}>
                {session.transitions.slice(-5).map((t, i) => <span key={i}>{t.from}→{t.to} by {t.actor} {ago(t.at, now)}{i < Math.min(5, session.transitions.length) - 1 ? ' · ' : ''}</span>)}
              </p>
            )}
            {session.activity_state === 'OFF' && (
              <form action={requestStartSession}><button className="btn" type="submit" disabled={!canControl}>START SESSION</button></form>
            )}
          </>
        )}
      </section>

      <div style={grid}>
        <section className="panel">
          <h2>Portfolio / P&amp;L <span className="muted" style={{ fontWeight: 400 }}>· trading P&amp;L (economic view after M10)</span></h2>
          {!equity.latest ? (
            <p className="muted">No portfolio snapshot yet.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={cell} className="muted">equity</td><td style={cell}>{usd(latestEquity)} <span className="muted">as of {ago(equity.latest.as_of, now)}</span></td></tr>
                <tr><td style={cell} className="muted">available capital</td><td style={cell}>{available === null ? '—' : usd(available)} <span className="muted">equity − sleeve commitments</span></td></tr>
                <tr><td style={cell} className="muted">exposure</td><td style={cell}>{pct(equity.latest.exposure_fraction)} ({usd(baseToUsd(equity.latest.exposure_base_units))})</td></tr>
                <tr><td style={cell} className="muted">day P&amp;L</td><td style={cell}>{dayPnl === null ? '— (no day-start snapshot)' : usd(dayPnl)}</td></tr>
                <tr><td style={cell} className="muted">unrealized / realized (open)</td><td style={cell}>{unrealized === null ? 'unmarked' : usd(unrealized)} / {usd(realized)}</td></tr>
                <tr><td style={cell} className="muted">drawdown daily / rolling</td><td style={cell}>{pct(drawdown?.dailyFraction)} of {pct(drawdown?.dailyLimit)} · {pct(drawdown?.rollingFraction)} of {pct(drawdown?.rollingLimit)}</td></tr>
                <tr><td style={cell} className="muted">circuit breaker</td><td style={cell}>{drawdown?.breakerTripped === null || drawdown?.breakerTripped === undefined ? 'no risk evaluation yet' : drawdown.breakerTripped ? <span className="chip" data-tone="failed"><span className="v">TRIPPED</span></span> : <span className="chip" data-tone="ok"><span className="v">ARMED</span></span>}</td></tr>
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Agent now</h2>
          {agentNow.length === 0 ? (
            <p className="muted">No action cycle in flight. {recent[0] ? `Last: ${recent[0].asset?.symbol ?? 'unknown'} ${recent[0].proposed_action ?? ''} ${recent[0].state} ${ago(recent[0].terminal_at, now)}.` : ''}</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {agentNow.map((c) => (
                <li key={c.id}>
                  <a href={`/agent-activity/${c.id}`}>{c.asset?.symbol ?? 'unknown'}</a> — {c.trigger?.family ?? (c.position_id ? 'reassessment' : 'trigger')} · {c.strategy_version_id}
                  <div className="muted">stage {stageLabel(c)} · proposer {c.proposed_action ?? '…'}{c.proposal && Number.isFinite(c.proposal.confidence) ? ` .${Math.round(c.proposal.confidence * 100)}` : ''} · adversary {c.verdict ?? '…'}{c.revision_round > 0 ? ` round ${c.revision_round + 1}` : ''} · {c.risk_evaluation_id ? 'risk evaluated' : 'risk pending'} · {c.intent_id ? 'execution' : 'no intent'}</div>
                </li>
              ))}
            </ul>
          )}
          <h3 style={{ margin: '0.7rem 0 0.3rem' }}>Upcoming</h3>
          {upcoming.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing scheduled: no open-position reassessment, candidate expiry, automation cooldown, readiness expiry or session deadline is recorded.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {upcoming.map((u, i) => (
                <li key={i}>{Date.parse(u.at) < now ? 'due now' : `in ${durationLabel(Date.parse(u.at) - now)}`} · {u.href ? <a href={u.href}>{u.label}</a> : u.label} <span className="muted">{u.kind}</span></li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Open positions ({positions.length})</h2>
          {positions.length === 0 ? (
            <p className="muted">None open.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['token', 'P&L', 'stop', 'review', 'safety', 'protection'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>{p.symbol} <span className="muted">{p.strategies.join('/') || 'no lot'}</span></td>
                    <td style={cell}>{p.unrealized_pnl_base_units === null ? 'unmarked' : usd(Number(p.unrealized_pnl_base_units) / 1e6)}</td>
                    <td style={cell}>{p.unreviewed_stop !== null ? p.unreviewed_stop.toPrecision(4) : p.stop?.level ? Number(p.stop.level).toPrecision(4) : 'no stop'}</td>
                    <td style={cell}><span className="chip" data-tone={p.review_state === 'REVIEWED' ? 'ok' : 'failed'}><span className="v">{p.review_state}</span></span></td>
                    <td style={cell}><span className="chip" data-tone={p.safety_state === 'NORMAL' ? 'ok' : 'failed'}><span className="v">{p.safety_state}</span></span></td>
                    <td style={cell}>{p.stop?.model ?? 'deterministic'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}><a href="/positions">Positions workspace</a></p>
        </section>

        <section className="panel">
          <h2>Opportunity queue ({queue.length})</h2>
          {queue.length === 0 ? (
            <p className="muted">No live candidate. The scanner writes candidates when a trigger family fires on an eligible asset.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['token', 'score', 'age', 'trigger', 'strategies', 'state', 'expires'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {queue.map((c) => (
                  <tr key={c.id}>
                    <td style={cell}>{c.symbol}</td>
                    <td style={cell}>{c.scanner_score.toFixed(0)}</td>
                    <td style={cell}>{ago(c.discovered_at, now)}</td>
                    <td style={cell}>{c.trigger_family}</td>
                    <td style={cell}>{c.strategy_version_ids.length > 0 ? c.strategy_version_ids.map((s) => s.split('@')[0]).join(', ') : '—'}</td>
                    <td style={cell}>{c.status}{c.deterministic_rejection_reason ? ` (${c.deterministic_rejection_reason})` : ''}</td>
                    <td style={cell}>{durationLabel(Date.parse(c.expires_at) - now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Risk / sleeve utilisation</h2>
          {sleeves.length === 0 ? (
            <p className="muted">No active strategy sleeve on this account.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['sleeve', 'committed / cap', 'risk used / budget', 'utilisation'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {sleeves.map((s) => (
                  <tr key={s.strategy_version_id}>
                    <td style={cell}>{s.strategy_version_id}</td>
                    <td style={cell}>{usd(baseToUsd(s.committed_base_units))} / {usd(baseToUsd(s.capital_cap_base_units))}</td>
                    <td style={cell}>{usd(baseToUsd(s.risk_used_base_units))} / {usd(baseToUsd(s.risk_budget_base_units))}</td>
                    <td style={cell}>{s.utilisation === null ? '—' : <span className="chip" data-tone={s.utilisation > 0.9 ? 'degraded' : 'ok'}><span className="v">{pct(s.utilisation)}</span></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>
            Cohort exposure: {equity.latest?.per_cohort && equity.latest.per_cohort.length > 0 ? equity.latest.per_cohort.map((c) => `${c.cohortId.slice(0, 8)} ${pct(c.exposureFraction)}`).join(' · ') : 'no cohort exposure recorded in the latest snapshot'} · per-token cap {pct(DEFAULT_RISK_POLICY.maxExposurePerTokenFraction)}
          </p>
          <p className="muted" style={{ margin: '0.2rem 0 0' }}>
            Wallet reserve: {reserve ? `gas ${reserve.gas.state}${reserve.gas.observed ? ` (${lamportsToSol(reserve.gas.observed)} SOL)` : ''} · settlement ${reserve.settlement.state}${reserve.settlement.observed ? ` (${usd(baseToUsd(reserve.settlement.observed))})` : ''}` : 'no reconciliation observation'} · <a href="/wallet">Wallet / Custody</a>
          </p>
        </section>

        <section className="panel">
          <h2>Alerts / recent actions</h2>
          {alerts.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No open alert.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {alerts.map((a) => (
                <li key={a.id}>
                  <span className="chip" data-tone={a.severity === 'CRITICAL' ? 'failed' : a.severity === 'HIGH' ? 'degraded' : 'unknown'}><span className="v">{a.severity}</span></span> {a.alert_class} · {a.summary} · {ago(a.raised_at, now)}
                  {a.automated_response ? ` · auto: ${a.automated_response}` : ''}{a.acknowledged_at ? ' · acknowledged' : ' · unacknowledged'}
                </li>
              ))}
            </ul>
          )}
          <p className="muted" style={{ margin: '0.3rem 0 0.5rem' }}><a href="/alerts">Alert center</a></p>
          <h3 style={{ margin: '0.5rem 0 0.3rem' }}>Recent actions</h3>
          {recent.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No completed cycle yet.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {recent.map((c) => (
                <li key={c.id}>
                  {ago(c.terminal_at, now)} · <a href={`/agent-activity/${c.id}`}>{c.asset?.symbol ?? 'unknown'}</a> {c.proposed_action ?? '—'} · {c.state}{c.reason_codes.length ? ` (${c.reason_codes.slice(0, 3).join(', ')})` : ''} <span className="muted">{c.strategy_version_id.split('@')[0]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Health summary</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={cell} className="muted">providers</td><td style={cell}>{health.providers.total === 0 ? 'no provider health rows' : `${health.providers.healthy} healthy · ${health.providers.degraded} degraded · ${health.providers.failed} failed`}</td></tr>
              <tr><td style={cell} className="muted">worker roles</td><td style={cell}>{health.roles === 0 ? 'no lease held' : `${health.roles} lease(s)`}{health.staleRoles.length ? ` · expired: ${health.staleRoles.join(', ')}` : ''}</td></tr>
              <tr><td style={cell} className="muted">executor</td><td style={cell}>{health.executor.healthy === null ? 'not configured / not probed' : health.executor.healthy ? 'HEALTHY' : 'UNHEALTHY'}</td></tr>
              <tr><td style={cell} className="muted">database</td><td style={cell}>{supabase ? 'reachable (this page loaded from it)' : 'unconfigured'}</td></tr>
              <tr><td style={cell} className="muted">reconciliation</td><td style={cell}>{health.reconciliation ? `${health.reconciliation.status} ${ago(health.reconciliation.evaluated_at, now)}` : 'never evaluated'}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}><a href="/health">System Health</a> · <a href="/readiness">Live Readiness</a></p>
        </section>

        <section className="panel">
          <h2>Model / data spend today</h2>
          {spend.budgets.length === 0 ? (
            <p className="muted">No spend budget row is active; the worker applies the D43 defaults (platform ${spend.defaults.platform.modelUsdPerDay}/day, strategy ${spend.defaults.strategy.modelUsdPerDay}/day and {spend.defaults.strategy.cyclesPerHour} cycles/h, provider {spend.defaults.provider.providerRequestsPerMinute} req/min) and no usage window has been charged.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['scope', 'cycles', 'model USD', 'provider req', 'state'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {spend.budgets.map((b, i) => (
                  <tr key={i}>
                    <td style={cell}>{b.scope}{b.scope_id ? ` ${b.scope_id}` : ''} <span className="muted">{b.version_id}</span></td>
                    <td style={cell}>{b.usage ? b.usage.cycles : 'no window'} / {b.limits.cyclesPerHour ?? '∞'} per h</td>
                    <td style={cell}>{b.usage ? `$${b.usage.model_usd.toFixed(2)}` : 'no window'} / {b.limits.modelUsdPerDay === null ? '∞' : `$${b.limits.modelUsdPerDay}`} per day</td>
                    <td style={cell}>{b.usage ? b.usage.provider_requests : 'no window'} / {b.limits.providerRequestsPerMinute ?? '∞'} per min</td>
                    <td style={cell}>{b.usage ? <span className="chip" data-tone={b.usage.state === 'OK' ? 'ok' : 'failed'}><span className="v">{b.usage.state}</span></span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Pending control requests</h2>
          {pending.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {pending.map((r, i) => <li key={i}>{r.kind} · {r.state} · {ago(r.created_at, now)}</li>)}
            </ul>
          )}
          <p className="muted">Requests are acted on by the worker's session role after role, step-up and state checks; the browser never executes a control itself. Global pause: the PAUSE button, or hold <span className="mono">Shift+P</span> for one second on any route.</p>
          <p className="mono muted" style={{ margin: 0 }}>contract set {digest.digest.slice(0, 16)}… · {digest.schemaCount} schemas</p>
        </section>
      </div>
    </>
  );
}

function durationLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const s = Math.round(abs / 1000);
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86_400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  return ms < 0 ? `${text} ago` : text;
}
