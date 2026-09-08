import { StepUpRequest } from '../../../components/step-up-request';
import { loadApprovalCards } from '../../../lib/approvals';
import { ago, baseToUsd, tokens, usd } from '../../../lib/paper';
import { loadControlRequests, remaining } from '../../../lib/ops';
import { loadMyPasskeys } from '../../../lib/settings';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestRejectAuthorization } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Approval Queue (§20.8, §15.6, D41). Every card is an intent the adversary cleared and the
 * risk-authorizer signed. Before approval the operator sees token/strategy/action, the thesis and
 * adversary verdict, the exact maximum authorized amount, account exposure after the trade, the
 * stop/protection plan, the executable quote and its freshness, the authorization expiry countdown,
 * the signed authorization hash and the risk reasons for allow. Approve is exact (no editing in
 * place) and needs a passkey step-up; Reject is fast; Open full decision drills into the inspector.
 * Cleared REDUCE/EXIT intents auto-execute and are listed as informational rows with a cancel
 * control until submission. A strategy whose live intent expiry is below the human-reaction floor
 * is NOT ELIGIBLE FOR LIVE_APPROVAL.
 */
export default async function Approvals() {
  const now = Date.now();
  const [operator, { cards, informational }, requests] = await Promise.all([getOperatorSession(), loadApprovalCards(), loadControlRequests(['APPROVE_AUTHORIZATION', 'REJECT_AUTHORIZATION'], 20)]);
  const passkeys = await loadMyPasskeys(operator?.userId ?? null);
  const canControl = operator?.aal === 'aal2' && (operator.role === 'operator' || operator.role === 'admin');
  const rpId = process.env['NEXT_PUBLIC_WEBAUTHN_RP_ID'] ?? null;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Approval Queue</h1>
      <section className="panel" data-authority="live-approval">
        <h2>Awaiting approval ({cards.length})</h2>
        {cards.length === 0 ? (
          <p className="muted">Nothing awaits approval. Authorizations appear here only for a LIVE account under LIVE_APPROVAL; the paper book never needs an envelope.</p>
        ) : (
          cards.map((c) => {
            const q = c.queue;
            const i = q.intents;
            if (!i) return <div key={q.intent_id} className="muted mono">authorization {q.authorization_hash.slice(0, 12)}… has no readable intent</div>;
            const left = remaining(q.expires_at, now);
            const msLeft = Date.parse(q.expires_at) - now;
            const nearExpiry = msLeft < 10_000;
            const ins = c.inspector;
            const proposal = ins?.proposals.at(-1) ?? null;
            const review = ins?.reviews.at(-1) ?? null;
            const risk = ins?.risk ?? null;
            const maxUsd = baseToUsd(i.max_input_amount);
            const equity = c.exposure ? baseToUsd(c.exposure.equity_base_units) : null;
            const exposure = c.exposure ? baseToUsd(c.exposure.exposure_base_units) : null;
            const after = exposure !== null && maxUsd !== null ? exposure + maxUsd : null;
            const afterFraction = after !== null && equity !== null && equity > 0 ? after / equity : null;
            const floorViolated = c.strategy ? c.strategy.live_intent_expiry_ms < c.strategy.human_reaction_floor_ms : false;
            const quoteAge = c.quote ? now - Date.parse(c.quote.quoted_at) : null;
            const maxQuoteAge = typeof c.constraints?.['maxQuoteAgeMs'] === 'number' ? (c.constraints['maxQuoteAgeMs'] as number) : null;
            return (
              <div key={q.intent_id} style={{ borderTop: '1px solid var(--rule)', padding: '0.7rem 0' }}>
                <p className="mono" style={{ margin: '0 0 0.4rem', fontSize: '1.05rem' }}>
                  <strong>{c.symbol}</strong> · {i.action} {i.side} · {i.strategy_version_id} ·{' '}
                  <span className="chip" data-tone={left.expired ? 'failed' : nearExpiry ? 'failed' : msLeft < 60_000 ? 'degraded' : 'ok'} style={{ fontSize: '1.1rem' }}><span className="k">expires in</span><span className="v">{left.text}</span></span>
                  {floorViolated && <> <span className="chip" data-tone="failed"><span className="v">NOT ELIGIBLE FOR LIVE_APPROVAL</span></span></>}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '0.8rem' }}>
                  <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
                    <tr><td style={cell} className="muted">exact max authorized</td><td style={cell}><strong>{usd(maxUsd)}</strong> <span className="muted">({tokens(i.max_input_amount, 6)} settlement units; cannot be edited here)</span></td></tr>
                    <tr><td style={cell} className="muted">exposure after trade</td><td style={cell}>{after === null ? 'no portfolio snapshot' : `${usd(after)}${afterFraction !== null ? ` (${(afterFraction * 100).toFixed(1)}% of equity ${usd(equity)})` : ''}`}{c.exposure ? <span className="muted"> · snapshot {ago(c.exposure.as_of, now)}</span> : null}</td></tr>
                    <tr><td style={cell} className="muted">stop / protection plan</td><td style={{ ...cell, whiteSpace: 'normal' }}>{risk?.stop_policy ? JSON.stringify(risk.stop_policy) : 'no stop policy on the evaluation'}{risk?.target_policy ? ` · target ${JSON.stringify(risk.target_policy)}` : ''}{c.protection_policy_ref ? ` · protection ${c.protection_policy_ref}` : ''}</td></tr>
                    <tr><td style={cell} className="muted">executable quote</td><td style={cell}>{c.quote ? `${c.quote.purpose} · impact ${c.quote.price_impact_bps ?? '—'} bp · ${c.quote.router_label ?? 'Jupiter'} · ` : 'no quote probe recorded · '}<span className="chip" data-tone={quoteAge === null ? 'unknown' : maxQuoteAge !== null && quoteAge > maxQuoteAge ? 'failed' : 'ok'}><span className="v">{quoteAge === null ? 'NO QUOTE' : `${(quoteAge / 1000).toFixed(1)}s old`}</span></span>{maxQuoteAge !== null ? <span className="muted"> · limit {(maxQuoteAge / 1000).toFixed(0)}s</span> : null}</td></tr>
                    <tr><td style={cell} className="muted">risk allow reasons</td><td style={{ ...cell, whiteSpace: 'normal' }}>{risk ? `${risk.allowed ? 'ALLOW' : 'DENY'} · ${risk.policy_version}${risk.reason_codes.length ? ` · ${risk.reason_codes.join(', ')}` : ' · no reason codes'} · slippage ≤ ${risk.max_slippage_bps} bp · impact ≤ ${risk.max_price_impact_bps} bp` : 'risk evaluation not readable'}</td></tr>
                    <tr><td style={cell} className="muted">authorization</td><td style={{ ...cell, whiteSpace: 'normal', wordBreak: 'break-all' }}>{q.authorization_hash} <span className="muted">· issued {ago(q.created_at, now)}</span></td></tr>
                  </tbody></table>
                  <div>
                    <div className="mono"><span className="chip" data-tone={proposal?.source === 'AI' ? 'watch' : 'paper'}><span className="v">{proposal?.source === 'AI' ? 'AI' : 'DETERMINISTIC'}</span></span> proposer thesis</div>
                    <p style={{ margin: '0.2rem 0 0.5rem' }}>{proposal?.proposal.thesis ?? 'no proposal readable'}{proposal && typeof proposal.proposal.confidence === 'number' ? <span className="muted mono"> · confidence {proposal.proposal.confidence.toFixed(2)}</span> : null}</p>
                    <div className="mono"><span className="chip" data-tone={review && !review.deterministic_gate ? 'watch' : 'paper'}><span className="v">{review && !review.deterministic_gate ? 'AI' : 'DETERMINISTIC'}</span></span> adversary {review?.verdict ?? '—'}</div>
                    {review && review.objections.length > 0 ? <ul style={{ margin: '0.2rem 0 0.5rem', paddingLeft: '1rem' }}>{review.objections.map((o, k) => <li key={k}><span className="mono">{o.code}</span> — {o.detail}</li>)}</ul> : <p className="muted" style={{ margin: '0.2rem 0 0.5rem' }}>no objections</p>}
                    {c.strategy && <p className="muted mono" style={{ margin: 0 }}>live intent expiry {c.strategy.live_intent_expiry_ms / 1000}s · human-reaction floor {c.strategy.human_reaction_floor_ms / 1000}s · authorities {c.strategy.eligible_capital_authorities.join(', ') || 'none'}</p>}
                  </div>
                </div>
                <div className="controls" style={{ marginTop: '0.6rem', gap: '0.6rem' }}>
                  <StepUpRequest kind="APPROVE_AUTHORIZATION" payload={{ intentId: q.intent_id, source: 'approval-queue' }} label="Approve exact intent" passkeys={passkeys} rpId={rpId} disabled={!canControl || left.expired || nearExpiry || floorViolated} title="APPROVE_AUTHORIZATION: passkey step-up; the approvals role signs a grant bound to this exact authorization hash" />
                  <form action={requestRejectAuthorization}>
                    <input type="hidden" name="intentId" value={q.intent_id} />
                    <button className="btn" type="submit" disabled={!canControl} title="REJECT_AUTHORIZATION: cancels the intent; no step-up">Reject</button>
                  </form>
                  {ins ? <a className="btn" href={`/agent-activity/${ins.cycle.id}`}>Open full decision</a> : null}
                  {nearExpiry && !left.expired && <span className="muted mono">approval disabled in the last seconds before envelope expiry</span>}
                </div>
              </div>
            );
          })
        )}
        <p className="muted">An authorization that expires unapproved is recorded as EXPIRED_BY_LATENCY by the live-entry role; nothing is retried on the operator's behalf. Any change to amount or asset is a new proposal and a new authorization.</p>
      </section>

      <section className="panel">
        <h2>Auto-executing risk reductions ({informational.length})</h2>
        {informational.length === 0 ? (
          <p className="muted">No cleared REDUCE / EXIT intent in flight. They execute without approval by default and appear here with a cancel control until submission.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['token', 'action', 'strategy', 'max input', 'state', 'created', 'expires', ''].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              {informational.map((i) => (
                <tr key={i.id}>
                  <td style={cell}>{i.symbol}</td>
                  <td style={cell}>{i.action} {i.side}</td>
                  <td style={cell}>{i.strategy_version_id}</td>
                  <td style={cell}>{usd(baseToUsd(i.max_input_amount))}</td>
                  <td style={cell}>{i.lifecycle_state}</td>
                  <td style={cell}>{ago(i.created_at, now)}</td>
                  <td style={cell}>{remaining(i.expires_at, now).text}</td>
                  <td style={cell}>
                    <form action={requestRejectAuthorization}><input type="hidden" name="intentId" value={i.id} /><button className="btn" type="submit" disabled={!canControl} title="Cancels before submission; a submitted attempt is recovery's business">Cancel</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Recent decisions</h2>
        {requests.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {requests.map((r) => (
              <li key={r.id}>
                {r.kind} · intent {String(r.payload['intentId'] ?? '?').slice(0, 8)} · {r.state} · {ago(r.created_at, now)}
                {r.resolution ? <span className="muted"> · {String(r.resolution['reason'] ?? (r.resolution['cancelled'] ? 'cancelled' : r.resolution['authorizationHash'] ? `grant ${String(r.resolution['authorizationHash']).slice(0, 12)}…` : ''))}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
