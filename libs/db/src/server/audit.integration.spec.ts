import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instant } from '@sol-agent-trader/contracts';
import { checkpointAuditChain, FileCheckpointReplicator, verifyAgainstExternalCheckpoint, verifyAuditChain, writeAuditEvent } from './audit.js';
import { createRuntimeSession, persistRuntimeTransition } from './runtime-session-repo.js';
import { createSql, databaseUrlFromEnv, type Sql } from './sql.js';

const url = databaseUrlFromEnv();

describe.skipIf(!url)('audit ledger and runtime-session persistence (§6.22, §20.25, P0 "mode changes audited")', () => {
  let sql: Sql;
  let dir: string;

  beforeAll(async () => {
    sql = createSql({ url: url as string, applicationName: 'db-audit-test' });
    dir = await mkdtemp(join(tmpdir(), 'solmate-audit-'));
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  });

  it('appends chained events and verifies the chain', async () => {
    const a = await writeAuditEvent(sql, { actor: 'OPERATOR', actorRef: 'op-1', actionClass: 'TEST', entity: { type: 't', id: '1' } });
    const b = await writeAuditEvent(sql, { actor: 'WORKER', actorRef: 'w-1', actionClass: 'TEST', entity: { type: 't', id: '2' } });
    expect(b.sequence).toBeGreaterThan(a.sequence);
    expect(b.previousHash).toBe(a.hash);
    const v = await verifyAuditChain(sql);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThanOrEqual(2);
  });

  it('checkpoints the head to an external file and verifies the ledger against it', async () => {
    const replicator = new FileCheckpointReplicator(join(dir, 'checkpoints.jsonl'));
    const cp = await checkpointAuditChain(sql, [replicator]);
    expect(cp).not.toBeNull();
    const [stored] = await sql`select replicated_to from audit.checkpoints where sequence = ${cp?.sequence ?? 0}`;
    expect(stored?.replicated_to).toEqual([replicator.label]);
    const check = await verifyAgainstExternalCheckpoint(sql, replicator);
    expect(check.ok).toBe(true);
  });

  it('detects a ledger rewrite even when the attacker also rewrites audit.checkpoints', async () => {
    const replicator = new FileCheckpointReplicator(join(dir, 'checkpoints-2.jsonl'));
    const head = await writeAuditEvent(sql, { actor: 'OPERATOR', actorRef: 'op-1', actionClass: 'TEST', entity: { type: 't', id: '3' } });
    await checkpointAuditChain(sql, [replicator]);
    // Attacker with DB superuser: disable the guard, rewrite the head row, fix up audit.checkpoints.
    await sql`alter table audit.events disable trigger audit_events_immutable`;
    try {
      await sql`update audit.events set action_class = 'TAMPERED' where sequence = ${head.sequence}`;
      const chain = await verifyAuditChain(sql);
      expect(chain.ok).toBe(false);
      const check = await verifyAgainstExternalCheckpoint(sql, replicator);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe('CHAIN_BROKEN');
      await expect(checkpointAuditChain(sql, [replicator])).rejects.toThrow(/audit chain broken/);
      await sql`update audit.events set action_class = 'TEST' where sequence = ${head.sequence}`;
    } finally {
      await sql`alter table audit.events enable trigger audit_events_immutable`;
    }
    expect((await verifyAuditChain(sql)).ok).toBe(true);
  });

  it('persists a runtime transition and its audit row atomically', async () => {
    const id = await createRuntimeSession(sql, { accountId: null, profile: 'P0', attended: true });
    const at = new Date().toISOString() as Instant;
    const audit = await persistRuntimeTransition(sql, {
      sessionId: id,
      from: 'OFF',
      to: 'STARTING',
      at,
      actor: 'OPERATOR',
      actorRef: 'op-1',
      reason: 'session start',
      after: {
        activityState: 'STARTING',
        capitalAuthority: 'PAPER',
        paused: { active: false, reason: null, since: null, by: null },
        exposureAtLastTransition: { managedCount: 0, offlineProtectedCount: 0, unmanagedCount: 0, unmanagedUsd: null },
      },
    });
    const [session] = await sql`select activity_state, capital_authority, actual_start_at, jsonb_array_length(transitions) as n from ops.runtime_sessions where id = ${id}`;
    expect(session).toMatchObject({ activity_state: 'STARTING', capital_authority: 'PAPER', n: 1 });
    expect(session?.actual_start_at).not.toBeNull();
    const [row] = await sql`select action_class, entity, after_summary, live_impacting from audit.events where sequence = ${audit.sequence}`;
    expect(row).toMatchObject({ action_class: 'RUNTIME_TRANSITION', entity: { type: 'runtime_session', id }, live_impacting: false });
    expect(row?.after_summary).toMatchObject({ activityState: 'STARTING', capitalAuthority: 'PAPER' });
  });

  it('a transition for an unknown session persists nothing, including no audit row', async () => {
    const before = (await verifyAuditChain(sql)).checked;
    await expect(
      persistRuntimeTransition(sql, {
        sessionId: '00000000-0000-4000-8000-000000000000',
        from: 'OFF', to: 'STARTING', at: new Date().toISOString() as Instant, actor: 'OPERATOR', actorRef: 'op-1', reason: null,
        after: { activityState: 'STARTING', capitalAuthority: 'PAPER', paused: { active: false, reason: null, since: null, by: null }, exposureAtLastTransition: { managedCount: 0, offlineProtectedCount: 0, unmanagedCount: 0, unmanagedUsd: null } },
      }),
    ).rejects.toThrow(/not found/);
    expect((await verifyAuditChain(sql)).checked).toBe(before);
  });
});
