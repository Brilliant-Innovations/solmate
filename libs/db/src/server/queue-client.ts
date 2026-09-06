import { QueueMessageEnvelope, type QueueName } from '@sol-agent-trader/contracts';
import { pgmqQueueName } from '../queues.js';
import { asJson, type Sql } from './sql.js';

/**
 * Thin pgmq adapter (blueprint §5.4). Every message is a validated QueueMessageEnvelope.
 * Leases are pgmq visibility timeouts; a consumer that dies simply lets the lease expire and the
 * message becomes visible again for another holder.
 */

export interface LeasedMessage {
  messageId: bigint;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  envelope: QueueMessageEnvelope;
  /** Raw payload when it failed envelope validation; `envelope` is then a best-effort parse. */
  malformed: boolean;
  raw: unknown;
}

interface PgmqRow {
  msg_id: string | number | bigint;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: unknown;
}

function toLeased(row: PgmqRow): LeasedMessage {
  const parsed = QueueMessageEnvelope.safeParse(row.message);
  return {
    messageId: BigInt(row.msg_id),
    readCount: row.read_ct,
    enqueuedAt: row.enqueued_at,
    visibleAt: row.vt,
    envelope: parsed.success ? parsed.data : (row.message as QueueMessageEnvelope),
    malformed: !parsed.success,
    raw: row.message,
  };
}

export class PgmqClient {
  constructor(private readonly sql: Sql) {}

  async send(envelope: QueueMessageEnvelope, delaySeconds = 0): Promise<bigint> {
    const validated = QueueMessageEnvelope.parse(envelope);
    const q = pgmqQueueName(validated.queue);
    const [row] = await this.sql<{ send: string }[]>`select pgmq.send(${q}::text, ${this.sql.json(asJson(validated))}, ${delaySeconds}::integer) as send`;
    if (!row) throw new Error('pgmq.send returned no id');
    return BigInt(row.send);
  }

  async read(queue: QueueName, visibilityTimeoutSeconds: number, batch: number): Promise<LeasedMessage[]> {
    const q = pgmqQueueName(queue);
    const rows = await this.sql<PgmqRow[]>`select msg_id, read_ct, enqueued_at, vt, message from pgmq.read(${q}, ${visibilityTimeoutSeconds}, ${batch})`;
    return rows.map(toLeased);
  }

  async archive(queue: QueueName, messageId: bigint): Promise<boolean> {
    const q = pgmqQueueName(queue);
    const [row] = await this.sql<{ archive: boolean }[]>`select pgmq.archive(${q}, ${messageId.toString()}::bigint) as archive`;
    return row?.archive ?? false;
  }

  async delete(queue: QueueName, messageId: bigint): Promise<boolean> {
    const q = pgmqQueueName(queue);
    const [row] = await this.sql<{ delete: boolean }[]>`select pgmq.delete(${q}, ${messageId.toString()}::bigint) as delete`;
    return row?.delete ?? false;
  }

  /** Extend or shorten the lease of a message (used for backoff and heartbeat-style renewal). */
  async setVisibilityTimeout(queue: QueueName, messageId: bigint, seconds: number): Promise<void> {
    const q = pgmqQueueName(queue);
    await this.sql`select pgmq.set_vt(${q}, ${messageId.toString()}::bigint, ${seconds})`;
  }

  async depth(queue: QueueName): Promise<number> {
    const q = pgmqQueueName(queue);
    const [row] = await this.sql<{ queue_length: string | number }[]>`select queue_length from pgmq.metrics(${q})`;
    return Number(row?.queue_length ?? 0);
  }
}
