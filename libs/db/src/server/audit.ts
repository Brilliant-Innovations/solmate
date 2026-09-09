import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalHash, type ActionCycle, type ActorKind, type ClearedTransitionSummary, type Instant, type JsonRecord, type Proposal, type Sha256Hex, type Sequence, type Uuid } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Audit ledger access (blueprint §6.22, §20.25, §23.2).
 *
 * Rows are append-only and hash-chained by a database trigger; this module never computes hashes
 * itself. Periodic checkpoints (sequence + hash) are replicated outside Postgres through a
 * `CheckpointReplicator`, so a database-only attacker who rewrites history cannot also rewrite the
 * external record the chain is verified against.
 */

export interface AuditEventInput {
  actor: ActorKind;
  actorRef: string;
  actionClass: string;
  entity: { type: string; id: string };
  beforeSummary?: JsonRecord | null;
  afterSummary?: JsonRecord | null;
  authorityEvidence?: string | null;
  origin?: 'NORMAL' | 'EMERGENCY_JOURNAL_IMPORT' | 'WATCHDOG';
  liveImpacting?: boolean;
  originalLocalAt?: Instant | null;
}

export interface AuditEventRow {
  id: string;
  sequence: Sequence;
  at: Instant;
  hash: Sha256Hex;
  previousHash: Sha256Hex;
}

interface RawRow {
  id: string;
  sequence: string | number | bigint;
  at: Date;
  hash: string;
  previous_hash: string;
}

const toRow = (r: RawRow): AuditEventRow => ({
  id: r.id,
  sequence: Number(r.sequence) as Sequence,
  at: r.at.toISOString() as Instant,
  hash: r.hash as Sha256Hex,
  previousHash: r.previous_hash as Sha256Hex,
});

/** Append one audit event. Pass a transaction `Sql` to make it atomic with the change it records. */
export async function writeAuditEvent(sql: Sql, e: AuditEventInput): Promise<AuditEventRow> {
  const [row] = await sql<RawRow[]>`
    insert into audit.events (actor, actor_ref, action_class, entity, before_summary, after_summary, authority_evidence, origin, live_impacting, original_local_at, imported_at)
    values (
      ${e.actor}, ${e.actorRef}, ${e.actionClass}, ${sql.json(asJson(e.entity))},
      ${e.beforeSummary ? sql.json(asJson(e.beforeSummary)) : null}, ${e.afterSummary ? sql.json(asJson(e.afterSummary)) : null},
      ${e.authorityEvidence ?? null}, ${e.origin ?? 'NORMAL'}, ${e.liveImpacting ?? false},
      ${e.originalLocalAt ?? null}, ${e.origin === 'EMERGENCY_JOURNAL_IMPORT' ? sql`now()` : null}
    )
    returning id, sequence, at, hash, previous_hash`;
  if (!row) throw new Error('audit insert returned no row');
  return toRow(row);
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSequence: number | null;
}

export async function verifyAuditChain(sql: Sql): Promise<ChainVerification> {
  const [row] = await sql<{ ok: boolean; checked: string | number; first_bad_sequence: string | number | null }[]>`select ok, checked, first_bad_sequence from audit.verify_chain()`;
  return { ok: row?.ok ?? false, checked: Number(row?.checked ?? 0), firstBadSequence: row?.first_bad_sequence === null || row === undefined ? null : Number(row.first_bad_sequence) };
}

export interface AuditCheckpoint {
  sequence: Sequence;
  hash: Sha256Hex;
  checkpointedAt: Instant;
}

/** Stores a checkpoint outside Postgres and returns a label describing where. */
export interface CheckpointReplicator {
  readonly label: string;
  replicate(checkpoint: AuditCheckpoint): Promise<void>;
  /** The most recent checkpoint this replica holds, or null. */
  latest(): Promise<AuditCheckpoint | null>;
}

/** Append-only JSON-lines file, e.g. on the executor-local durable journal volume (§20.25). */
export class FileCheckpointReplicator implements CheckpointReplicator {
  readonly label: string;
  constructor(private readonly path: string) {
    this.label = `file:${path}`;
  }
  async replicate(cp: AuditCheckpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(cp) + '\n', 'utf8');
  }
  async latest(): Promise<AuditCheckpoint | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      const lines = (await readFile(this.path, 'utf8')).trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      return last ? (JSON.parse(last) as AuditCheckpoint) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Checkpoint the current chain head: verify the chain, replicate the head externally, then record
 * the checkpoint in Postgres with the replica labels. Returns null when the ledger is empty.
 */
