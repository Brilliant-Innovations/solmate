import { z } from 'zod';
import { Milliseconds, VersionId } from '../primitives.js';
import { DataClass, FreshnessEffectOnEntries, FreshnessEffectOnExits } from '../entities/market-data.js';

/**
 * Freshness requirements (blueprint §21.1; ADR-0011). What a decision needs, keyed by strategy speed
 * tier — never by the purchased provider tier. A provider that cannot meet the requirement reports
 * DEGRADED/FAILED and blocks entries; the limit is not loosened to fit the tier.
 */
export const StrategySpeedTier = z.enum(['T0_FAST', 'T1_STANDARD', 'T2_SLOW']);
export type StrategySpeedTier = z.infer<typeof StrategySpeedTier>;

export const FreshnessRequirement = z.strictObject({
  dataClass: DataClass,
  freshMaxAgeMs: Milliseconds,
  degradedMaxAgeMs: Milliseconds,
  effectOnEntries: FreshnessEffectOnEntries,
  effectOnExits: FreshnessEffectOnExits,
});
export type FreshnessRequirement = z.infer<typeof FreshnessRequirement>;

export const FreshnessRequirements = z.strictObject({
  version: VersionId,
  speedTier: StrategySpeedTier,
  requirements: z.array(FreshnessRequirement).min(1),
});
export type FreshnessRequirements = z.infer<typeof FreshnessRequirements>;

const price = (fresh: number): Pick<FreshnessRequirement, 'freshMaxAgeMs' | 'degradedMaxAgeMs'> => ({ freshMaxAgeMs: fresh, degradedMaxAgeMs: fresh * 3 });

function requirementsFor(tier: StrategySpeedTier): FreshnessRequirement[] {
  const priceFresh = tier === 'T0_FAST' ? 5_000 : tier === 'T1_STANDARD' ? 15_000 : 60_000;
  return [
    { dataClass: 'ACTIVE_POSITION_PRICE', ...price(priceFresh), effectOnEntries: 'BLOCK', effectOnExits: 'BLOCK_IF_NO_ALTERNATIVE' },
    { dataClass: 'CANDIDATE_PRICE', ...price(priceFresh * 2), effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { dataClass: 'CANDLES', freshMaxAgeMs: 90_000, degradedMaxAgeMs: 300_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { dataClass: 'TOKEN_OVERVIEW', freshMaxAgeMs: 120_000, degradedMaxAgeMs: 600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { dataClass: 'DISCOVERY_LIST', freshMaxAgeMs: 300_000, degradedMaxAgeMs: 1_800_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
    { dataClass: 'TOKEN_SECURITY', freshMaxAgeMs: 3_600_000, degradedMaxAgeMs: 21_600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { dataClass: 'HOLDER_DISTRIBUTION', freshMaxAgeMs: 3_600_000, degradedMaxAgeMs: 21_600_000, effectOnEntries: 'BLOCK', effectOnExits: 'NONE' },
    { dataClass: 'SOCIAL_TRENDS', freshMaxAgeMs: 900_000, degradedMaxAgeMs: 3_600_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
    { dataClass: 'PROJECT_METADATA', freshMaxAgeMs: 86_400_000, degradedMaxAgeMs: 604_800_000, effectOnEntries: 'NONE', effectOnExits: 'NONE' },
  ];
}

export const FRESHNESS_REQUIREMENTS: Readonly<Record<StrategySpeedTier, FreshnessRequirements>> = {
  T0_FAST: { version: 'freshness-t0-v1' as VersionId, speedTier: 'T0_FAST', requirements: requirementsFor('T0_FAST') },
  T1_STANDARD: { version: 'freshness-t1-v1' as VersionId, speedTier: 'T1_STANDARD', requirements: requirementsFor('T1_STANDARD') },
  T2_SLOW: { version: 'freshness-t2-v1' as VersionId, speedTier: 'T2_SLOW', requirements: requirementsFor('T2_SLOW') },
};

/** Until a Release binds a speed tier (M5a), deployments run the T1_STANDARD requirement set. */
export const DEFAULT_FRESHNESS_REQUIREMENTS: FreshnessRequirements = FRESHNESS_REQUIREMENTS.T1_STANDARD;
