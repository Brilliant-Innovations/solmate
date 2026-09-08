import { fixtures, type Instant, type Sequence, type Sha256Hex } from '@sol-agent-trader/contracts';
import type { AuditCheckpoint, AuditVerificationInput } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { AUDIT_CHAIN_ALERT, runAuditCheckpointCycle, type AuditCheckpointDeps } from './audit-checkpoint.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const clock = { now: () => fixtures.T0 as Instant };
const cp: AuditCheckpoint = { sequence: 12 as Sequence, hash: 'ab'.repeat(32) as Sha256Hex, checkpointedAt: fixtures.T0 as Instant };

describe('worker audit-checkpoint role (§20.25, ADR-0009 P2)', () => {
  it('replicates the head and verifies the ledger against the external copy', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { return cp; }, async verify() { return { ok: true, checkpoint: cp }; } }, logger, clock };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: cp, verified: true, reason: null });
  });

  it('a broken chain refuses to checkpoint and is reported, not skipped', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { throw new Error('audit chain broken at sequence 5; refusing to checkpoint'); }, async verify() { return { ok: true, checkpoint: cp }; } }, logger, clock };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: null, verified: false, reason: 'audit chain broken at sequence 5; refusing to checkpoint' });
  });

  it('a replica that disagrees with the ledger is reported with its reason; an empty ledger is fine', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { return cp; }, async verify() { return { ok: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT', detail: 'sequence 12' }; } }, logger, clock };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: cp, verified: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT' });
    const empty: AuditCheckpointDeps = { repo: { async checkpoint() { return null; }, async verify() { throw new Error('not called'); } }, logger, clock };
    expect(await runAuditCheckpointCycle(empty)).toEqual({ checkpoint: null, verified: true, reason: null });
  });

  it('persists every verification and raises one CRITICAL alert while unverified, resolving it once a cycle passes (§20.25)', async () => {
    const records: AuditVerificationInput[] = [];
    const raised: string[] = [];
    const resolved: string[] = [];
    let open = false;
    let verdict: Awaited<ReturnType<AuditCheckpointDeps['repo']['verify']>> = { ok: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT', detail: 'sequence 12' };
    const deps: AuditCheckpointDeps = {
      repo: {
        async checkpoint() { return cp; },
        async verify() { return verdict; },
        async record(v) { records.push(v); },
        async openAlertExists() { return open; },
        async raise(n) { raised.push(n.alertClass); open = true; },
        async resolve(c) { resolved.push(c); open = false; },
      },
      logger,
      replica: 'file:checkpoints.jsonl',
      clock,
    };
    await runAuditCheckpointCycle(deps);
    await runAuditCheckpointCycle(deps);
    expect(raised).toEqual([AUDIT_CHAIN_ALERT]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ ok: false, headSequence: 12, checkpoint: null, replica: 'file:checkpoints.jsonl', reason: 'HASH_MISMATCH_AT_CHECKPOINT', detail: 'sequence 12' });
    verdict = { ok: true, checkpoint: cp };
    await runAuditCheckpointCycle(deps);
    expect(resolved).toEqual([AUDIT_CHAIN_ALERT]);
    expect(records[2]).toEqual({ ok: true, headSequence: 12, checkpoint: { sequence: 12, hash: cp.hash }, replica: 'file:checkpoints.jsonl', reason: null, detail: null });
    // A broken chain records CHAIN_BROKEN with the message as detail and still raises.
    open = false;
    const broken: AuditCheckpointDeps = { ...deps, repo: { ...deps.repo, async checkpoint() { throw new Error('audit chain broken at sequence 5; refusing to checkpoint'); } } };
    await runAuditCheckpointCycle(broken);
    expect(records[3]).toEqual({ ok: false, headSequence: null, checkpoint: null, replica: 'file:checkpoints.jsonl', reason: 'CHAIN_BROKEN', detail: 'audit chain broken at sequence 5; refusing to checkpoint' });
    expect(raised).toEqual([AUDIT_CHAIN_ALERT, AUDIT_CHAIN_ALERT]);
  });
});
