import { z } from 'zod';
import { ActorKind } from '../enums.js';
import { Instant, Sequence, Sha256Hex, Uuid, VersionId } from '../primitives.js';
import { JsonRecord } from './common.js';

// §6.22 audit.events (append-only, hash-chained; §20.25) ---------------------------------------

export const AuditEvent = z.object({
  id: Uuid,
  sequence: Sequence,
  at: Instant,
  actor: ActorKind,
  actorRef: z.string().min(1).max(256),
  actionClass: z.string().min(1).max(64),
  entity: z.object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) }),
  beforeSummary: JsonRecord.nullable(),
  afterSummary: JsonRecord.nullable(),
  authorityEvidence: z.string().nullable(),
  origin: z.enum(['NORMAL', 'EMERGENCY_JOURNAL_IMPORT', 'WATCHDOG']),
  liveImpacting: z.boolean(),
  /** Hash chain: `hash = sha256(canonical(previousHash + row-without-hash))`. */
  previousHash: Sha256Hex,
  hash: Sha256Hex,
  /** Set only for rows imported from an executor-local journal after a DB outage (§20.25). */
  originalLocalAt: Instant.nullable(),
  importedAt: Instant.nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditCheckpoint = z.object({
  sequence: Sequence,
  hash: Sha256Hex,
  checkpointedAt: Instant,
  replicatedTo: z.array(z.string()),
});
export type AuditCheckpoint = z.infer<typeof AuditCheckpoint>;

// ADR-0009 P2 — clearance provenance ------------------------------------------------------------

/** Where a CLEARED action cycle's clearance lives in the ledger; the authorizer verifies the row and the chain. */
export const ClearedAuditRef = z.object({ sequence: Sequence, hash: Sha256Hex });
export type ClearedAuditRef = z.infer<typeof ClearedAuditRef>;

/** The `after_summary` of an ACTION_CYCLE_CLEARED event: everything a fabricated clearance would have to forge consistently. */
export const ClearedTransitionSummary = z.object({
  cycleId: Uuid,
  proposalId: Uuid,
  /** Canonical hash of the proposal payload as cleared. */
  proposalHash: Sha256Hex,
  cutoffVersion: z.number().int().positive(),
  verdict: z.string().min(1).max(32),
  strategyVersionId: VersionId,
  releaseDigest: Sha256Hex.nullable(),
  positionId: Uuid.nullable(),
  lotIds: z.array(Uuid),
});
export type ClearedTransitionSummary = z.infer<typeof ClearedTransitionSummary>;
