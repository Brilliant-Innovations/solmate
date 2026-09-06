import { randomUUID } from 'node:crypto';
import { getContractSetDigest, systemClock, type IdempotencyKey, type QueueMessageEnvelope, type Sha256Hex } from '@sol-agent-trader/contracts';
import { LeaseManager } from './leases.js';
import { backoffSeconds, DEFAULT_PROCESSING_POLICY, processMessage } from './processing.js';
import { PgmqClient } from './queue-client.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

/**
 * Integration tests against a local Supabase (`pnpm exec supabase start`). Skipped when
 * SUPABASE_DB_URL / DATABASE_URL is not set, run in the CI database job.
 */
const url = databaseUrlFromEnv();

describe.skipIf(!url)('pgmq processing against a real database (§5.4, D12)', () => {
  let sql: Sql;
  let client: PgmqClient;
  let digest: Sha256Hex;

  beforeAll(async () => {
    sql = createSql({ url: url as string, applicationName: 'db-integration-test' });
    client = new PgmqClient(sql);
    digest = (await getContractSetDigest()).digest;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  const envelope = (over: Partial<QueueMessageEnvelope> = {}): QueueMessageEnvelope => ({
    messageId: randomUUID() as QueueMessageEnvelope['messageId'],
    queue: 'trading-actions',
    kind: 'test.echo',
    kindVersion: 1,
    idempotencyKey: `test:${randomUUID()}` as IdempotencyKey,
    correlationId: 'it',
    causationId: null,
    enqueuedAt: systemClock.now(),
    attempt: 1,
    contractSetDigest: digest,
    payload: { hello: 'world' },
    ...over,
  });

  async function readOne(holder = 'worker-a', vt = 30) {
    const [m] = await client.read('trading-actions', vt, 1);
    if (!m) throw new Error('expected a message');
    return { m, holder };
  }

  it('processes a message exactly once and archives it; a redelivery with the same key is a duplicate', async () => {
    const env = envelope();
    await client.send(env);
    let calls = 0;
    const handler = async () => {
      calls++;
      return { ok: true };
    };
    const { m } = await readOne();
    const first = await processMessage({ sql, client, queue: 'trading-actions', message: m, handler, holder: 'worker-a', expectedContractSetDigest: digest, clock: systemClock });
    expect(first.outcome).toBe('PROCESSED');
    expect(calls).toBe(1);
    const [row] = await sql`select processed_by, result_hash from ops.processed_messages where idempotency_key = ${env.idempotencyKey}`;
    expect(row?.processed_by).toBe('worker-a');
    expect(row?.result_hash).toMatch(/^[0-9a-f]{64}$/);

    // the same message re-sent (redelivery after a lost ack) must not run the handler again
    await client.send(env);
    const { m: again } = await readOne('worker-b');
    const second = await processMessage({ sql, client, queue: 'trading-actions', message: again, handler, holder: 'worker-b', expectedContractSetDigest: digest, clock: systemClock });
    expect(second.outcome).toBe('DUPLICATE');
    expect(calls).toBe(1);
  });

  it('a worker that dies mid-handler leaves no claim; the lease expires and another worker processes once', async () => {
    const env = envelope();
    await client.send(env);
    const { m } = await readOne('worker-a', 1);
    // worker-a starts a transaction, claims, then "dies" (rollback, never archives)
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into ops.processed_messages (idempotency_key, queue, kind, message_id, processed_by) values (${env.idempotencyKey}, 'trading_actions', ${env.kind}, ${m.messageId.toString()}::bigint, 'worker-a')`;
        throw new Error('process crashed');
      }),
    ).rejects.toThrow('process crashed');
    await new Promise((r) => setTimeout(r, 1300));
    const { m: recovered } = await readOne('worker-b', 30);
    expect(recovered.messageId).toBe(m.messageId);
    expect(recovered.readCount).toBe(2);
    let calls = 0;
    const r = await processMessage({ sql, client, queue: 'trading-actions', message: recovered, handler: async () => void calls++, holder: 'worker-b', expectedContractSetDigest: digest, clock: systemClock });
    expect(r.outcome).toBe('PROCESSED');
    expect(calls).toBe(1);
  });

  it('a failing handler is retried with exponential backoff and dead-lettered after max attempts', async () => {
    const env = envelope();
    await client.send(env);
    const policy = { maxAttempts: 2, backoffBaseSeconds: 1, backoffMaxSeconds: 4 };
    const failing = async () => {
      throw new Error('boom');
    };
    const { m } = await readOne();
    const first = await processMessage({ sql, client, queue: 'trading-actions', message: m, handler: failing, holder: 'worker-a', expectedContractSetDigest: digest, clock: systemClock, policy });
    expect(first.outcome).toBe('RETRY_SCHEDULED');
    if (first.outcome === 'RETRY_SCHEDULED') expect(first.nextVisibleInSeconds).toBe(backoffSeconds(1, policy));
    const [claim] = await sql`select 1 from ops.processed_messages where idempotency_key = ${env.idempotencyKey}`;
    expect(claim).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1300));
    const { m: second } = await readOne();
    expect(second.readCount).toBe(2);
    const r2 = await processMessage({ sql, client, queue: 'trading-actions', message: second, handler: failing, holder: 'worker-a', expectedContractSetDigest: digest, clock: systemClock, policy });
    expect(r2).toEqual({ outcome: 'DEAD_LETTER', reason: 'MAX_ATTEMPTS_EXCEEDED' });
    const [dl] = await sql`select reason, attempts, last_error from ops.dead_letters where idempotency_key = ${env.idempotencyKey}`;
    expect(dl).toMatchObject({ reason: 'MAX_ATTEMPTS_EXCEEDED', attempts: 2, last_error: 'boom' });
  });

  it('a message from a deployable with a different contract set is dead-lettered, never handled', async () => {
    const env = envelope({ contractSetDigest: 'f'.repeat(64) as Sha256Hex });
    await client.send(env);
    const { m } = await readOne();
    let calls = 0;
    const r = await processMessage({ sql, client, queue: 'trading-actions', message: m, handler: async () => void calls++, holder: 'worker-a', expectedContractSetDigest: digest, clock: systemClock });
    expect(r).toEqual({ outcome: 'DEAD_LETTER', reason: 'CONTRACT_DIGEST_MISMATCH' });
    expect(calls).toBe(0);
  });

  it('leases: acquire, heartbeat, expiry recovery through the JS manager', async () => {
    const role = `test-role-${randomUUID()}`;
    const a = new LeaseManager(sql, 'worker-a');
    const b = new LeaseManager(sql, 'worker-b');
    expect(await a.acquire(role, 30)).toBe(true);
    expect(await b.acquire(role, 30)).toBe(false);
    expect(await a.heartbeat(role, 30)).toBe(true);
    await sql`update ops.worker_leases set expires_at = now() - interval '1 second' where role = ${role}`;
    expect(await a.heartbeat(role, 30)).toBe(false);
    expect(await b.acquire(role, 30)).toBe(true);
    expect(await b.release(role)).toBe(true);
  });

  it('default backoff doubles and caps', () => {
    const p = DEFAULT_PROCESSING_POLICY;
    expect([1, 2, 3, 4, 10].map((a) => backoffSeconds(a, p))).toEqual([5, 10, 20, 40, 300]);
  });
});
