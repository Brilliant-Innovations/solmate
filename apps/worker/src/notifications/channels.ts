import type { NotificationChannel } from '@sol-agent-trader/contracts';

/**
 * Delivery channels (blueprint §20.20). Each sender either confirms or returns an error; the role
 * persists both. An unconfigured channel is a sender that always fails with CHANNEL_NOT_CONFIGURED,
 * so a CRITICAL alert that cannot reach two channels is visible as failed deliveries, never as
 * silence. No SDKs: Telegram is one HTTPS POST to the Bot API.
 */

export interface OutboundNotification {
  id: string;
  severity: string;
  alertClass: string;
  summary: string;
  escalationLevel: number;
  raisedAt: string;
}

export interface NotificationSender {
  readonly channel: NotificationChannel;
  readonly configured: boolean;
  send(n: OutboundNotification): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** The notification row itself is the in-app delivery: always confirmed. */
export const inAppSender: NotificationSender = { channel: 'IN_APP', configured: true, async send() { return { ok: true }; } };

export function unconfiguredSender(channel: NotificationChannel): NotificationSender {
  return { channel, configured: false, async send() { return { ok: false, error: 'CHANNEL_NOT_CONFIGURED' }; } };
}

export function formatAlert(n: OutboundNotification): string {
  const head = n.escalationLevel > 0 ? `[${n.severity}] ${n.alertClass} (escalation ${n.escalationLevel})` : `[${n.severity}] ${n.alertClass}`;
  return `${head}\n${n.summary}\nraised ${n.raisedAt}`;
}

export function telegramSender(opts: { botToken: string; chatId: string; fetchImpl?: typeof fetch; timeoutMs?: number }): NotificationSender {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    channel: 'TELEGRAM',
    configured: true,
    async send(n) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: opts.chatId, text: formatAlert(n), disable_web_page_preview: true }),
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, error: `telegram ${res.status}` };
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        return body.ok === false ? { ok: false, error: `telegram: ${body.description ?? 'not ok'}` } : { ok: true };
      } catch (err) {
        return { ok: false, error: `telegram: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
