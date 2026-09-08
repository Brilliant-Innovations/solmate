import { fixedClock, fixtures, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { runStartupRecovery, type RecoveryDeps, type RecoveryFacts } from './recovery.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const facts = (over: Partial<RecoveryFacts> = {}): RecoveryFacts => ({ openPositions: 1, openLots: 1, intents: { EXECUTING: 2, AUTHORIZED: 1 }, inFlightAttempts: 1, ...over });

function fake(over: Partial<RecoveryDeps> & { after?: RecoveryFacts } = {}) {
  const calls: string[] = [];
  let n = 0;
  const deps: RecoveryDeps = {
    repo: {
      async facts() { calls.push('facts'); return n++ === 0 ? facts() : (over.after ?? facts({ intents: { EXECUTING: 1 }, inFlightAttempts: 1 })); },
      async expireStaleIntents() { calls.push('expire'); return [IDS.intent as Uuid]; },
      async settleFromAttempts() { calls.push('settle'); return [{ intentId: IDS.message as Uuid, state: 'COMPLETED' as const }]; },
      async failOrphanedExecuting() { calls.push('orphans'); return []; },
    },
    reconcile: async () => { calls.push('reconcile'); return { accounts: 1, clean: 1, mismatch: 0, unavailable: 0, paused: 0 }; },
    account: { id: IDS.account as Uuid },
    clock: fixedClock(T0),
    logger,
    ...over,
  };
  return { deps, calls };
}

describe('worker restart recovery (§21.3)', () => {
  it('loads the book, reconciles chain truth, settles terminal attempts, expires stale authorizations, then resumes', async () => {
    const f = fake();
    const r = await runStartupRecovery(f.deps);
    expect(f.calls).toEqual(['facts', 'reconcile', 'settle', 'expire', 'orphans', 'facts']);
    expect(r).toMatchObject({ reconciliation: { clean: 1, mismatch: 0 }, expiredByLatency: [IDS.intent], settled: [{ intentId: IDS.message, state: 'COMPLETED' }], orphanedExecuting: [], resume: true });
    expect(r.before.intents).toEqual({ EXECUTING: 2, AUTHORIZED: 1 });
    expect(r.after.intents).toEqual({ EXECUTING: 1 });
  });

  it('a reconciliation mismatch still resumes (the reconciliation role has paused entries itself), and no RPC skips the pass', async () => {
    const mismatch = fake({ reconcile: async () => ({ accounts: 1, clean: 0, mismatch: 1, unavailable: 0, paused: 1 }) });
    expect((await runStartupRecovery(mismatch.deps))).toMatchObject({ reconciliation: { mismatch: 1, paused: 1 }, resume: true });
    const noRpc = fake({ reconcile: null });
    const r = await runStartupRecovery(noRpc.deps);
    expect(r.reconciliation).toBe('SKIPPED_NO_RPC');
    expect(r.resume).toBe(true);
    expect(noRpc.calls).not.toContain('reconcile');
  });

  it('a reconciliation pass that throws with open exposure does not resume; with nothing open it does', async () => {
    const withExposure = fake({ reconcile: async () => { throw new Error('rpc down'); } });
    const r1 = await runStartupRecovery(withExposure.deps);
    expect(r1).toMatchObject({ reconciliation: { error: 'rpc down' }, resume: false });
    const flat = fake({ reconcile: async () => { throw new Error('rpc down'); }, after: facts({ openPositions: 0, openLots: 0, intents: {}, inFlightAttempts: 0 }) });
    const r2 = await runStartupRecovery(flat.deps);
    expect(r2.resume).toBe(true);
  });
});
