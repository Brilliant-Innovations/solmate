import { z } from 'zod';
import { EventKind, SourceQualityClass, SourceTimeConfidence, WalletClassification } from '../enums.js';
import { Fraction, Instant, Sha256Hex, SolanaAddress, UsdValue, Uuid } from '../primitives.js';

// §6.6 intelligence.events ----------------------------------------------------------------------

/**
 * Two clocks, deliberately (D8, D64, §10.3): `sourcePublishedAt` drives catalyst age and event
 * windows; `firstSeenAt` drives replay availability and novelty. Neither may be rewritten later;
 * a genuinely new source event is a new row.
 */
export const IntelligenceEvent = z.object({
  id: Uuid,
  kind: EventKind,
  sourceProvider: z.string(),
  sourceId: z.string(),
  sourceUrlHash: Sha256Hex.nullable(),
  sourcePublishedAt: Instant.nullable(),
  sourceTimeConfidence: SourceTimeConfidence,
  firstSeenAt: Instant,
  lastSeenAt: Instant,
  assetIds: z.array(Uuid),
  title: z.string().max(512).nullable(),
  summary: z.string().max(4096).nullable(),
  sourceQuality: SourceQualityClass,
  noveltyScore: Fraction.nullable(),
  sentiment: z
    .object({
      score: z.number().min(-1).max(1),
      confidence: Fraction,
    })
    .nullable(),
  classification: z.string().max(64).nullable(),
  /** Dedupe cluster: ten syndicated copies of one press release share one cluster (§10.2). */
  clusterId: Uuid.nullable(),
  corroboratesEventId: Uuid.nullable(),
  payloadHash: Sha256Hex,
  rawPayloadRef: z.string().nullable(),
});
export type IntelligenceEvent = z.infer<typeof IntelligenceEvent>;

// §6.7 intelligence.wallets ---------------------------------------------------------------------

export const WalletLabel = z.object({
  label: WalletClassification,
  confidence: Fraction,
  source: z.string(),
  firstSeenAt: Instant,
});

export const TrackedWallet = z.object({
  address: SolanaAddress,
  discoverySource: z.string(),
  labels: z.array(WalletLabel),
  /** D26: application-controlled addresses are OWNED and excluded from every flow feature. */
  isOwned: z.boolean(),
  pnlUsd: z.object({
    d7: UsdValue.nullable(),
    d30: UsdValue.nullable(),
    d90: UsdValue.nullable(),
  }),
  winRate: Fraction.nullable(),
  tradeCount: z.number().int().nonnegative().nullable(),
  firstSeenAt: Instant,
  updatedAt: Instant,
});
export type TrackedWallet = z.infer<typeof TrackedWallet>;
