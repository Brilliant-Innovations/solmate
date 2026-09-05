import { z } from 'zod';
import { CapitalAuthority, DeploymentProfile, MarketSession, ReleaseStatus, SpeedTier, StrategyStatus, TradingActionType } from '../enums.js';
import { Bps, GitSha, Instant, Milliseconds, Sha256Hex, Uuid, VersionId } from '../primitives.js';
import { JsonRecord } from './common.js';

// §6.21 research.strategy_versions + §12.3 execution contract ----------------------------------

/** First-class strategy labels (§12.1). S0_RAW and S0_SAFE are never collapsed into one. */
export const StrategyId = z.enum(['S0_RAW', 'S0_SAFE', 'S1', 'S2', 'S3', 'S4']);
export type StrategyId = z.infer<typeof StrategyId>;

export const OutsideWindowBehavior = z.enum(['WATCH', 'NO_NEW_ENTRIES', 'RESEARCH_PAPER']);

export const StrategyVersion = z.object({
  id: Uuid,
  strategyId: StrategyId,
  versionId: VersionId,
  /** ADR-0004: distinguishes the tiny-live S0_SAFE variant from the research variant. */
  variant: z.string().min(1).max(32),
  gitSha: GitSha,
  featureVersion: VersionId,
  promptVersions: z.record(z.string(), VersionId),
  modelSelections: z.record(z.string(), z.string()),
  thresholds: JsonRecord,
  riskPolicyVersion: VersionId,
  skillVersionId: VersionId.nullable(),
  guidelineVersionId: VersionId.nullable(),
  automationSetVersionId: VersionId.nullable(),
  speedTier: SpeedTier,
  maxDecisionLatencyMs: Milliseconds,
  maxCandidateAgeMs: Milliseconds,
  maxQuoteAgeMs: Milliseconds,
  chaseToleranceBps: Bps,
  allowedActionTypes: z.array(TradingActionType),
  reassessmentPolicy: JsonRecord,
  adversaryPolicy: z.object({
    proposerModel: z.string().nullable(),
    adversaryModel: z.string().nullable(),
    deterministicGate: z.boolean(),
  }),
  sessionRules: z.object({
    allowedSessions: z.array(MarketSession),
    blockedWeekdays: z.array(z.number().int().min(0).max(6)),
    customWindowsUtc: z.array(z.object({ start: z.string(), end: z.string() })),
  }),
  regimeConditions: JsonRecord,
  outsideWindowBehavior: OutsideWindowBehavior,
  warmup: z.object({
    minBarsByResolution: z.record(z.string(), z.number().int().nonnegative()),
    baselineWindowMs: Milliseconds,
  }),
  eventWindowPolicy: z.object({
    maxDurationMs: Milliseconds,
    maxExtensions: z.number().int().nonnegative(),
    requireRetestAfterMs: Milliseconds.nullable(),
  }),
  offlineProtection: z.object({
    permitted: z.boolean(),
    maxOfflineMs: Milliseconds.nullable(),
  }),
  attendedPresenceRequiredProfiles: z.array(DeploymentProfile),
  humanReactionFloorMs: Milliseconds,
  liveIntentExpiryMs: Milliseconds,
  eligibleCapitalAuthorities: z.array(CapitalAuthority),
  status: StrategyStatus,
  activeFrom: Instant,
  activeTo: Instant.nullable(),
});
export type StrategyVersion = z.infer<typeof StrategyVersion>;

// §6.16A research.releases / release_attestations (D38) ----------------------------------------

export const ReleaseBinding = z.object({
  strategyVersionId: VersionId,
  skillVersionId: VersionId.nullable(),
  guidelineVersionId: VersionId.nullable(),
  automationSetVersionId: VersionId.nullable(),
  proposerModelPolicyVersion: VersionId.nullable(),
  adversaryModelPolicyVersion: VersionId,
  riskPolicyVersion: VersionId,
  cohortPolicyVersion: VersionId,
  freshnessPolicyVersion: VersionId,
  executorPolicyRef: VersionId,
  contractSetDigest: Sha256Hex,
});
export type ReleaseBinding = z.infer<typeof ReleaseBinding>;

export const Release = z.object({
  id: Uuid,
  /** Canonical hash of `binding`; attestations and authorizations bind to this digest. */
  digest: Sha256Hex,
  binding: ReleaseBinding,
  status: ReleaseStatus,
  createdAt: Instant,
  promotedAt: Instant.nullable(),
  retiredAt: Instant.nullable(),
});
export type Release = z.infer<typeof Release>;

export const ReleaseAttestation = z.object({
  id: Uuid,
  releaseId: Uuid,
  releaseDigest: Sha256Hex,
  purpose: z.enum(['PROMOTE', 'ARM', 'RESUME']),
  operatorId: Uuid,
  operatorRole: z.enum(['admin']),
  credentialId: z.string().min(1).max(256),
  credentialFingerprint: Sha256Hex,
  challenge: z.string().min(16).max(512),
  verificationResult: z.boolean(),
  attestedAt: Instant,
  expiresAt: Instant.nullable(),
});
export type ReleaseAttestation = z.infer<typeof ReleaseAttestation>;
