import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActorKind, Instant, JsonRecord, Sha256Hex, Sequence } from '@sol-agent-trader/contracts';
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
