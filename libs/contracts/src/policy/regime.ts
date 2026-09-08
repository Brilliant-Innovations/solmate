import { z } from 'zod';
import { VersionId } from '../primitives.js';

/**
 * Deterministic market regime classification (blueprint §8.5, D62). One label per closed minute
 * from the SOL reference series and the cross-section of warm tracked assets; rules apply in a
 * fixed order so at most one regime is emitted and identical inputs always yield the same label.
 * POST_EVENT_INSTABILITY needs normalized events (M6) and is never emitted by this version.
 * Too few warm assets yields no label (null), never a default regime.
 */
export const MarketRegimePolicy = z.strictObject({
  version: VersionId,
  /** Warm assets with a 1h return required before any label is emitted. */
  minAssets: z.number().int().min(2),
  /** VOLATILITY_SHOCK: median |ret_1h| across the universe, or |SOL ret_1h|, at or above these. */
  shockMedianAbsReturn1h: z.number().positive(),
  shockSolAbsReturn1h: z.number().positive(),
  /** BROAD_SELLOFF: breadth (share of assets with ret_1h > 0) at or below, and median ret_1h at or below. */
  selloffBreadth: z.number().min(0).max(1),
  selloffMedianReturn1h: z.number().negative(),
  /** SOL_LED_RALLY: SOL ret_1h at or above, and ahead of the universe median by at least the margin. */
  solLedReturn1h: z.number().positive(),
  solLeadMargin: z.number().positive(),
  /** NARRATIVE_ROTATION: one cohort's median ret_1h leads the universe median by at least this while breadth is mixed. */
  rotationCohortLead: z.number().positive(),
  rotationBreadthMin: z.number().min(0).max(1),
  rotationBreadthMax: z.number().min(0).max(1),
  /** Members a cohort needs before its median counts. */
  rotationMinCohortMembers: z.number().int().min(2),
  /** RISK_ON_TREND: breadth at or above, median ret_1h at or above. */
  riskOnBreadth: z.number().min(0).max(1),
  riskOnMedianReturn1h: z.number().positive(),
  /** LOW_LIQUIDITY_CHOP: median rel_volume_60 at or below and median |ret_1h| at or below. */
  chopMedianRelVolume: z.number().positive(),
  chopMedianAbsReturn1h: z.number().positive(),
});
export type MarketRegimePolicy = z.infer<typeof MarketRegimePolicy>;

export const DEFAULT_MARKET_REGIME_POLICY: MarketRegimePolicy = {
  version: 'regime-v1' as VersionId,
  minAssets: 8,
  shockMedianAbsReturn1h: 0.08,
  shockSolAbsReturn1h: 0.05,
  selloffBreadth: 0.3,
  selloffMedianReturn1h: -0.02,
  solLedReturn1h: 0.02,
  solLeadMargin: 0.01,
  rotationCohortLead: 0.03,
  rotationBreadthMin: 0.35,
  rotationBreadthMax: 0.65,
  rotationMinCohortMembers: 3,
  riskOnBreadth: 0.6,
  riskOnMedianReturn1h: 0.005,
  chopMedianRelVolume: 0.7,
  chopMedianAbsReturn1h: 0.01,
};
