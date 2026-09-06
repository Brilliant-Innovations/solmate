import { CapitalAuthority, ControlRequestKind } from '../enums.js';
import type { Sha256Hex } from '../primitives.js';
import { canonicalHash } from '../signing/canonical.js';

/**
 * D41 step-up policy, as data: which control requests widen live financial authority and so
 * require a verified passkey assertion, and which are deliberately fast (pause, close, reduce,
 * reject, acknowledge, end). Deterministic and shared by web (to prompt), worker (to enforce) and
 * tests. Changing a classification is a reviewed change against §31.
 */
export type StepUpRequirement =
  /** always requires a verified WebAuthn assertion bound to this exact request */
  | 'REQUIRED'
  /** never requires step-up beyond an authenticated aal2 operator session (risk-reducing/neutral) */
  | 'FAST'
  /** requires step-up when the target capital authority is live; fast when it is OBSERVE/PAPER */
  | 'LIVE_TARGET'
  /** requires an aal2 (TOTP) session but no passkey, because it is how the first passkey is added */
  | 'AAL2_ONLY';

export const STEP_UP_POLICY: Readonly<Record<ControlRequestKind, StepUpRequirement>> = {
  SET_REQUESTED_MODE: 'LIVE_TARGET',
  PAUSE_NEW_ENTRIES: 'FAST',
  RESUME_NEW_ENTRIES: 'REQUIRED',
  APPROVE_AUTHORIZATION: 'REQUIRED',
  REJECT_AUTHORIZATION: 'FAST',
  MANUAL_REDUCE: 'FAST',
  MANUAL_CLOSE: 'FAST',
  EMERGENCY_CLOSE_ALL: 'FAST',
  ACKNOWLEDGE_ALERT: 'FAST',
  PROMOTE_RELEASE: 'REQUIRED',
  ARM_RELEASE: 'REQUIRED',
  RUN_READINESS_DRILL: 'FAST',
  START_SESSION: 'LIVE_TARGET',
  END_SESSION: 'FAST',
  REGISTER_PASSKEY: 'AAL2_ONLY',
  REVOKE_PASSKEY: 'REQUIRED',
};

const LIVE_AUTHORITIES: ReadonlySet<CapitalAuthority> = new Set(['LIVE_APPROVAL', 'LIVE_AUTO']);

/**
 * Whether a verified passkey assertion is required for this request. For LIVE_TARGET kinds the
 * payload must carry `authority`; an absent or unparseable authority fails closed (required).
 */
export function stepUpRequired(kind: ControlRequestKind, payload: Record<string, unknown>): boolean {
  switch (STEP_UP_POLICY[kind]) {
    case 'REQUIRED':
      return true;
    case 'FAST':
    case 'AAL2_ONLY':
      return false;
    case 'LIVE_TARGET': {
      const parsed = CapitalAuthority.safeParse(payload['authority']);
      return parsed.success ? LIVE_AUTHORITIES.has(parsed.data) : true;
    }
  }
}

/** The hash a step-up challenge binds to: the exact kind and canonical payload it may authorise. */
export function stepUpBindingHash(kind: ControlRequestKind, payload: Record<string, unknown>): Promise<Sha256Hex> {
  return canonicalHash({ kind, payload });
}

/** Risk-reducing controls that must stay fast (D41, §15.6). Used by tests to pin the policy. */
export const FAST_CONTROLS: readonly ControlRequestKind[] = ControlRequestKind.options.filter((k) => STEP_UP_POLICY[k] === 'FAST');
