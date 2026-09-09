import { When } from '../../../components/when';
import { ago } from '../../../lib/paper';
import { loadAlerts, remaining } from '../../../lib/ops';
import { getOperatorSession } from '../../../lib/supabase/server';
import { requestAcknowledgeAlert } from '../ops-actions';

export const dynamic = 'force-dynamic';

/**
 * Alert center (§20.20, §20.21). Open alerts by severity with every delivery attempt and its
 * confirmation or error, the automated response the runtime already took, the dead-man deadline
 * for the classes that carry one, and acknowledgement (fast, no step-up). CRITICAL alerts stay
 * here until acknowledged or resolved; nothing disappears as a toast.
 */
export default async function Alerts() {
  const [{ open, recent, deliveries }, operator] = await Promise.all([loadAlerts(), getOperatorSession()]);
  const canAck = operator?.role === 'operator' || operator?.role === 'admin';
  const now = Date.now();
  const rank = { CRITICAL: 3, HIGH: 2, NOTICE: 1, INFO: 0 } as const;
  const sorted = [...open].sort((a, b) => rank[b.severity] - rank[a.severity] || Date.parse(b.raised_at) - Date.parse(a.raised_at));
  const tone = (s: string) => (s === 'CRITICAL' ? 'failed' : s === 'HIGH' ? 'degraded' : s === 'NOTICE' ? 'paper' : 'unknown');
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Alert Center</h1>
      <section className="panel">
        <h2>Open ({sorted.length})</h2>
        {sorted.length === 0 ? (
          <p className="muted">No open alerts.</p>
        ) : (
          sorted.map((n) => {
            const d = deliveries.filter((x) => x.notification_id === n.id);
            const confirmed = new Set(d.filter((x) => x.confirmed_at).map((x) => x.channel));
            const deadline = n.dead_man_deadline ? remaining(n.dead_man_deadline, now) : null;
            return (
              <div key={n.id} style={{ borderTop: '1px solid var(--rule)', padding: '0.6rem 0' }}>
                <p className="mono" style={{ margin: 0 }}>
                  <span className="chip" data-tone={tone(n.severity)}><span className="v">{n.severity}</span></span> <strong>{n.alert_class}</strong> · raised <When iso={n.raised_at} now={now} label="raised" />
                  {n.escalation_level > 0 ? ` · escalation ${n.escalation_level}` : ''}
                  {n.acknowledged_at ? ` · acknowledged ${ago(n.acknowledged_at, now)}` : ' · unacknowledged'}
                </p>
                <p style={{ margin: '0.3rem 0' }}>{n.summary}</p>
                <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
                  {n.automated_response ? `automated response: ${n.automated_response} · ` : ''}
                  {deadline ? (n.dead_man_action_taken ? `dead-man: ${n.dead_man_action_taken} applied` : `dead-man pause in ${deadline.text}`) : 'no dead-man rule for this class'}
                  {' · delivered: '}
                  {d.length === 0 ? 'no attempt yet' : [...new Set(d.map((x) => x.channel))].map((c) => `${c}${confirmed.has(c) ? ' ✓' : ` ✗ ${d.find((x) => x.channel === c)?.error ?? ''}`}`).join(', ')}
                  {n.severity === 'CRITICAL' && confirmed.size < 2 ? ' · CRITICAL needs two confirmed channels' : ''}
                </p>
                {!n.acknowledged_at && (
                  <form action={requestAcknowledgeAlert} style={{ marginTop: '0.4rem' }}>
                    <input type="hidden" name="notificationId" value={n.id} />
                    <button className="btn" type="submit" disabled={!canAck} title="Acknowledges through a control request; the notifications role records who and when">
                      ACKNOWLEDGE
                    </button>
                  </form>
                )}
              </div>
            );
          })
        )}
      </section>
      <section className="panel">
        <h2>Recently resolved</h2>
        {recent.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="mono">
            {recent.map((n) => (
              <li key={n.id}>
                <span className="chip" data-tone={tone(n.severity)}><span className="v">{n.severity}</span></span> {n.alert_class} · raised {ago(n.raised_at, now)} · resolved {ago(n.resolved_at, now)}
                {n.acknowledged_at ? ' · acknowledged' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
