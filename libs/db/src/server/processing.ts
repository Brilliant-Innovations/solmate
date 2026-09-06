import { canonicalHash, type Clock, type QueueMessageEnvelope, type QueueName, type Sha256Hex } from '@sol-agent-trader/contracts';
import { pgmqQueueName } from '../queues.js';
import type { LeasedMessage, PgmqClient } from './queue-client.js';
import { asJson, type Sql } from './sql.js';

/**
 * Idempotent message processing with bounded backoff and dead-lettering (blueprint §5.4, D12).
 *
 * Per message:
 * 1. envelope must validate and carry this deployable's contract-set digest, else DEAD_LETTER;
 * 2. inside one transaction, claim the idempotency key in ops.processed_messages. If already
 *    claimed, the message is a redelivery of completed work: archive it, never re-run the handler;
 * 3. run the handler with the transaction's connection; on success commit and archive;
 * 4. on failure roll back (the claim is released), then either extend the lease with exponential
 *    backoff or, past `maxAttempts`, archive and record a dead letter.
 *
 * A worker that dies mid-handler leaves an uncommitted transaction: nothing is claimed, the lease
 * expires, and another holder processes the message exactly once.
 */

export type MessageHandler = (envelope: QueueMessageEnvelope, tx: Sql) => Promise<unknown>;

export interface ProcessingPolicy {
  maxAttempts: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

export const DEFAULT_PROCESSING_POLICY: ProcessingPolicy = { maxAttempts: 5, backoffBaseSeconds: 5, backoffMaxSeconds: 300 };

export type ProcessingOutcome =
  | { outcome: 'PROCESSED'; resultHash: Sha256Hex | null }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'RETRY_SCHEDULED'; attempt: number; nextVisibleInSeconds: number; error: string }
  | { outcome: 'DEAD_LETTER'; reason: string };

export function backoffSeconds(attempt: number, policy: ProcessingPolicy): number {
  return Math.min(policy.backoffBaseSeconds * 2 ** Math.max(0, attempt - 1), policy.backoffMaxSeconds);
}

export interface ProcessContext {
  sql: Sql;
  client: PgmqClient;
  queue: QueueName;
  message: LeasedMessage;
  handler: MessageHandler;
  holder: string;
  expectedContractSetDigest: Sha256Hex;
  clock: Clock;
  policy?: ProcessingPolicy;
}

export async function processMessage(ctx: ProcessContext): Promise<ProcessingOutcome> {
  const policy = ctx.policy ?? DEFAULT_PROCESSING_POLICY;
  const { message, queue } = ctx;

  if (message.malformed) return deadLetter(ctx, 'MALFORMED_ENVELOPE', null);
  const env = message.envelope;
  if (env.queue !== queue) return deadLetter(ctx, 'QUEUE_MISMATCH', null);
  if (env.contractSetDigest !== ctx.expectedContractSetDigest) return deadLetter(ctx, 'CONTRACT_DIGEST_MISMATCH', null);

  try {
    const result = await ctx.sql.begin(async (tx) => {
      const claimed = await tx<{ idempotency_key: string }[]>`
        insert into ops.processed_messages (idempotency_key, queue, kind, message_id, processed_by)
        values (${env.idempotencyKey}, ${pgmqQueueName(queue)}, ${env.kind}, ${message.messageId.toString()}::bigint, ${ctx.holder})
        on conflict (idempotency_key) do nothing
        returning idempotency_key`;
      if (claimed.length === 0) return { duplicate: true as const };
      const value = await ctx.handler(env, tx as unknown as Sql);
      const resultHash = value === undefined ? null : await canonicalHash(value);
      if (resultHash) await tx`update ops.processed_messages set result_hash = ${resultHash} where idempotency_key = ${env.idempotencyKey}`;
      return { duplicate: false as const, resultHash };
    });
    await ctx.client.archive(queue, message.messageId);
    return result.duplicate ? { outcome: 'DUPLICATE' } : { outcome: 'PROCESSED', resultHash: result.resultHash };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const attempt = message.readCount;
    if (attempt >= policy.maxAttempts) return deadLetter(ctx, 'MAX_ATTEMPTS_EXCEEDED', error);
    const nextVisibleInSeconds = backoffSeconds(attempt, policy);
    await ctx.client.setVisibilityTimeout(queue, message.messageId, nextVisibleInSeconds);
    return { outcome: 'RETRY_SCHEDULED', attempt, nextVisibleInSeconds, error };
  }
}

async function deadLetter(ctx: ProcessContext, reason: string, lastError: string | null): Promise<ProcessingOutcome> {
  const { message, queue } = ctx;
  const env = message.malformed ? null : message.envelope;
  await ctx.sql`
    insert into ops.dead_letters (queue, message_id, idempotency_key, kind, reason, attempts, last_error, message)
    values (${pgmqQueueName(queue)}, ${message.messageId.toString()}::bigint, ${env?.idempotencyKey ?? null}, ${env?.kind ?? null}, ${reason}, ${message.readCount}, ${lastError}, ${ctx.sql.json(asJson(message.raw ?? null))})`;
  await ctx.client.archive(queue, message.messageId);
  return { outcome: 'DEAD_LETTER', reason };
}
