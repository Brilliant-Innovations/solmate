import { z } from 'zod';
import { Milliseconds, VersionId } from '../primitives.js';

/**
 * External offline-resume watchdog and sticky entry pause (blueprint §21.2B, §21.2C, D61). A
 * runtime may be intentionally OFF only while every remaining lot is OFFLINE_PROTECTED within
 * policy and a request-shaped watchdog outside the runtime is healthy enough to notice an overdue
 * resume. The watchdog never trades; it raises CRITICAL, persists PAUSE_NEW_ENTRIES so the next
 * start cannot silently resume entries, and records an audited event.
 */
export const WatchdogPolicy = z.strictObject({
  version: VersionId,
  /** A running session whose worker heartbeat is older than this is treated as a missing runtime. */
  heartbeatMissingAfterMs: Milliseconds,
  /** The watchdog counts as healthy for offline-protected carry only when its last run is younger than this. */
  watchdogFreshMs: Milliseconds,
});
export type WatchdogPolicy = z.infer<typeof WatchdogPolicy>;

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  version: 'watchdog-v1' as VersionId,
  heartbeatMissingAfterMs: 5 * 60_000,
  watchdogFreshMs: 15 * 60_000,
};
