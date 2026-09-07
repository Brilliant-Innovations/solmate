import { z } from 'zod';
import { Milliseconds, VersionId } from '../primitives.js';

/**
 * Runtime session policy (blueprint D60–D63, §21.2B, §21.3; execution plan M5a "minimal runtime
 * session"). Cold-start gates are named here so the session row records exactly which checks a
 * profile ran; the worker evaluates them from stored state, never from a provider call.
 */
export const COLD_START_GATES = ['RECONCILIATION_CLEAN', 'FEEDS_FRESH', 'UNIVERSE_REFRESHED', 'WARMUP_SUFFICIENT', 'HELD_ASSET_SAFETY_FRESH', 'AUTHORITY_CHECKS'] as const;
export type ColdStartGateName = (typeof COLD_START_GATES)[number];

export const SessionPolicy = z.strictObject({
  version: VersionId,
  /** Attended profiles: an operator heartbeat older than this means no operator is present. */
  presenceTimeoutMs: Milliseconds,
  /** Eligible/watch universe must have been refreshed within this window. */
  universeMaxAgeMs: Milliseconds,
  /** At least this many tracked assets must carry warm features before the session can leave STARTING (D63). */
  minWarmAssets: z.number().int().nonnegative(),
  /** A held asset's latest safety evaluation must be younger than this. */
  safetyMaxAgeMs: Milliseconds,
  /** Presence, cold-start and control-request cadence. */
  tickMs: Milliseconds,
});
export type SessionPolicy = z.infer<typeof SessionPolicy>;

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  version: 'session-v1' as VersionId,
  presenceTimeoutMs: 3 * 60_000,
  universeMaxAgeMs: 24 * 3_600_000,
  minWarmAssets: 1,
  safetyMaxAgeMs: 10 * 60_000,
  tickMs: 15_000,
};
