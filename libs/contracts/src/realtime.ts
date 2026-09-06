import { z } from 'zod';
import { Instant, Sha256Hex, Uuid } from './primitives.js';

/**
 * Realtime UI events (blueprint §5.3, §20.23). Broadcast on private Supabase channels by backend
 * services; the browser refetches authoritative detail after receiving one. Payloads carry ids and
 * timestamps only, never financial values, so a broadcast can never masquerade as chain or ledger
 * truth (§20.0 principle 10).
 */

export const RealtimeEventName = z.enum([
  'market.snapshot.updated',
  'action_cycle.stage_changed',
  'proposal.created',
  'adversary.reviewed',
  'risk.evaluated',
  'intent.authorized',
  'execution.attempt_changed',
  'position.changed',
  'protection.changed',
  'health.changed',
  'readiness.changed',
  'release.promoted',
  'spend.threshold_crossed',
  'notification.delivery_failed',
  'position.review_state_changed',
  'custody.reconciled',
  'alert.raised',
  'mode.changed',
]);
export type RealtimeEventName = z.infer<typeof RealtimeEventName>;

export const RealtimeEvent = z.strictObject({
  event: RealtimeEventName,
  at: Instant,
  /** Canonical ids of the entities the UI should refetch. */
  ids: z.record(z.string().min(1).max(64), z.string().min(1).max(128)),
  /** LIVE / PAPER:<book> / REPLAY:<run> scope selector value (§20.1). */
  scope: z.string().min(1).max(128),
  correlationId: z.string().min(1).max(128),
  contractSetDigest: Sha256Hex,
  emittedBy: z.enum(['worker', 'risk-authorizer', 'execution-service', 'web']),
  sequence: z.number().int().nonnegative(),
  sessionId: Uuid.nullable(),
});
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/** Channel naming: one private channel per operator-visible scope. */
export function realtimeChannel(scope: string): string {
  return `ops:${scope}`;
}
