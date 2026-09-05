import type { AdversaryVerdict, PositionReviewState, PositionSafetyState } from '@sol-agent-trader/contracts';

/**
 * Mandatory risk-reduction classifier (blueprint D31, §11.10, §14.4; INV-15, INV-21).
 *
 * Deterministic triggers decide. The adversary's verdict or availability, model/data budget state
 * and the position's review state are accepted as inputs only so the type system proves they are
 * ignored: the result is a pure function of `triggers`.
 */

export interface MandatoryExitTriggers {
  hardStopReached: boolean;
  providerProtectiveFill: boolean;
  circuitBreakerRequiresReduction: boolean;
  safetyState: PositionSafetyState;
  operatorEmergencyClose: boolean;
  dbIndependentEmergencyClose: boolean;
}

/** Deliberately unused by the decision; present so callers cannot "forget" that it is irrelevant. */
export interface DiscretionaryContext {
  adversaryVerdict: AdversaryVerdict | null;
  adversaryAvailable: boolean;
  budgetExhausted: boolean;
  reviewState: PositionReviewState;
}

export type MandatoryExitReason =
  | 'HARD_STOP'
  | 'PROVIDER_PROTECTIVE_FILL'
  | 'CIRCUIT_BREAKER'
  | 'CRITICAL_EXIT_SAFETY'
  | 'OPERATOR_EMERGENCY_CLOSE'
  | 'DB_INDEPENDENT_EMERGENCY_CLOSE';

export interface MandatoryExitDecision {
  mandatory: boolean;
  reasons: MandatoryExitReason[];
  /** Any adversarial analysis is recorded for research only and can never veto (D31). */
  adversaryBlocking: false;
}

export function classifyMandatoryExit(triggers: MandatoryExitTriggers, context: DiscretionaryContext): MandatoryExitDecision {
  // Accepted and deliberately ignored: the adversary has no veto over mandatory risk reduction (D31).
  void context;
  const reasons: MandatoryExitReason[] = [];
  if (triggers.hardStopReached) reasons.push('HARD_STOP');
  if (triggers.providerProtectiveFill) reasons.push('PROVIDER_PROTECTIVE_FILL');
  if (triggers.circuitBreakerRequiresReduction) reasons.push('CIRCUIT_BREAKER');
  if (triggers.safetyState === 'CRITICAL_EXIT') reasons.push('CRITICAL_EXIT_SAFETY');
  if (triggers.operatorEmergencyClose) reasons.push('OPERATOR_EMERGENCY_CLOSE');
  if (triggers.dbIndependentEmergencyClose) reasons.push('DB_INDEPENDENT_EMERGENCY_CLOSE');
  return { mandatory: reasons.length > 0, reasons, adversaryBlocking: false };
}
