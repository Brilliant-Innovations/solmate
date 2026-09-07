import { z } from 'zod';
import { PositionSafetyState } from '../enums.js';
import { Amount, Bps, Instant, Milliseconds, Slot, UsdValue, Uuid, VersionId } from '../primitives.js';

/**
 * Held-asset safety and exit compatibility (blueprint §7.5, D34, §14.6; §31 "held-asset
 * safety/executability is continuously revalidated"). Distinct from entry eligibility: a token
 * becoming ineligible for new entries is a reason to consider reducing, never a reason the
 * system refuses to sell it. `ExitCompatibility` is therefore a function of route facts alone.
 */

export const SafetyReason = z.enum([
  // CRITICAL_EXIT: the asset can no longer be held safely or moved normally
  'MINT_PAUSED',
  'NON_TRANSFERABLE_NOW',
  'DEFAULT_ACCOUNT_FROZEN_NOW',
  'FREEZE_AUTHORITY_ADDED',
  'TRANSFER_HOOK_ADDED',
  'PERMANENT_DELEGATE_ADDED',
  'NO_EXIT_PATH',
  // EXIT_RECOMMENDED: exit while a path still exists
  'NO_PRIMARY_EXIT_ROUTE',
  'SELL_IMPACT_ABOVE_MAX',
  'LIQUIDITY_COLLAPSE',
  'TRANSFER_FEE_RAISED',
  'EXIT_PATH_UNVERIFIED',
  // DEGRADED: watch closely, refresh, do not add
  'EMERGENCY_ROUTE_MISSING',
  'EMERGENCY_ROUTE_STALE',
  'EMERGENCY_POOL_CHANGED',
  'SECURITY_DATA_STALE',
  'SECURITY_DATA_UNAVAILABLE',
  'MARKET_DATA_UNAVAILABLE',
  'LIQUIDITY_DROP',
  'CHAIN_READ_STALE',
  'CONCENTRATION_SHOCK',
  'SECURITY_PROVIDER_ALERT',
  'PRIMARY_ROUTE_UNKNOWN',
]);
export type SafetyReason = z.infer<typeof SafetyReason>;

export const SafetyTrigger = z.enum(['PERIODIC', 'LIQUIDITY_CHANGE', 'METADATA_CHANGE', 'PROVIDER_ALERT', 'ROUTE_CHANGE', 'CONCENTRATION_SHOCK', 'EXIT_REQUESTED']);
export type SafetyTrigger = z.infer<typeof SafetyTrigger>;

/** Whether exposure can be reduced right now, and how. Never consults entry eligibility. */
export const ExitCompatibility = z.object({
  primaryRouteAvailable: z.boolean(),
  /** Measured impact of selling the whole position through the primary route. */
  primaryImpactBps: Bps.nullable(),
  emergencyRouteAvailable: z.boolean(),
  emergencySnapshotAgeMs: Milliseconds.nullable(),
  token2022Compatible: z.boolean(),
  canReduceNow: z.boolean(),
});
export type ExitCompatibility = z.infer<typeof ExitCompatibility>;

/** Facts remembered from the previous evaluation (or the entry eligibility record) to detect change. */
export const SafetyBaseline = z.object({
  source: z.enum(['ENTRY_ELIGIBILITY', 'PREVIOUS_SAFETY']),
  freezeAuthorityPresent: z.boolean(),
  transferHook: z.boolean(),
  permanentDelegate: z.boolean(),
  transferFeeBps: Bps.nullable(),
  liquidityUsd: UsdValue.nullable(),
  top10: z.number().min(0).max(1).nullable(),
  emergencyPoolAddress: z.string().nullable(),
});
export type SafetyBaseline = z.infer<typeof SafetyBaseline>;

export const HeldAssetSafety = z.object({
  id: Uuid,
  positionId: Uuid,
  assetId: Uuid,
  evaluatedAt: Instant,
  policyVersion: VersionId,
  state: PositionSafetyState,
  previousState: PositionSafetyState.nullable(),
  reasons: z.array(SafetyReason),
  triggers: z.array(SafetyTrigger).min(1),
  exitCompatibility: ExitCompatibility,
  positionQuantity: Amount,
  chainSlot: Slot,
  liquidityUsd: UsdValue.nullable(),
  /** Facts this evaluation observed, becoming the next evaluation's baseline. */
  observed: SafetyBaseline.omit({ source: true }),
  baseline: SafetyBaseline,
});
export type HeldAssetSafety = z.infer<typeof HeldAssetSafety>;