export async function checkpointAuditChain(sql: Sql, replicators: readonly CheckpointReplicator[]): Promise<AuditCheckpoint | null> {
  const verification = await verifyAuditChain(sql);
  if (!verification.ok) throw new Error(`audit chain broken at sequence ${verification.firstBadSequence}; refusing to checkpoint`);
  const [head] = await sql<{ sequence: string | number; hash: string }[]>`select sequence, hash from audit.events order by sequence desc limit 1`;
  if (!head) return null;
  const cp: AuditCheckpoint = { sequence: Number(head.sequence) as Sequence, hash: head.hash as Sha256Hex, checkpointedAt: new Date().toISOString() as Instant };
  const labels: string[] = [];
  for (const r of replicators) {
    await r.replicate(cp);
    labels.push(r.label);
  }
  await sql`
    insert into audit.checkpoints (sequence, hash, checkpointed_at, replicated_to)
    values (${cp.sequence}, ${cp.hash}, ${cp.checkpointedAt}, ${labels})
    on conflict (sequence) do update set replicated_to = excluded.replicated_to`;
  return cp;
}

export type CheckpointVerification =
  | { ok: true; checkpoint: AuditCheckpoint }
  | { ok: false; reason: 'NO_EXTERNAL_CHECKPOINT' | 'CHAIN_BROKEN' | 'HASH_MISMATCH_AT_CHECKPOINT' | 'CHECKPOINT_BEYOND_LEDGER'; detail: string };

/**
 * The Audit Log screen's "last verified checkpoint": the external replica's latest checkpoint
 * must match the ledger row at that sequence and the chain up to the head must verify. A rewritten
 * ledger fails here even if the attacker also rewrote audit.checkpoints (§20.25).
 */
/**
 * Cache identity for a chain-standing verdict (ADR-0009 P2; DEFECT-3, 2026-09-09).
 *
 * A verdict is a statement about **two** stores — the ledger in Postgres and the external replica —
 * so caching it under the ledger head alone lets the replica change, vanish or rot unnoticed for as
 * long as the ledger is quiet. Both go in the key, and an absent replica keys differently from a
 * present one so its loss invalidates rather than hides. Callers must still bound the entry by time:
 * an identical key means neither store has moved, not that the verdict is fresh forever.
 */
export function chainStandingCacheKey(ledgerHeadHash: string, external: AuditCheckpoint | null): string {
  return `${ledgerHeadHash}|${external ? `${external.sequence}:${external.hash}` : 'none'}`;
}

