import { instantToMs, type AssetEligibility, type EligibilityPolicy, type Instant } from '@sol-agent-trader/contracts';

/**
 * Entry gate over an eligibility record (blueprint §7.4 "immediately before entry", §31 "critical
 * stale data fails closed for entries"; invariant INV-03 "No entry for an ineligible asset").
 * Pure: the record and the clock are the only inputs. Anything other than a fresh, eligible,
 * non-hard-rejected record produced by the expected policy version refuses the entry.
 */

export type EntryGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'NO_ELIGIBILITY_RECORD' | 'NOT_ELIGIBLE' | 'HARD_REJECT' | 'GRADE_BELOW_MIN' | 'ELIGIBILITY_STALE' | 'POLICY_VERSION_MISMATCH' | 'EVALUATED_IN_FUTURE' };

export function entryAllowed(record: AssetEligibility | null, now: Instant, policy: EligibilityPolicy): EntryGateVerdict {
  if (!record) return { allowed: false, reason: 'NO_ELIGIBILITY_RECORD' };
  if (record.policyVersion !== policy.version) return { allowed: false, reason: 'POLICY_VERSION_MISMATCH' };
  if (record.hardReject) return { allowed: false, reason: 'HARD_REJECT' };
  if (!record.eligible) return { allowed: false, reason: 'NOT_ELIGIBLE' };
  if (record.grade !== null && record.grade < policy.minGrade) return { allowed: false, reason: 'GRADE_BELOW_MIN' };
  const age = instantToMs(now) - instantToMs(record.evaluatedAt);
  if (age < 0) return { allowed: false, reason: 'EVALUATED_IN_FUTURE' };
  if (age > policy.maxEligibilityAgeMs) return { allowed: false, reason: 'ELIGIBILITY_STALE' };
  return { allowed: true };
}
