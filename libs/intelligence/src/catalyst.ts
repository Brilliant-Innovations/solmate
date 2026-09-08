import { instantToMs, type Instant, type NormalizationPolicy, type SourceTimeConfidence } from '@sol-agent-trader/contracts';

/**
 * Catalyst age (blueprint §10.3, D64): measured from trustworthy source time, never from when a
 * sleeping runtime happened to ingest the story. Absent or low-confidence source time cannot
 * open a fresh high-speed window from a new first-seen; the caller must use a conservative
 * fallback or wait for corroborated real-time evidence.
 */

export interface CatalystTiming {
  sourcePublishedAt: Instant | null;
  sourceTimeConfidence: SourceTimeConfidence;
  firstSeenAt: Instant;
}

const TRUSTED: ReadonlySet<SourceTimeConfidence> = new Set(['HIGH', 'MEDIUM']);

/** Age by trustworthy source time, or null when the source time cannot be trusted. */
export function catalystAgeMs(t: CatalystTiming, now: Instant): number | null {
  if (t.sourcePublishedAt === null || !TRUSTED.has(t.sourceTimeConfidence)) return null;
  return Math.max(0, instantToMs(now) - instantToMs(t.sourcePublishedAt));
}

export type FreshWindowVerdict = { allowed: true; ageMs: number } | { allowed: false; reason: 'SOURCE_TIME_UNTRUSTED' | 'CATALYST_TOO_OLD' | 'RECYCLED'; ageMs: number | null };

/** Whether an event may open a fresh catalyst window (D64). A duplicate or corroboration of a known cluster is recycled content. */
export function freshWindowVerdict(t: CatalystTiming, relation: 'NEW' | 'DUPLICATE' | 'CORROBORATION', now: Instant, policy: Pick<NormalizationPolicy, 'maxFreshCatalystAgeMs'>): FreshWindowVerdict {
  const ageMs = catalystAgeMs(t, now);
  if (ageMs === null) return { allowed: false, reason: 'SOURCE_TIME_UNTRUSTED', ageMs: null };
  if (relation !== 'NEW') return { allowed: false, reason: 'RECYCLED', ageMs };
  if (ageMs > policy.maxFreshCatalystAgeMs) return { allowed: false, reason: 'CATALYST_TOO_OLD', ageMs };
  return { allowed: true, ageMs };
}
