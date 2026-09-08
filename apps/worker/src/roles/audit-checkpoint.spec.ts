import { fixtures, type Instant, type Sequence, type Sha256Hex } from '@sol-agent-trader/contracts';
import type { AuditCheckpoint } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runAuditCheckpointCycle, type AuditCheckpointDeps } from './audit-checkpoint.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const cp: AuditCheckpoint = { sequence: 12 as Sequence, hash: 'ab'.repeat(32) as Sha256Hex, checkpointedAt: fixtures.T0 as Instant };

describe('worker audit-checkpoint role (§20.25, ADR-0009 P2)', () => {
  it('replicates the head and verifies the ledger against the external copy', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { return cp; }, async verify() { return { ok: true, checkpoint: cp }; } }, logger };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: cp, verified: true, reason: null });
  });

  it('a broken chain refuses to checkpoint and is reported, not skipped', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { throw new Error('audit chain broken at sequence 5; refusing to checkpoint'); }, async verify() { return { ok: true, checkpoint: cp }; } }, logger };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: null, verified: false, reason: 'audit chain broken at sequence 5; refusing to checkpoint' });
  });

  it('a replica that disagrees with the ledger is reported with its reason; an empty ledger is fine', async () => {
    const deps: AuditCheckpointDeps = { repo: { async checkpoint() { return cp; }, async verify() { return { ok: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT', detail: 'sequence 12' }; } }, logger };
    expect(await runAuditCheckpointCycle(deps)).toEqual({ checkpoint: cp, verified: false, reason: 'HASH_MISMATCH_AT_CHECKPOINT' });
    const empty: AuditCheckpointDeps = { repo: { async checkpoint() { return null; }, async verify() { throw new Error('not called'); } }, logger };
    expect(await runAuditCheckpointCycle(empty)).toEqual({ checkpoint: null, verified: true, reason: null });
  });
});
