import { z } from 'zod';
import { ProtectionMode, StopModel } from '../enums.js';
import { Amount, Instant, MintAddress, Sequence, Sha256Hex, Uuid } from '../primitives.js';
import { JsonRecord } from '../entities/common.js';

// §15.10 executor-local durable journal ----------------------------------------------------------

export const ExecutorJournalKind = z.enum([
  'PAUSE_APPLIED',
  'PAUSE_CLEARED',
  'EMERGENCY_COMMAND_RECEIVED',
  'EMERGENCY_COMMAND_REJECTED',
  'ATTEMPT_PREPARED',
  'ATTEMPT_SIGNED',
  'ATTEMPT_SUBMITTED',
  'ATTEMPT_RESULT',
  'ATTEMPT_OBSERVED',
  'ATTEMPT_REORG_PENDING',
  'CUSTODY_RECONCILED',
  'EXPOSURE_LEDGER_UPDATED',
  'SHADOW_SYNCED',
  'RECONCILED_INTO_DB',
]);
export type ExecutorJournalKind = z.infer<typeof ExecutorJournalKind>;

/** Append-only, hash-chained, written before any network submission (D12, D22). */
export const ExecutorJournalEntry = z.strictObject({
  sequence: Sequence,
  at: Instant,
  kind: ExecutorJournalKind,
  correlationId: z.string().min(1).max(128),
  payload: JsonRecord,
  previousHash: Sha256Hex,
  hash: Sha256Hex,
});
export type ExecutorJournalEntry = z.infer<typeof ExecutorJournalEntry>;

// §6.16C / §15.10A PositionRiskShadow ------------------------------------------------------------

export const ShadowLot = z.strictObject({
  lotId: Uuid,
  quantity: Amount,
  protectionMode: ProtectionMode,
  providerOrderId: z.string().nullable(),
});

export const ShadowPosition = z.strictObject({
  positionId: Uuid,
  assetId: Uuid,
  mint: MintAddress,
  lastConfirmedQuantity: Amount,
  lots: z.array(ShadowLot),
  stop: z.strictObject({ model: StopModel, level: z.number().nonnegative().nullable() }).nullable(),
  trailingLevel: z.number().nonnegative().nullable(),
  timeStopAt: Instant.nullable(),
  /** D39 deterministic unreviewed stop; may only tighten. */
  unreviewedStop: z.number().nonnegative().nullable(),
  primaryRouteSnapshotId: Uuid.nullable(),
  emergencyRouteSnapshotId: Uuid.nullable(),
});

/**
 * Minimum state to keep deterministic protection alive during a Postgres outage. Never authority
 * for quantity: chain/custody truth caps every emergency sell (§6.16C).
 */
export const PositionRiskShadow = z.strictObject({
  sequence: Sequence,
  asOf: Instant,
  settlementMints: z.array(MintAddress).min(1),
  positions: z.array(ShadowPosition),
});
export type PositionRiskShadow = z.infer<typeof PositionRiskShadow>;
