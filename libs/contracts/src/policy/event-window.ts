import { z } from 'zod';
import { SourceTimeConfidence, TradingActionType } from '../enums.js';
import { Milliseconds, Uuid, VersionId } from '../primitives.js';

/**
 * EVENT_WINDOW cap policy (blueprint §12.3A, D60, D64). The Trading Skill may propose that a fresh
 * catalyst deserves a bounded intensive window; deterministic policy decides whether one opens and
 * exactly how long, from the trustworthy source time (T0), never from the proposal's wishes. A
 * window never widens capital or risk policy and cannot extend stale catalyst age.
 */
export const EventWindowRequest = z.strictObject({
  /** The catalyst evidence id the window rests on; must be a packet evidence id (validated like any citation). */
  catalystEvidenceId: Uuid,
  expectedHalfLifeMinutes: z.number().int().positive().max(24 * 60),
  requestedDurationMinutes: z.number().int().positive().max(24 * 60),
});
export type EventWindowRequest = z.infer<typeof EventWindowRequest>;

export const EventWindowCapPolicy = z.strictObject({
  version: VersionId,
  /** Source-time confidence the catalyst needs for a window to open at all (§10.3 two clocks). */
  minSourceTimeConfidence: SourceTimeConfidence,
  /** Catalyst age at open, measured from T0, above which no window opens (D64). */
  maxCatalystAgeMs: Milliseconds,
  /** Hard ceiling on the window measured from T0, whatever was requested. */
  maxDurationMs: Milliseconds,
  /** Reassessment cadence inside the window (faster than the tier heartbeat). */
  cadenceMs: Milliseconds,
  /** After this long inside the window a confirmation/retest is required before any further entry. */
  requireRetestAfterMs: Milliseconds.nullable(),
  /** Extensions allowed, each needing genuinely new information (a newer catalyst with NEW relation). */
  maxExtensions: z.number().int().min(0),
  extensionMs: Milliseconds,
  /** Actions the skill may propose while the window is open. */
  allowedActions: z.array(TradingActionType).min(1),
  /** Activity state after expiry. */
  expiryBehavior: z.enum(['WATCH', 'ACTIVE']),
});
export type EventWindowCapPolicy = z.infer<typeof EventWindowCapPolicy>;

export const DEFAULT_EVENT_WINDOW_CAP_POLICY: EventWindowCapPolicy = {
  version: 'event-window-v1' as VersionId,
  minSourceTimeConfidence: 'HIGH',
  maxCatalystAgeMs: 6 * 3_600_000,
  maxDurationMs: 4 * 3_600_000,
  cadenceMs: 5 * 60_000,
  requireRetestAfterMs: 15 * 60_000,
  maxExtensions: 1,
  extensionMs: 2 * 3_600_000,
  allowedActions: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'],
  expiryBehavior: 'ACTIVE',
};
