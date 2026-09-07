import { z } from 'zod';
import { AssetStatus } from '../enums.js';
import { Amount, Bps, Fraction, Instant, MintAddress, Slot, SolanaAddress, UsdValue, Uuid, VersionId } from '../primitives.js';
import { JsonRecord, ReasonCodes, Timestamps } from './common.js';

// §6.1 core.assets ------------------------------------------------------------------------------

export const TokenProgram = z.enum(['TOKEN', 'TOKEN_2022', 'UNKNOWN']);
export type TokenProgram = z.infer<typeof TokenProgram>;

export const Asset = Timestamps.extend({
  id: Uuid,
  chain: z.literal('solana'),
  mintAddress: MintAddress,
  symbol: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  decimals: z.number().int().min(0).max(18),
  tokenProgram: TokenProgram,
  tokenProgramId: SolanaAddress.nullable(),
  firstObservedAt: Instant,
  estimatedCreatedAt: Instant.nullable(),
  status: AssetStatus,
});
export type Asset = z.infer<typeof Asset>;

// §6.2 core.asset_eligibility ------------------------------------------------------------------

export const AuthorityState = z.enum(['NONE', 'PRESENT', 'UNKNOWN']);
export type AuthorityState = z.infer<typeof AuthorityState>;

/** D45: which source produced a security fact and whether chain and analytics agree. */
export const SecurityFieldSource = z.enum(['CHAIN', 'ANALYTICS']);

export const ConcentrationMetrics = z.object({
  source: SecurityFieldSource,
  chainSlot: Slot.nullable(),
  top1: Fraction,
  top5: Fraction,
  top10: Fraction,
  top20: Fraction,
  /** True when chain-derived and analytics-derived figures disagree materially; blocks new entry. */
  analyticsMismatch: z.boolean(),
});

export const Token2022Profile = z.object({
  extensions: z.array(z.string()),
  transferFeeBps: Bps.nullable(),
  transferHook: z.boolean(),
  permanentDelegate: z.boolean(),
  /** Whether the selected execution and protection paths support this token's extensions (§6.2, §16.6). */
  swapCompatibility: z.enum(['COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN']),
  triggerCompatibility: z.enum(['COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN']),
});

export const PriceImpactProbe = z.object({
  sizeUsd: UsdValue,
  inputAmount: Amount,
  impactBps: Bps.nullable(),
  routeFound: z.boolean(),
  probedAt: Instant,
});

export type PriceImpactProbe = z.infer<typeof PriceImpactProbe>;

export const DirectPoolProgram = z.enum(['RAYDIUM_AMM_V4', 'RAYDIUM_CPMM', 'RAYDIUM_CLMM', 'ORCA_WHIRLPOOL', 'METEORA_DLMM']);
export type DirectPoolProgram = z.infer<typeof DirectPoolProgram>;

export const DirectPoolHop = z.object({
  program: DirectPoolProgram,
  programId: SolanaAddress,
  poolAddress: SolanaAddress,
  inputMint: MintAddress,
  outputMint: MintAddress,
});

/** §6.2 / §14.6: persisted provider-independent exit path. Discovered at eligibility time, never during a panic. */
export const EmergencyExitRouteSnapshot = z.object({
  id: Uuid,
  assetId: Uuid,
  /** At most two direct-pool legs (§14.6). */
  hops: z.array(DirectPoolHop).min(1).max(2),
  settlementMint: MintAddress,
  poolStateRef: z.string(),
  lastRefreshedAt: Instant,
  lastRefreshSlot: Slot,
  capacity: z.array(
    z.object({
      inputAmount: Amount,
      expectedOutputAmount: Amount,
      impactBps: Bps,
    }),
  ),
  token2022Compatible: z.boolean(),
  lastDryRun: z
    .object({
      at: Instant,
      ok: z.boolean(),
      simulatedOutputAmount: Amount.nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type EmergencyExitRouteSnapshot = z.infer<typeof EmergencyExitRouteSnapshot>;

export const AssetEligibility = z.object({
  id: Uuid,
  assetId: Uuid,
  evaluatedAt: Instant,
  policyVersion: VersionId,
  eligible: z.boolean(),
  /** Hard rejects are never outweighed by score (§7.3). */
  hardReject: z.boolean(),
  rejectionReasons: ReasonCodes,
  grade: z.number().min(0).max(100).nullable(),
  liquidityUsd: UsdValue.nullable(),
  volume24hUsd: UsdValue.nullable(),
  holderCount: z.number().int().nonnegative().nullable(),
  concentration: ConcentrationMetrics.nullable(),
  mintAuthority: AuthorityState,
  freezeAuthority: AuthorityState,
  token2022: Token2022Profile.nullable(),
  securityFlags: ReasonCodes,
  transferRestrictions: ReasonCodes,
  jupiterRouteAvailable: z.boolean(),
  settlementRouteConfirmed: z.boolean(),
  priceImpactProbes: z.array(PriceImpactProbe),
  insiderMetrics: JsonRecord.nullable(),
  emergencyExitRouteSnapshotId: Uuid.nullable(),
  freshness: z.object({
    securityProviderAt: Instant.nullable(),
    chainReadAt: Instant,
    chainSlot: Slot,
  }),
});
export type AssetEligibility = z.infer<typeof AssetEligibility>;

// §6.3 cohorts and clusters ---------------------------------------------------------------------

export const RiskCohort = z.object({
  id: Uuid,
  name: z.string().min(1).max(64),
  kind: z.enum(['TAXONOMY']),
  versionId: VersionId,
  active: z.boolean(),
  createdAt: Instant,
});
export type RiskCohort = z.infer<typeof RiskCohort>;

export const CohortMembershipSource = z.enum(['MANUAL', 'PROVIDER', 'LLM_SUGGESTION']);

export const AssetCohortMembership = z.object({
  id: Uuid,
  assetId: Uuid,
  cohortId: Uuid,
  source: CohortMembershipSource,
  effectiveVersion: VersionId,
  confidence: Fraction,
  /** LLM suggestions can only ever be INACTIVE_SUGGESTION until a human activates them (D23). */
  approvalState: z.enum(['ACTIVE', 'PENDING', 'REJECTED', 'INACTIVE_SUGGESTION']),
  createdAt: Instant,
});
export type AssetCohortMembership = z.infer<typeof AssetCohortMembership>;

export const CorrelationClusterSet = z.object({
  id: Uuid,
  versionId: VersionId,
  windowStart: Instant,
  windowEnd: Instant,
  calculatedAt: Instant,
  method: z.string(),
  clusters: z.array(
    z.object({
      clusterId: z.string(),
      assetIds: z.array(Uuid).min(1),
    }),
  ),
});
export type CorrelationClusterSet = z.infer<typeof CorrelationClusterSet>;
