import { z } from 'zod';
import { CandidateStatus, DataProvenance, MarketRegime, MarketSession, TriggerFamily } from '../enums.js';
import { Instant, Uuid, VersionId } from '../primitives.js';
import { JsonRecord, ReasonCode } from './common.js';

// §6.8 signals.feature_snapshots ----------------------------------------------------------------

/** Immutable feature vector at a decision time: the bridge between live trading and replay. */
export const FeatureSnapshot = z.object({
  id: Uuid,
  assetId: Uuid,
  asOf: Instant,
  /** Newest closed input bucket behind these features. `asOf` is computation time; this is data age (WP1b). */
  newestInputAt: Instant.nullable(),
  featureEngineVersion: VersionId,
  provenance: DataProvenance,
  marketSnapshotId: Uuid.nullable(),
  features: z.record(z.string(), z.number().nullable()),
  regime: MarketRegime.nullable(),
  marketSessions: z.array(MarketSession),
  /** D26 / §8.6: true while our own fill suppresses or re-baselines this asset's confirmation. */
  selfInfluenceSuppressed: z.boolean(),
});
export type FeatureSnapshot = z.infer<typeof FeatureSnapshot>;

// §6.9 signals.candidates -----------------------------------------------------------------------

export const Candidate = z.object({
  id: Uuid,
  assetId: Uuid,
  discoveredAt: Instant,
  triggerFamily: TriggerFamily,
  triggerDetails: JsonRecord,
  scannerScore: z.number().min(0).max(100),
  status: CandidateStatus,
  featureSnapshotId: Uuid,
  eligibilityEvaluationId: Uuid,
  expiresAt: Instant,
  deterministicRejectionReason: ReasonCode.nullable(),
  /** §9.7 dedupe: related triggers inside a window aggregate under one key. */
  dedupeKey: z.string().min(1).max(128),
  strategyVersionIds: z.array(VersionId),
});
export type Candidate = z.infer<typeof Candidate>;
