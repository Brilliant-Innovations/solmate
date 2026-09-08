import { instantToMs, type Amount, type Instant, type ProtectionMode, type Uuid, type VersionId } from '@sol-agent-trader/contracts';

/**
 * D61 offline protection and the §21.2B wind-down plan. Pure: a lot is OFFLINE_PROTECTED only when
 * every D61 condition holds; anything else is unmanaged exposure and keeps the runtime from OFF.
 * With provider protection disabled (ADR-0004 MONITORED_EXIT-only) no lot qualifies, so END
 * SESSION converges to zero exposure exactly as before.
 */

export interface LotForWindDown {
  lotId: Uuid;
  positionId: Uuid;
  strategyVersionId: VersionId;
  quantity: Amount;
  protectionMode: ProtectionMode;
  providerProtectionActive: boolean;
  /** Latest held-asset safety state for the position. */
  safetyState: string;
}

export interface StrategyOfflineTerms {
  permitted: boolean;
  maxOfflineMs: number | null;
}

export interface WindDownInput {
  lots: readonly LotForWindDown[];
  strategyTerms: (strategyVersionId: VersionId) => StrategyOfflineTerms | null;
  inFlightExecutions: number;
  inFlightCustodyOps: number;
  /** Emergency-route snapshot freshness for held assets; null when the adapter does not exist yet (M8b). */
  emergencyRouteFresh: boolean | null;
  watchdog: { healthy: boolean; lastRunAt: Instant | null };
  /** The operator's planned resume for this session end; null when none was declared. */
  plannedResumeAt: Instant | null;
  now: Instant;
}

export type LotVerdict = { lotId: Uuid; protected: true; resumeBy: Instant } | { lotId: Uuid; protected: false; reasons: string[] };

export function evaluateOfflineProtection(lot: LotForWindDown, input: WindDownInput): LotVerdict {
  const reasons: string[] = [];
  const terms = input.strategyTerms(lot.strategyVersionId);
  if (!terms) reasons.push('strategy terms unknown');
  else if (!terms.permitted) reasons.push('strategy forbids offline protection');
  if (lot.protectionMode === 'MONITORED_EXIT' || !lot.providerProtectionActive) reasons.push('no active provider-side protection');
  if (input.inFlightExecutions + input.inFlightCustodyOps > 0) reasons.push('execution or custody transition in flight');
  if (lot.safetyState !== 'NORMAL') reasons.push(`safety ${lot.safetyState}`);
  if (input.emergencyRouteFresh !== true) reasons.push('emergency route state not fresh');
  if (!input.plannedResumeAt) reasons.push('no planned resume');
  else if (terms && terms.maxOfflineMs === null) reasons.push('strategy declares no maximum offline duration');
  else if (terms && terms.maxOfflineMs !== null && instantToMs(input.plannedResumeAt) - instantToMs(input.now) > terms.maxOfflineMs) reasons.push('planned resume beyond the maximum offline duration');
  if (!input.watchdog.healthy) reasons.push('resume watchdog not healthy');
  if (reasons.length) return { lotId: lot.lotId, protected: false, reasons };
  return { lotId: lot.lotId, protected: true, resumeBy: input.plannedResumeAt as Instant };
}

export interface WindDownPlan {
  verdicts: LotVerdict[];
  unmanagedLots: number;
  offlineProtectedLots: number;
  blockers: string[];
  resumeBy: Instant | null;
  canGoOff: boolean;
}

export function windDownPlan(input: WindDownInput): WindDownPlan {
  const verdicts = input.lots.map((l) => evaluateOfflineProtection(l, input));
  const unmanaged = verdicts.filter((v): v is Extract<LotVerdict, { protected: false }> => !v.protected);
  const protectedLots = verdicts.filter((v): v is Extract<LotVerdict, { protected: true }> => v.protected);
  const blockers: string[] = [];
  const inFlight = input.inFlightExecutions + input.inFlightCustodyOps;
  if (inFlight > 0) blockers.push(`${inFlight} execution/custody transition(s) in flight`);
  if (unmanaged.length) {
    const reasons = [...new Set(unmanaged.flatMap((u) => u.reasons))].slice(0, 4).join('; ');
    blockers.push(`${unmanaged.length} unmanaged lot(s): ${reasons}`);
  }
  if (protectedLots.length && !input.watchdog.healthy) blockers.push('resume watchdog not healthy: offline-protected carry refused (§21.2C)');
  const resumeBy = protectedLots.length ? protectedLots.map((p) => p.resumeBy).sort()[0] ?? null : null;
  return { verdicts, unmanagedLots: unmanaged.length, offlineProtectedLots: protectedLots.length, blockers, resumeBy, canGoOff: blockers.length === 0 };
}
