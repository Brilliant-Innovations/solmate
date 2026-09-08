import { canonicalHash, instantToMs, sha256Hex, type EventKind, type Instant, type IntelligenceEvent, type NormalizationPolicy, type Sha256Hex, type SourceQualityClass, type SourceTimeConfidence, type Uuid } from '@sol-agent-trader/contracts';
import { EntityIndex, type EntityMatch } from './entities.js';

/**
 * Event normalization (blueprint §10.1, §10.3, §10.4, §6.6, D64). One provider-agnostic input,
 * one deterministic output. Two clocks: `sourcePublishedAt` (what the source says, with a
 * confidence class) and `firstSeenAt` (when we first had it, supplied by the caller's clock).
 * Neither is ever derived from the other. Source quality comes only from the pinned domain
 * table. The payload hash makes the row tamper-evident and the (provider, sourceId) pair keeps a
 * repeated fetch from becoming a second piece of evidence.
 */

export interface RawSourceEvent {
  provider: string;
  sourceId: string;
  kind: EventKind;
  url: string | null;
  /** The provider's publication timestamp as given (ISO 8601 or null). */
  publishedAt: string | null;
  /** True when the provider gave only a date, or a time the adapter had to infer. */
  publishedAtImprecise?: boolean;
  title: string | null;
  summary: string | null;
  /** Mints the provider attached to the item, when any. */
  mints: string[];
  sentiment: { score: number; confidence: number } | null;
  classification: string | null;
  /** Everything the provider returned, for the hash and the retention pointer. */
  payload: unknown;
}

export interface NormalizedEvent {
  event: Omit<IntelligenceEvent, 'id' | 'clusterId' | 'corroboratesEventId' | 'noveltyScore'>;
  matches: EntityMatch[];
  domain: string | null;
}

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Longest matching suffix in the policy table; unknown domains are UNKNOWN_SOCIAL (§10.4: quality never comes from the text). */
export function sourceQualityFor(domain: string | null, policy: NormalizationPolicy): SourceQualityClass {
  if (!domain) return 'UNKNOWN_SOCIAL';
  let best: { len: number; cls: SourceQualityClass } | null = null;
  for (const [suffix, cls] of Object.entries(policy.sourceQualityByDomain)) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) {
      if (!best || suffix.length > best.len) best = { len: suffix.length, cls };
    }
  }
  return best?.cls ?? 'UNKNOWN_SOCIAL';
}

export function sourceTimeOf(raw: RawSourceEvent, policy: NormalizationPolicy): { at: Instant | null; confidence: SourceTimeConfidence } {
  if (!raw.publishedAt) return { at: null, confidence: 'ABSENT' };
  const ms = Date.parse(raw.publishedAt);
  if (!Number.isFinite(ms)) return { at: null, confidence: 'ABSENT' };
  const at = new Date(ms).toISOString() as Instant;
  if (raw.publishedAtImprecise) return { at, confidence: 'LOW' };
  return { at, confidence: policy.highConfidenceTimeProviders.includes(raw.provider) ? 'HIGH' : 'MEDIUM' };
}

export function normalizeTitle(title: string | null): string {
  return (title ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function normalizeEvent(raw: RawSourceEvent, input: { firstSeenAt: Instant; policy: NormalizationPolicy; entities: EntityIndex; rawPayloadRef?: string | null }): Promise<NormalizedEvent> {
  const domain = domainOf(raw.url);
  const time = sourceTimeOf(raw, input.policy);
  const text = `${raw.title ?? ''} ${raw.summary ?? ''}`;
  const matches = input.entities.match(text, raw.mints, input.policy);
  const payloadHash = await canonicalHash(raw.payload);
  const sourceUrlHash = raw.url ? ((await sha256Hex(raw.url.trim().toLowerCase())) as Sha256Hex) : null;
  // A source time in the future of first-seen is not trustworthy: keep it but mark it LOW (the caller's clock is the replay truth).
  const confidence: SourceTimeConfidence = time.at !== null && instantToMs(time.at) > instantToMs(input.firstSeenAt) + 60_000 ? 'LOW' : time.confidence;
  return {
    event: {
      kind: raw.kind,
      sourceProvider: raw.provider,
      sourceId: raw.sourceId,
      sourceUrlHash,
      sourcePublishedAt: time.at,
      sourceTimeConfidence: confidence,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.firstSeenAt,
      assetIds: matches.map((m) => m.assetId),
      title: raw.title ? raw.title.slice(0, 512) : null,
      summary: raw.summary ? raw.summary.slice(0, 4096) : null,
      sourceQuality: sourceQualityFor(domain, input.policy),
      sentiment: raw.sentiment ? { score: Math.max(-1, Math.min(1, raw.sentiment.score)), confidence: Math.max(0, Math.min(1, raw.sentiment.confidence)) } : null,
      classification: raw.classification ? raw.classification.slice(0, 64) : null,
      payloadHash,
      rawPayloadRef: input.rawPayloadRef ?? null,
    },
    matches,
    domain,
  };
}

export type { Uuid };
