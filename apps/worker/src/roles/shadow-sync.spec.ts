import { addMs, fixedClock, fixtures, type Amount, type Instant, type MintAddress, type PositionRiskShadow, type Uuid } from '@sol-agent-trader/contracts';
import type { ShadowSourcePosition } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { MemoryShadowJournal } from '../shadow/journal.js';
import { runShadowSyncCycle, type ShadowExecutor, type ShadowSyncDeps, type ShadowSyncState } from './shadow-sync.js';

const T0 = fixtures.T0 as Instant;
const USDC = fixtures.MINTS.USDC as MintAddress;
const RISK = fixtures.MINTS.RISK as MintAddress;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const pos = (over: Partial<ShadowSourcePosition & { decimals: number }> = {}): ShadowSourcePosition & { decimals: number } => ({ positionId: fixtures.IDS.position as Uuid, assetId: fixtures.IDS.asset as Uuid, mint: RISK, quantity: '1000000000' as Amount, decimals: 9, stop: { model: 'ATR', level: 96 }, unreviewedStop: 97, lots: [{ lotId: fixtures.IDS.lot as Uuid, quantity: '1000000000' as Amount, protectionMode: 'MONITORED_EXIT', providerOrderId: null }], ...over });

class FakeExecutor implements ShadowExecutor {
  synced: PositionRiskShadow[] = [];
  commands: { mint: MintAddress; maxAmount: Amount; shadowSequence: number; reason: string }[] = [];
  regressAt: number | null = null;
  async syncShadow(shadow: PositionRiskShadow) { if (this.regressAt !== null && shadow.sequence <= this.regressAt) return { ok: false, reason: 'SHADOW_REGRESSION' }; this.synced.push(shadow); return { ok: true, sequence: shadow.sequence }; }
  async emergencyMonitor(cmd: { mint: MintAddress; maxAmount: Amount; shadowSequence: number; reason: string }) { this.commands.push(cmd); return { outcome: 'CLOSED' }; }
}

