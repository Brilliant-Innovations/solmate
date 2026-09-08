import { z } from 'zod';
import { FreshnessEffectOnEntries } from '../entities/market-data.js';
import { Instant, Milliseconds, Slot, Uuid, VersionId } from '../primitives.js';

/**
 * Chain health (blueprint §14.7, §40.3, D49). The worker samples slot advancement, the
 * confirmed/finalized lag and the divergence between independent RPC views; a halt, stalled
 * finality, material divergence or an unreadable chain blocks new entries and raises an alert.
 * Nothing here invents chain truth: the snapshot records what each view said and the verdict the
 * policy draws from it. Provider-side protection stays independently relevant.
 */

export const ChainHealthState = z.enum(['HEALTHY', 'LAGGING', 'STALLED', 'DIVERGENT', 'UNAVAILABLE']);
export type ChainHealthState = z.infer<typeof ChainHealthState>;

export const ChainHealthPolicy = z.strictObject({
  version: VersionId,
  /** No confirmed-slot advance across samples for this long is a halt (STALLED). */
  maxSlotStallMs: Milliseconds,
  /** confirmed − finalized above this is LAGGING (entries still allowed, surfaced). */
  lagWarnSlots: z.number().int().positive(),
  /** confirmed − finalized above this is stalled finality (STALLED, entries blocked). */
  lagBlockSlots: z.number().int().positive(),
  /** Independent views whose confirmed slots differ by more than this are DIVERGENT (entries blocked). */
  maxViewDivergenceSlots: z.number().int().positive(),
  /** A view whose head is this far past a transaction's slot and still does not know the signature contradicts a view that does. */
  signatureGraceSlots: z.number().int().nonnegative(),
});
export type ChainHealthPolicy = z.infer<typeof ChainHealthPolicy>;

/** ~2.5 slots/s on mainnet: 30 s without a new confirmed slot is a halt; finality normally trails by ~32 slots. */
export const DEFAULT_CHAIN_HEALTH_POLICY: ChainHealthPolicy = {
  version: 'chain-health-v1' as VersionId,
  maxSlotStallMs: 30_000,
  lagWarnSlots: 96,
  lagBlockSlots: 400,
  maxViewDivergenceSlots: 150,
  signatureGraceSlots: 64,
};

export const ChainView = z.strictObject({
  label: z.string().min(1).max(64),
  ok: z.boolean(),
  slotConfirmed: Slot.nullable(),
  slotFinalized: Slot.nullable(),
  blockHeight: z.number().int().nonnegative().nullable(),
  latencyMs: Milliseconds.nullable(),
  error: z.string().max(512).nullable(),
});
export type ChainView = z.infer<typeof ChainView>;

export const ChainHealthSnapshot = z.strictObject({
  id: Uuid,
  observedAt: Instant,
  policyVersion: VersionId,
  state: ChainHealthState,
  views: z.array(ChainView).min(1),
  /** Highest confirmed slot across healthy views; null when none answered. */
  headSlot: Slot.nullable(),
  slotAdvanced: z.boolean().nullable(),
  confirmedFinalizedLagSlots: z.number().int().nullable(),
  viewDivergenceSlots: z.number().int().nonnegative().nullable(),
  effectOnEntries: FreshnessEffectOnEntries,
  reasons: z.array(z.string().max(160)).max(16),
});
export type ChainHealthSnapshot = z.infer<typeof ChainHealthSnapshot>;
