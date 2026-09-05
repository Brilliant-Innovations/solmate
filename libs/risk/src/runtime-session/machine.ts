import type { ActivityState, ActorKind, CapitalAuthority, Instant } from '@sol-agent-trader/contracts';

/**
 * Runtime session machine (blueprint D2, D60, D61, D63, §21.2B, §21.3).
 *
 * Two orthogonal axes plus a sticky override:
 * - activity: OFF → STARTING → WATCH ↔ ACTIVE ↔ EVENT_WINDOW → WIND_DOWN → OFF
 * - capital authority: OBSERVE | PAPER | LIVE_APPROVAL | LIVE_AUTO (operator-set, attested for live)
 * - PAUSED: set by anyone, cleared only by an operator with step-up; schedules and automations
 *   may move WATCH ↔ ACTIVE but never clear PAUSED (D60).
 *
 * `END SESSION` goes to WIND_DOWN, never straight to OFF; OFF requires zero unmanaged exposure and
 * no in-flight execution or custody transition (D61).
 */

export interface RuntimeState {
  activity: ActivityState;
  authority: CapitalAuthority;
  paused: boolean;
  pausedBy: ActorKind | null;
  attended: boolean;
  liveCapabilityEnabled: boolean;
}

export type RuntimeEvent =
  | { type: 'START'; at: Instant; by: ActorKind }
  | { type: 'COLD_START_PASSED'; at: Instant }
  | { type: 'ACTIVATE'; at: Instant; by: ActorKind }
  | { type: 'TO_WATCH'; at: Instant; by: ActorKind }
  | { type: 'OPEN_EVENT_WINDOW'; at: Instant; by: ActorKind }
  | { type: 'CLOSE_EVENT_WINDOW'; at: Instant; fallback: 'ACTIVE' | 'WATCH' }
  | { type: 'END_SESSION'; at: Instant; by: ActorKind }
  | { type: 'WIND_DOWN_COMPLETE'; at: Instant; unmanagedLots: number; inFlightExecutions: number; inFlightCustodyOps: number }
  | { type: 'PAUSE'; at: Instant; by: ActorKind }
  | { type: 'RESUME'; at: Instant; by: ActorKind; stepUpVerified: boolean }
  | { type: 'SET_AUTHORITY'; at: Instant; by: ActorKind; authority: CapitalAuthority; releaseAttested: boolean; readinessPermits: boolean; stepUpVerified: boolean };

export type RuntimeRejection =
  | { code: 'INVALID_FROM_STATE'; activity: ActivityState; event: RuntimeEvent['type'] }
  | { code: 'PAUSED_ONLY_OPERATOR_CAN_CLEAR'; by: ActorKind }
  | { code: 'STEP_UP_REQUIRED' }
  | { code: 'OFF_WITH_UNMANAGED_EXPOSURE'; unmanagedLots: number; inFlight: number }
  | { code: 'LIVE_ARMING_PRECONDITION_FAILED'; missing: string[] }
  | { code: 'ONLY_OPERATOR_SETS_AUTHORITY'; by: ActorKind };

export type RuntimeResult = { ok: true; state: RuntimeState } | { ok: false; rejection: RuntimeRejection };

const LIVE: ReadonlySet<CapitalAuthority> = new Set(['LIVE_APPROVAL', 'LIVE_AUTO']);
const RUNNING: ReadonlySet<ActivityState> = new Set(['STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW']);

export function initialRuntimeState(init: Partial<RuntimeState> = {}): RuntimeState {
  return { activity: 'OFF', authority: 'OBSERVE', paused: false, pausedBy: null, attended: true, liveCapabilityEnabled: false, ...init };
}

const invalid = (s: RuntimeState, event: RuntimeEvent['type']): RuntimeResult => ({
  ok: false,
  rejection: { code: 'INVALID_FROM_STATE', activity: s.activity, event },
});