function fake(over: { positions?: (ShadowSourcePosition & { decimals: number })[] | Error; executor?: ShadowExecutor | null; prices?: Record<string, number | null> } = {}) {
  const journal = new MemoryShadowJournal();
  const executor = over.executor === undefined ? new FakeExecutor() : over.executor;
  let n = 0;
  const deps: ShadowSyncDeps = {
    repo: { async positions() { if (over.positions instanceof Error) throw over.positions; return over.positions ?? [pos()]; } },
    journal,
    executor,
    price: async (mint) => (over.prices && mint in over.prices ? over.prices[mint]! : 100),
    settlementMints: [USDC],
    clock: fixedClock(T0),
    logger,
    config: { dbDownAfterFailures: 2 },
    newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-00000000cafe` as Uuid,
  };
  return { deps, journal, executor: executor as FakeExecutor | null };
}

describe('worker shadow-sync role (§15.10A, D22)', () => {
  it('appends a sequenced shadow on change, pushes it to the executor, and stays quiet while the book is unchanged', async () => {
    const f = fake();
    const state: ShadowSyncState = { consecutiveDbFailures: 0 };
    const r1 = await runShadowSyncCycle(f.deps, state);
    expect(r1).toMatchObject({ mode: 'SYNCED', sequence: 1, pushed: 'OK' });
    expect(f.journal.entries).toHaveLength(1);
    expect(f.journal.entries[0]?.decimals).toEqual({ [RISK]: 9 });
    expect(f.executor?.synced.map((s) => s.sequence)).toEqual([1]);
    const r2 = await runShadowSyncCycle(f.deps, state);
    expect(r2).toMatchObject({ mode: 'UNCHANGED', sequence: 1, pushed: 'SKIPPED' });
    expect(f.journal.entries).toHaveLength(1);
    // a tightened stop is a new shadow with the next sequence
    const g = fake({ positions: [pos({ unreviewedStop: 98 })] });
    g.deps.journal = f.journal;
    const r3 = await runShadowSyncCycle(g.deps, state);
    expect(r3).toMatchObject({ mode: 'SYNCED', sequence: 2, pushed: 'OK' });
    // an executor that reports a regression is surfaced, the local journal still holds the truth
    const h = fake({ positions: [pos({ unreviewedStop: 99 })] });
    h.deps.journal = f.journal;
    (h.executor as FakeExecutor).regressAt = 99;
    expect((await runShadowSyncCycle(h.deps, state)).pushed).toBe('REGRESSION');
    expect(f.journal.entries).toHaveLength(3);
    // no executor configured (paper profile): synced locally only
    const paper = fake({ executor: null, positions: [pos({ unreviewedStop: 95 })] });
    paper.deps.journal = f.journal;
    expect((await runShadowSyncCycle(paper.deps, state)).pushed).toBe('NO_EXECUTOR');
  });

  it('a first database failure only warns; from the threshold on, the last shadow and fresh prices drive emergency closes for hit stops only, at the shadow sequence', async () => {
    const ok = fake();
    const state: ShadowSyncState = { consecutiveDbFailures: 0 };
    await runShadowSyncCycle(ok.deps, state);
    const down = fake({ positions: new Error('ECONNREFUSED'), prices: { [RISK]: 96.5 } });
    down.deps.journal = ok.journal;
    const r1 = await runShadowSyncCycle(down.deps, state);
    expect(r1).toMatchObject({ mode: 'DB_ERROR', commandsIssued: 0, error: 'ECONNREFUSED' });
    const r2 = await runShadowSyncCycle(down.deps, state);
    expect(r2).toMatchObject({ mode: 'DB_DOWN', sequence: 1, stopsHit: 1, commandsIssued: 1, unpriced: 0 });
    expect((down.executor as FakeExecutor).commands).toEqual([{ commandId: '00000001-0000-4000-8000-00000000cafe', type: 'EMERGENCY_CLOSE_ASSET', mint: RISK, maxAmount: '1000000000', reason: expect.stringContaining('UNREVIEWED_STOP'), shadowSequence: 1 }]);
    // price above the stop: nothing is closed; no price: reported unpriced, never treated as hit
    const calm = fake({ positions: new Error('ECONNREFUSED'), prices: { [RISK]: 120 } });
    calm.deps.journal = ok.journal;
    expect(await runShadowSyncCycle(calm.deps, state)).toMatchObject({ mode: 'DB_DOWN', stopsHit: 0, commandsIssued: 0 });
    const blind = fake({ positions: new Error('ECONNREFUSED'), prices: { [RISK]: null } });
    blind.deps.journal = ok.journal;
    expect(await runShadowSyncCycle(blind.deps, state)).toMatchObject({ mode: 'DB_DOWN', stopsHit: 0, unpriced: 1 });
    // the database returns: failures reset and syncing resumes
    const back = fake({ positions: [pos({ unreviewedStop: 97 })] });
    back.deps.journal = ok.journal;
    expect((await runShadowSyncCycle(back.deps, state)).mode).toBe('UNCHANGED');
    expect(state.consecutiveDbFailures).toBe(0);
  });

  it('with the database down, no executor and a hit stop, the outage is reported loudly and nothing else happens; with no shadow at all the same', async () => {
    const seeded = fake({ executor: null });
    const state: ShadowSyncState = { consecutiveDbFailures: 5 };
    await runShadowSyncCycle(seeded.deps, { consecutiveDbFailures: 0 });
    const down = fake({ positions: new Error('down'), executor: null, prices: { [RISK]: 1 } });
    down.deps.journal = seeded.journal;
    expect(await runShadowSyncCycle(down.deps, state)).toMatchObject({ mode: 'DB_DOWN', stopsHit: 1, commandsIssued: 0 });
    const empty = fake({ positions: new Error('down'), executor: null });
    expect(await runShadowSyncCycle(empty.deps, state)).toMatchObject({ mode: 'DB_DOWN', sequence: null, stopsHit: 0 });
    void addMs;
  });
});
