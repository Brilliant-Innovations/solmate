import type { ActivityState, CapitalAuthority, ExposureEffect } from '@sol-agent-trader/contracts';

/**
 * Executor-side mode gate (blueprint D60, §15.9, ADR-0009 P3; INV-05). Read immediately before
 * submit from the executor's own view of the runtime session and its local pause, never from
 * the authorization envelope: an authorization issued before a pause cannot submit after it.
 * Risk reduction (REDUCE) is never gated by pause, activity or authority (D31, D39).
 */
export interface ModeFacts {
  activity: ActivityState;
  authority: CapitalAuthority;
  paused: boolean;
  /** The executor's own local pause (out-of-band command or DB-down fallback), independent of the database. */
  localPause: boolean;
  liveCapabilityEnabled: boolean;
}

export type ModeGateVerdict = { allowed: true } | { allowed: false; reason: 'PAUSED' | 'LOCAL_PAUSE' | 'ACTIVITY_FORBIDS_ENTRIES' | 'AUTHORITY_FORBIDS_LIVE' | 'LIVE_CAPABILITY_DISABLED' };

const LIVE = new Set<CapitalAuthority>(['LIVE_APPROVAL', 'LIVE_AUTO']);

export function modeGate(facts: ModeFacts, exposureEffect: ExposureEffect): ModeGateVerdict {
  if (exposureEffect === 'REDUCE') return { allowed: true };
  if (facts.localPause) return { allowed: false, reason: 'LOCAL_PAUSE' };
  if (facts.paused) return { allowed: false, reason: 'PAUSED' };
  if (facts.activity !== 'ACTIVE' && facts.activity !== 'EVENT_WINDOW') return { allowed: false, reason: 'ACTIVITY_FORBIDS_ENTRIES' };
  if (!LIVE.has(facts.authority)) return { allowed: false, reason: 'AUTHORITY_FORBIDS_LIVE' };
  if (!facts.liveCapabilityEnabled) return { allowed: false, reason: 'LIVE_CAPABILITY_DISABLED' };
  return { allowed: true };
}