export function runtimeTransition(s: RuntimeState, event: RuntimeEvent): RuntimeResult {
  switch (event.type) {
    case 'PAUSE':
      // Pause is deliberately cheap: any actor, any state (D41, §20.21).
      return { ok: true, state: { ...s, paused: true, pausedBy: event.by } };

    case 'RESUME':
      if (event.by !== 'OPERATOR') return { ok: false, rejection: { code: 'PAUSED_ONLY_OPERATOR_CAN_CLEAR', by: event.by } };
      if (!event.stepUpVerified) return { ok: false, rejection: { code: 'STEP_UP_REQUIRED' } };
      return { ok: true, state: { ...s, paused: false, pausedBy: null } };

    case 'SET_AUTHORITY': {
      if (event.by !== 'OPERATOR') return { ok: false, rejection: { code: 'ONLY_OPERATOR_SETS_AUTHORITY', by: event.by } };
      if (LIVE.has(event.authority)) {
        const missing: string[] = [];
        if (!s.liveCapabilityEnabled) missing.push('deployment live capability');
        if (!event.releaseAttested) missing.push('attested Release');
        if (!event.readinessPermits) missing.push('Live Readiness verdict');
        if (!event.stepUpVerified) missing.push('operator step-up');
        if (missing.length) return { ok: false, rejection: { code: 'LIVE_ARMING_PRECONDITION_FAILED', missing } };
      }
      return { ok: true, state: { ...s, authority: event.authority } };
    }

    case 'START':
      return s.activity === 'OFF' ? { ok: true, state: { ...s, activity: 'STARTING' } } : invalid(s, event.type);

    case 'COLD_START_PASSED':
      return s.activity === 'STARTING' ? { ok: true, state: { ...s, activity: 'WATCH' } } : invalid(s, event.type);

    case 'ACTIVATE':
      return s.activity === 'WATCH' ? { ok: true, state: { ...s, activity: 'ACTIVE' } } : invalid(s, event.type);

    case 'TO_WATCH':
      return s.activity === 'ACTIVE' || s.activity === 'EVENT_WINDOW' ? { ok: true, state: { ...s, activity: 'WATCH' } } : invalid(s, event.type);

    case 'OPEN_EVENT_WINDOW':
      return s.activity === 'ACTIVE' ? { ok: true, state: { ...s, activity: 'EVENT_WINDOW' } } : invalid(s, event.type);

    case 'CLOSE_EVENT_WINDOW':
      return s.activity === 'EVENT_WINDOW' ? { ok: true, state: { ...s, activity: event.fallback } } : invalid(s, event.type);

    case 'END_SESSION':
      return RUNNING.has(s.activity) ? { ok: true, state: { ...s, activity: 'WIND_DOWN' } } : invalid(s, event.type);

    case 'WIND_DOWN_COMPLETE': {
      if (s.activity !== 'WIND_DOWN') return invalid(s, event.type);
      const inFlight = event.inFlightExecutions + event.inFlightCustodyOps;
      if (event.unmanagedLots > 0 || inFlight > 0) {
        return { ok: false, rejection: { code: 'OFF_WITH_UNMANAGED_EXPOSURE', unmanagedLots: event.unmanagedLots, inFlight } };
      }
      return { ok: true, state: { ...s, activity: 'OFF' } };
    }
  }
}

/** New entries: not paused, activity permits, authority is not OBSERVE (D60). */
export function newEntriesAllowed(s: RuntimeState): boolean {
  return !s.paused && (s.activity === 'ACTIVE' || s.activity === 'EVENT_WINDOW') && s.authority !== 'OBSERVE';
}

/** Live execution additionally requires a live authority and deployment live capability (INV-05, §15.9). */
export function liveExecutionAllowed(s: RuntimeState): boolean {
  return newEntriesAllowed(s) && LIVE.has(s.authority) && s.liveCapabilityEnabled;
}

/** Exits and protection are never gated by activity, pause or authority (D31, D39). */
export function riskReductionAllowed(): boolean {
  return true;
}