export async function verifyAgainstExternalCheckpoint(sql: Sql, replicator: CheckpointReplicator): Promise<CheckpointVerification> {
  const external = await replicator.latest();
  if (!external) return { ok: false, reason: 'NO_EXTERNAL_CHECKPOINT', detail: replicator.label };
  const chain = await verifyAuditChain(sql);
  if (!chain.ok) return { ok: false, reason: 'CHAIN_BROKEN', detail: `first bad sequence ${chain.firstBadSequence}` };
  const [row] = await sql<{ hash: string }[]>`select hash from audit.events where sequence = ${external.sequence}`;
  if (!row) return { ok: false, reason: 'CHECKPOINT_BEYOND_LEDGER', detail: `sequence ${external.sequence} missing` };
  if (row.hash !== external.hash) return { ok: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT', detail: `sequence ${external.sequence}` };
  return { ok: true, checkpoint: external };
}

// ADR-0009 P2 — clearance provenance -------------------------------------------------------------

export interface ClearedTransitionInput {
  cycle: ActionCycle;
  proposal: Proposal;
  /** Digest of the Release the strategy runs under; null when the caller cannot name it (tests). The authorizer requires it. */
  releaseDigest: Sha256Hex | null;
  lotIds?: readonly Uuid[];
}

/**
 * Records a CLEARED transition as a hash-chained audit event (proposal hash, cutoff, verdict, Release
 * digest, lot) and points the cycle row at it. Call inside the transaction that writes the cycle so
 * a clearance can never exist without its ledger row.
 */
export async function recordClearedTransition(t: Sql, input: ClearedTransitionInput): Promise<AuditEventRow> {
  const { cycle, proposal } = input;
  if (cycle.state !== 'CLEARED' || cycle.clearedCutoffVersion === null || cycle.verdict === null) throw new Error(`cycle ${cycle.id} is not CLEARED`);
  if (proposal.id !== cycle.proposalId) throw new Error(`proposal ${proposal.id} is not the cycle's proposal`);
  const summary: ClearedTransitionSummary = {
    cycleId: cycle.id,
    proposalId: proposal.id,
    proposalHash: await canonicalHash(proposal.proposal),
    cutoffVersion: cycle.clearedCutoffVersion,
    verdict: cycle.verdict,
    strategyVersionId: cycle.strategyVersionId,
    releaseDigest: input.releaseDigest,
    positionId: cycle.positionId,
    lotIds: [...(input.lotIds ?? [])],
  };
  const row = await writeAuditEvent(t, { actor: 'WORKER', actorRef: 'action-cycle', actionClass: 'ACTION_CYCLE_CLEARED', entity: { type: 'action_cycle', id: cycle.id }, afterSummary: summary as unknown as JsonRecord, liveImpacting: true });
  await t`update agents.action_cycles set cleared_audit_sequence = ${row.sequence}, cleared_audit_hash = ${row.hash} where id = ${cycle.id}`;
  return row;
}

export interface AuditEventDetail extends AuditEventRow {
  actionClass: string;
  entity: { type: string; id: string };
  afterSummary: JsonRecord | null;
}

export async function auditEventAt(sql: Sql, sequence: number): Promise<AuditEventDetail | null> {
  const [r] = await sql<(RawRow & { action_class: string; entity: { type: string; id: string }; after_summary: JsonRecord | null })[]>`
    select id, sequence, at, hash, previous_hash, action_class, entity, after_summary from audit.events where sequence = ${sequence}`;
  if (!r) return null;
  return { ...toRow(r), actionClass: r.action_class, entity: r.entity, afterSummary: r.after_summary };
}

/** The ledger head the state projector carries so the authorizer can tell a clearance the projection already covers from one appended later. */
export async function auditHead(sql: Sql): Promise<{ sequence: Sequence; hash: Sha256Hex } | null> {
  const [r] = await sql<{ sequence: string | number; hash: string }[]>`select sequence, hash from audit.events order by sequence desc limit 1`;
  return r ? { sequence: Number(r.sequence) as Sequence, hash: r.hash as Sha256Hex } : null;
}

// §20.25 — persisted verification ---------------------------------------------------------------

export interface AuditVerificationInput {
  ok: boolean;
  headSequence: number | null;
  checkpoint: { sequence: number; hash: string } | null;
  replica: string;
  reason: string | null;
  detail: string | null;
}

/**
 * Records the outcome of one checkpoint/verify cycle so the Audit Log screen shows the last
 * verified checkpoint from a fact in the ledger's own schema rather than from a log line. Rows are
 * immutable; a failed verification stays visible until a later cycle passes.
 */
export async function recordAuditVerification(sql: Sql, v: AuditVerificationInput): Promise<void> {
  await sql`
    insert into audit.verifications (ok, head_sequence, checkpoint_sequence, checkpoint_hash, replica, reason, detail)
    values (${v.ok}, ${v.headSequence}, ${v.checkpoint?.sequence ?? null}, ${v.checkpoint?.hash ?? null}, ${v.replica}, ${v.reason}, ${v.detail === null ? null : v.detail.slice(0, 1024)})`;
}

export interface AuditVerificationRow {
  verifiedAt: Instant;
  ok: boolean;
  headSequence: number | null;
  checkpointSequence: number | null;
  replica: string;
  reason: string | null;
}

export async function latestAuditVerification(sql: Sql): Promise<AuditVerificationRow | null> {
  const [row] = await sql<{ verified_at: string; ok: boolean; head_sequence: string | null; checkpoint_sequence: string | null; replica: string; reason: string | null }[]>`
    select verified_at, ok, head_sequence, checkpoint_sequence, replica, reason from audit.verifications order by verified_at desc limit 1`;
  if (!row) return null;
  return {
    verifiedAt: new Date(row.verified_at).toISOString() as Instant,
    ok: row.ok,
    headSequence: row.head_sequence === null ? null : Number(row.head_sequence),
    checkpointSequence: row.checkpoint_sequence === null ? null : Number(row.checkpoint_sequence),
    replica: row.replica,
    reason: row.reason,
  };
}
