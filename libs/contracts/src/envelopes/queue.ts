import { z } from 'zod';
import { QueueName } from '../enums.js';
import { IdempotencyKey, Instant, Sha256Hex, Uuid } from '../primitives.js';
import { JsonRecord } from '../entities/common.js';

// §5.4 queue message contract (durable pgmq queues) ---------------------------------------------

/**
 * Every queued message carries its own idempotency key and the contract-set digest of the
 * producer, so a consumer built from a different contract set refuses the message instead of
 * misreading it (D50).
 */
export const QueueMessageEnvelope = z.strictObject({
  messageId: Uuid,
  queue: QueueName,
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  kindVersion: z.number().int().positive(),
  idempotencyKey: IdempotencyKey,
  correlationId: z.string().min(1).max(128),
  causationId: z.string().min(1).max(128).nullable(),
  enqueuedAt: Instant,
  attempt: z.number().int().positive(),
  contractSetDigest: Sha256Hex,
  payload: JsonRecord,
});
export type QueueMessageEnvelope = z.infer<typeof QueueMessageEnvelope>;
