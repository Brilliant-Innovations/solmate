import { z } from 'zod';
import { CapitalAuthority, ControlRequestKind } from '../enums.js';
import type { Sha256Hex } from '../primitives.js';
import { canonicalHash } from '../signing/canonical.js';

/**
 * D41 step-up policy, as data: which control requests widen live financial authority and so
 * require a verified passkey assertion, and which are deliberately fast (pause, close, reduce,
 * reject, acknowledge, end). Deterministic and shared by web (to prompt), worker (to enforce) and
 * tests. Changing a classification is a reviewed change against §31. The table is also pinned
 * into the contract-set digest through `StepUpPolicy` below (review R2-10).
 */
export type StepUpRequirement =
  /** always requires a verified WebAuthn assertion bound to this exact request */
  | 'REQUIRED'
  /** never requires step-up beyond an authenticated aal2 operator session (risk-reducing/neutral) */
  | 'FAST'
  /** requires step-up when the target capital authority is live; fast when it is OBSERVE/PAPER */
  | 'LIVE_TARGET'
  /**
   * The operator's first passkey may be added with a fresh TOTP (aal2) session alone; every later
   * registration requires an assertion from an existing passkey (review R2-01). The first passkey
   * enters a cooling period before it can authorise REQUIRED kinds.
   */
  | 'FIRST_PASSKEY_AAL2';

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
  REGISTER_PASSKEY: 'FIRST_PASSKEY_AAL2',
  REVOKE_PASSKEY: 'REQUIRED',
  // §20.4 / §20.27: attention only; never eligibility or execution permission.
  WATCH_ASSET: 'FAST',
  UNWATCH_ASSET: 'FAST',
  REQUEST_RESEARCH_REFRESH: 'FAST',
  // §20.29: retiring a Release is a live-configuration change (admin, step-up), never a casual toggle.
  RETIRE_RELEASE: 'REQUIRED',
  // §20.18: the operator's external wallet prompt is the signing authority; recording it widens nothing.
  FUND_TRADING_WALLET: 'FAST',
  // §18 / M10: a replay reads captured data and writes research rows; it touches no capital.
  RUN_REPLAY: 'FAST',
};

/** Zod mirror of the table so the digest changes when a classification changes (D50). */
export const StepUpPolicy = z.strictObject(
  Object.fromEntries(ControlRequestKind.options.map((k) => [k, z.literal(STEP_UP_POLICY[k])])) as Record<ControlRequestKind, z.ZodLiteral<StepUpRequirement>>,
);

/** Step-up challenge lifetime (mirrors ops.begin_step_up). */
export const STEP_UP_CHALLENGE_TTL_MS = 5 * 60_000;
/** A first passkey registered with TOTP alone cannot authorise REQUIRED kinds before this elapses. */
export const FIRST_PASSKEY_COOLING_MS = 60 * 60_000;
/** The TOTP verification in the session's `amr` claim must be at most this old to add a first passkey. */
export const RECENT_TOTP_WINDOW_MS = 5 * 60_000;

/** Facts about the requesting operator that the policy needs beyond the request itself. */
export interface StepUpContext {
  /** Passkeys of the operator that are neither revoked nor unknown (cooling ones count). */
  activePasskeys: number;
}

const LIVE_AUTHORITIES: ReadonlySet<CapitalAuthority> = new Set(['LIVE_APPROVAL', 'LIVE_AUTO']);

/**
 * Whether a verified passkey assertion is required for this request. For LIVE_TARGET kinds the
 * payload must carry `authority`; an absent or unparseable authority fails closed (required). For
 * FIRST_PASSKEY_AAL2 an unknown context fails closed (required).
 */
export function stepUpRequired(kind: ControlRequestKind, payload: Record<string, unknown>, ctx?: StepUpContext): boolean {
  switch (STEP_UP_POLICY[kind]) {
    case 'REQUIRED':
      return true;
    case 'FAST':
      return false;
    case 'LIVE_TARGET': {
      const parsed = CapitalAuthority.safeParse(payload['authority']);
      return parsed.success ? LIVE_AUTHORITIES.has(parsed.data) : true;
    }
    case 'FIRST_PASSKEY_AAL2':
      return ctx === undefined ? true : ctx.activePasskeys > 0;
  }
}

/**
 * Payload keys that carry the ceremony evidence itself and therefore cannot be part of what the
 * challenge binds to (the challenge is issued before the evidence exists; review R2-09).
 */
export const BOUND_PAYLOAD_EXCLUDED_KEYS: readonly string[] = ['stepUp', 'registration'];

export function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const k of BOUND_PAYLOAD_EXCLUDED_KEYS) delete out[k];
  return out;
}

/** The hash a step-up challenge binds to: the exact kind and canonical bound payload it may authorise. */
export function stepUpBindingHash(kind: ControlRequestKind, payload: Record<string, unknown>): Promise<Sha256Hex> {
  return canonicalHash({ kind, payload: boundPayload(payload) });
}

/** Risk-reducing controls that must stay fast (D41, §15.6). Used by tests to pin the policy. */
export const FAST_CONTROLS: readonly ControlRequestKind[] = ControlRequestKind.options.filter((k) => STEP_UP_POLICY[k] === 'FAST');
