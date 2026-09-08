import { z } from 'zod';
import { AlertSeverity } from '../enums.js';
import { NotificationChannel } from '../entities/ops.js';
import { Milliseconds, VersionId } from '../primitives.js';

/**
 * Notifications and alert UX policy (blueprint §20.20, D42; execution plan M8a). Severity maps
 * to channels; CRITICAL needs two configured channels; unacknowledged CRITICAL alerts re-send on
 * a schedule; a dead-man class left unacknowledged past the interval makes the runtime apply
 * `PAUSE_NEW_ENTRIES` itself (never `EMERGENCY_CLOSE_ALL`); a `SYSTEM_ALIVE` heartbeat is
 * delivered while a session is active so silence is observable. Quiet hours never suppress
 * CRITICAL, and v1 has no quiet hours at all.
 */

export const AlertClass = z.enum([
  'CUSTODY_RECONCILIATION_MISMATCH',
  'RECONCILIATION_UNAVAILABLE',
  'UNABLE_TO_EXIT',
  'EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS',
  'SIGNER_UNAVAILABLE_WITH_EXPOSURE',
  'CHAIN_ENTRIES_BLOCKED',
  'RESERVE_BELOW_THRESHOLD',
  'OPERATOR_ABSENT_WITH_EXPOSURE',
  'PROVIDER_FEED_BLOCKING',
  'DEAD_MAN_PAUSE_APPLIED',
  'OFFLINE_RESUME_OVERDUE',
  'RUNTIME_HEARTBEAT_MISSING',
  'DB_OUTAGE_EMERGENCY_ACTION_IMPORTED',
  'SYSTEM_ALIVE',
]);
export type AlertClass = z.infer<typeof AlertClass>;

export const NotificationPolicy = z.strictObject({
  version: VersionId,
  channelsBySeverity: z.strictObject({
    INFO: z.array(NotificationChannel),
    NOTICE: z.array(NotificationChannel),
    HIGH: z.array(NotificationChannel),
    CRITICAL: z.array(NotificationChannel).min(2),
  }),
  /** CRITICAL must reach at least this many distinct channels with a confirmed delivery. */
  criticalMinConfirmedChannels: z.number().int().min(2),
  /** Unacknowledged CRITICAL alerts re-send after this long, up to the maximum level. */
  escalationIntervalMs: Milliseconds,
  escalationMaxLevel: z.number().int().min(1).max(10),
  /** Dead-man rule: these classes, unacknowledged past the interval, pause new entries automatically. */
  deadManClasses: z.array(AlertClass).min(1),
  deadManIntervalMs: Milliseconds,
  heartbeatIntervalMs: Milliseconds,
  /** Reconciliation UNAVAILABLE for longer than this is an alert of its own. */
  reconciliationUnavailableAfterMs: Milliseconds,
});
export type NotificationPolicy = z.infer<typeof NotificationPolicy>;

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  version: 'notifications-v1' as VersionId,
  channelsBySeverity: {
    INFO: ['IN_APP'],
    NOTICE: ['IN_APP'],
    HIGH: ['IN_APP', 'TELEGRAM'],
    CRITICAL: ['IN_APP', 'TELEGRAM', 'EMAIL'],
  },
  criticalMinConfirmedChannels: 2,
  escalationIntervalMs: 10 * 60_000,
  escalationMaxLevel: 3,
  deadManClasses: ['UNABLE_TO_EXIT', 'CUSTODY_RECONCILIATION_MISMATCH', 'EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS'],
  deadManIntervalMs: 15 * 60_000,
  heartbeatIntervalMs: 30 * 60_000,
  reconciliationUnavailableAfterMs: 10 * 60_000,
};

export const SeverityOf: Record<AlertClass, z.infer<typeof AlertSeverity>> = {
  CUSTODY_RECONCILIATION_MISMATCH: 'CRITICAL',
  RECONCILIATION_UNAVAILABLE: 'HIGH',
  UNABLE_TO_EXIT: 'CRITICAL',
  EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS: 'CRITICAL',
  SIGNER_UNAVAILABLE_WITH_EXPOSURE: 'CRITICAL',
  CHAIN_ENTRIES_BLOCKED: 'HIGH',
  RESERVE_BELOW_THRESHOLD: 'NOTICE',
  OPERATOR_ABSENT_WITH_EXPOSURE: 'HIGH',
  PROVIDER_FEED_BLOCKING: 'NOTICE',
  DEAD_MAN_PAUSE_APPLIED: 'HIGH',
  OFFLINE_RESUME_OVERDUE: 'CRITICAL',
  RUNTIME_HEARTBEAT_MISSING: 'CRITICAL',
  DB_OUTAGE_EMERGENCY_ACTION_IMPORTED: 'CRITICAL',
  SYSTEM_ALIVE: 'INFO',
};
