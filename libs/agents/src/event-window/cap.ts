import { addMs, compareInstants, instantToMs, type EventWindowCapPolicy, type EventWindowRequest, type Instant, type SourceTimeConfidence, type TradingActionType, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Deterministic EVENT_WINDOW cap (blueprint §12.3A, D60, D64; execution plan M6 "EVENT_WINDOW
 * proposal → deterministic cap"). Input: the skill's request, the catalyst's trustworthy timing as
 * the intelligence layer recorded it, the policy, and the clock. Output: either a refusal with the
 * reason or a fully determined window. Nothing the model wrote changes the ceiling: the duration is
 * min(requested, policy max) measured from T0, the cadence, retest rule and allowed actions are the
 * policy's, and a stale or untrusted catalyst opens nothing.
 */

const CONFIDENCE_RANK: Record<SourceTimeConfidence, number> = { ABSENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export interface CatalystTiming {
  evidenceId: Uuid;
  /** Trustworthy source time (T0) as recorded, null when absent. */
  sourceTime: Instant | null;
  sourceTimeConfidence: SourceTimeConfidence;
  /** Dedupe relation as recorded: a DUPLICATE or CORROBORATION is not new information. */
  relation: 'NEW' | 'DUPLICATE' | 'CORROBORATION';
}

export interface EventWindow {
  catalystEvidenceId: Uuid;
  policyVersion: string;
  t0: Instant;
  opensAt: Instant;
  endsAt: Instant;
  cadenceMs: number;
  retestRequiredAfter: Instant | null;
  allowedActions: TradingActionType[];
  extensionsRemaining: number;
  expiryBehavior: 'WATCH' | 'ACTIVE';
  /** True when the policy ceiling, not the request, fixed the end. */
  cappedByPolicy: boolean;
}

export type EventWindowDecision = { allowed: true; window: EventWindow } | { allowed: false; reason: 'SOURCE_TIME_UNTRUSTED' | 'CATALYST_TOO_OLD' | 'NOT_NEW_INFORMATION' | 'EVIDENCE_MISMATCH' | 'ALREADY_EXPIRED' };

export function capEventWindow(request: EventWindowRequest, catalyst: CatalystTiming, policy: EventWindowCapPolicy, now: Instant): EventWindowDecision {
  if (catalyst.evidenceId !== request.catalystEvidenceId) return { allowed: false, reason: 'EVIDENCE_MISMATCH' };
  if (catalyst.sourceTime === null || CONFIDENCE_RANK[catalyst.sourceTimeConfidence] < CONFIDENCE_RANK[policy.minSourceTimeConfidence]) return { allowed: false, reason: 'SOURCE_TIME_UNTRUSTED' };
  if (catalyst.relation !== 'NEW') return { allowed: false, reason: 'NOT_NEW_INFORMATION' };
  const ageMs = instantToMs(now) - instantToMs(catalyst.sourceTime);
  if (ageMs > policy.maxCatalystAgeMs) return { allowed: false, reason: 'CATALYST_TOO_OLD' };
  const requestedMs = Math.min(request.requestedDurationMinutes, request.expectedHalfLifeMinutes * 2) * 60_000;
  const durationMs = Math.min(requestedMs, policy.maxDurationMs);
  const endsAt = addMs(catalyst.sourceTime, durationMs);
  if (compareInstants(endsAt, now) <= 0) return { allowed: false, reason: 'ALREADY_EXPIRED' };
  return {
    allowed: true,
    window: {
      catalystEvidenceId: catalyst.evidenceId,
      policyVersion: policy.version,
      t0: catalyst.sourceTime,
      opensAt: now,
      endsAt,
      cadenceMs: policy.cadenceMs,
      retestRequiredAfter: policy.requireRetestAfterMs === null ? null : addMs(catalyst.sourceTime, policy.requireRetestAfterMs),
      allowedActions: [...policy.allowedActions],
      extensionsRemaining: policy.maxExtensions,
      expiryBehavior: policy.expiryBehavior,
      cappedByPolicy: requestedMs > policy.maxDurationMs,
    },
  };
}

/** An extension needs genuinely new information: a NEW catalyst first seen after the window opened, inside the age limit; stale age is never extended. */
export function extendEventWindow(window: EventWindow, newer: CatalystTiming & { firstSeenAt: Instant }, policy: EventWindowCapPolicy, now: Instant): { allowed: true; window: EventWindow } | { allowed: false; reason: 'NO_EXTENSIONS_LEFT' | 'NOT_NEW_INFORMATION' | 'SOURCE_TIME_UNTRUSTED' | 'CATALYST_TOO_OLD' | 'WINDOW_CLOSED' } {
  if (compareInstants(window.endsAt, now) <= 0) return { allowed: false, reason: 'WINDOW_CLOSED' };
  if (window.extensionsRemaining <= 0) return { allowed: false, reason: 'NO_EXTENSIONS_LEFT' };
  if (newer.relation !== 'NEW' || compareInstants(newer.firstSeenAt, window.opensAt) <= 0) return { allowed: false, reason: 'NOT_NEW_INFORMATION' };
  if (newer.sourceTime === null || CONFIDENCE_RANK[newer.sourceTimeConfidence] < CONFIDENCE_RANK[policy.minSourceTimeConfidence]) return { allowed: false, reason: 'SOURCE_TIME_UNTRUSTED' };
  if (instantToMs(now) - instantToMs(newer.sourceTime) > policy.maxCatalystAgeMs) return { allowed: false, reason: 'CATALYST_TOO_OLD' };
  const cap = addMs(window.t0, policy.maxDurationMs + policy.maxExtensions * policy.extensionMs);
  const proposed = addMs(window.endsAt, policy.extensionMs);
  return { allowed: true, window: { ...window, endsAt: compareInstants(proposed, cap) > 0 ? cap : proposed, extensionsRemaining: window.extensionsRemaining - 1 } };
}
